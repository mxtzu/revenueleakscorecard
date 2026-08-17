"""Social profile enrichment.

Profile URLs are collected from sources and from links published on the
business's own website, then normalised to canonical profile URLs.

We deliberately do **not** fetch the social networks themselves: their robots
files and terms disallow automated access, and profile content is out of scope
for B2B qualification. Presence and platform mix is all we score.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from ..models import Lead
from ..utils.normalization import normalize_url

PLATFORM_FIELDS = {
    "facebook": "facebook_url",
    "instagram": "instagram_url",
    "linkedin": "linkedin_url",
    "tiktok": "tiktok_url",
    "youtube": "youtube_url",
}

HOST_TO_PLATFORM = {
    "facebook.com": "facebook",
    "fb.com": "facebook",
    "instagram.com": "instagram",
    "linkedin.com": "linkedin",
    "tiktok.com": "tiktok",
    "youtube.com": "youtube",
    "youtu.be": "youtube",
}

INVALID_PATH_TOKENS = (
    "sharer",
    "share.php",
    "intent/",
    "plugins/",
    "dialog/",
    "login",
    "signup",
    "policies",
    "help",
    "about/",
    "legal",
)


@dataclass
class SocialPresence:
    profiles: dict[str, str] = field(default_factory=dict)
    platform_count: int = 0
    has_video_platform: bool = False
    has_visual_platform: bool = False
    presence_score: int = 0
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, object]:
        return {
            "profiles": self.profiles,
            "platform_count": self.platform_count,
            "has_video_platform": self.has_video_platform,
            "has_visual_platform": self.has_visual_platform,
            "presence_score": self.presence_score,
            "notes": self.notes,
        }


def canonical_profile_url(url: str | None) -> tuple[str, str] | None:
    """Return ``(platform, canonical_url)`` for a social profile link."""
    normalized = normalize_url(url)
    if not normalized:
        return None
    parts = urlsplit(normalized)
    host = (parts.hostname or "").lower().removeprefix("www.")
    platform = None
    for known_host, known_platform in HOST_TO_PLATFORM.items():
        if host == known_host or host.endswith("." + known_host):
            platform = known_platform
            break
    if not platform:
        return None
    path = parts.path.strip("/")
    if not path:
        return None
    lowered = normalized.lower()
    if any(token in lowered for token in INVALID_PATH_TOKENS):
        return None
    # Trim tracking/sub-paths to the profile root where the platform allows it.
    segments = [s for s in path.split("/") if s]
    if platform in {"facebook", "instagram", "tiktok"}:
        if platform == "tiktok" and not segments[0].startswith("@"):
            segments[0] = f"@{segments[0]}"
        path = segments[0]
    elif platform == "linkedin":
        if len(segments) >= 2 and segments[0] in {"company", "in", "school"}:
            path = "/".join(segments[:2])
        else:
            path = segments[0]
    elif platform == "youtube":
        if segments[0] in {"channel", "c", "user"} and len(segments) >= 2:
            path = "/".join(segments[:2])
        else:
            path = segments[0]
    canonical = f"https://{host}/{path}"
    if not re.match(r"^https://[a-z0-9.-]+/[^/]+(/[^/]+)?$", canonical):
        return None
    return (platform, canonical)


def enrich_social(lead: Lead) -> SocialPresence:
    """Normalise every known profile link onto the lead and score presence."""
    presence = SocialPresence()
    candidates: list[str] = []

    for field_name in PLATFORM_FIELDS.values():
        value = getattr(lead, field_name, None)
        if value:
            candidates.append(value)
    if lead.website_analysis:
        candidates.extend(lead.website_analysis.social_links.values())

    for candidate in candidates:
        result = canonical_profile_url(candidate)
        if not result:
            continue
        platform, canonical = result
        presence.profiles.setdefault(platform, canonical)

    for platform, canonical in presence.profiles.items():
        field_name = PLATFORM_FIELDS[platform]
        if getattr(lead, field_name, None) != canonical:
            setattr(lead, field_name, canonical)
            lead.field_sources.setdefault(field_name, "company_website")

    # Clear links that failed validation so exports never carry junk.
    for platform, field_name in PLATFORM_FIELDS.items():
        if platform not in presence.profiles and getattr(lead, field_name, None):
            if canonical_profile_url(getattr(lead, field_name)) is None:
                setattr(lead, field_name, None)

    presence.platform_count = len(presence.profiles)
    presence.has_video_platform = any(p in presence.profiles for p in ("youtube", "tiktok"))
    presence.has_visual_platform = any(p in presence.profiles for p in ("instagram", "tiktok", "youtube"))
    presence.presence_score = min(
        100,
        presence.platform_count * 22
        + (12 if presence.has_visual_platform else 0)
        + (8 if presence.has_video_platform else 0),
    )
    if presence.platform_count == 0:
        presence.notes.append("No public social profiles linked from the website or listings")
    return presence
