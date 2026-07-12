"""Discord resolution ladder + LIVE verification.

Hard rule: NEVER fabricate an invite. We only ever return an invite code that
was (a) literally extracted from a public source we fetched, and (b) confirmed
live by the public Discord invite endpoint. If neither holds, we return None
and the caller DROPS the lead. We never construct discord.gg/<studioname>,
never guess codes, never infer.

Ladder (stop at first VERIFIED hit):
  1. Roblox game description
  2. Roblox group description / "About"
  3. Roblox group public social links (only if reachable unauthenticated)
  4. Operator/owner Roblox profile description
  5. Linked public X/YouTube/TikTok/Linktree found in 1-4 -> follow, extract invite
  6. Studio public website, if linked
Records which rung produced the hit in `verification status`.
"""
from __future__ import annotations
import re
import logging

import httpx
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type

import config

log = logging.getLogger("discord")

# Matches discord.gg/<code> and discord.com/invite/<code>. Code is the exact
# public string; we never modify or synthesize it.
INVITE_RE = re.compile(
    r"(?:discord\.gg|discord(?:app)?\.com/invite)/([A-Za-z0-9\-]{2,32})",
    re.IGNORECASE)

# Public social links we may follow (rung 5). Extraction only; no auth.
SOCIAL_RE = re.compile(
    r"https?://(?:www\.)?(?:twitter\.com|x\.com|youtube\.com|youtu\.be|"
    r"tiktok\.com|linktr\.ee|beacons\.ai|carrd\.co)/[^\s\"'<>]+",
    re.IGNORECASE)
URL_RE = re.compile(r"https?://[^\s\"'<>]+", re.IGNORECASE)

_RETRYABLE = (httpx.TransportError, httpx.HTTPStatusError)


def extract_invite_codes(text: str | None) -> list[str]:
    if not text:
        return []
    seen, out = set(), []
    for code in INVITE_RE.findall(text):
        c = code.strip().strip("/")
        if c.lower() in {"invite", "terms", "privacy"}:
            continue
        if c not in seen:
            seen.add(c)
            out.append(c)
    return out


class DiscordResolver:
    def __init__(self, roblox_client):
        self.rbx = roblox_client
        self._web = httpx.AsyncClient(
            timeout=config.REQUEST_TIMEOUT,
            headers={"User-Agent": config.USER_AGENT},
            follow_redirects=True,
        )
        self._cache: dict[str, dict | None] = {}

    async def close(self):
        await self._web.aclose()

    # ---- live verification ----------------------------------------------
    @retry(reraise=True, stop=stop_after_attempt(config.MAX_RETRIES),
           wait=wait_exponential(multiplier=config.BACKOFF_BASE, max=32),
           retry=retry_if_exception_type(httpx.TransportError))
    async def verify(self, code: str) -> dict | None:
        """Resolve via https://discord.com/api/v10/invites/{code}?with_counts=true.
        Returns guild metadata if live, else None (expired/invalid -> drop)."""
        if code in self._cache:
            return self._cache[code]
        url = f"https://discord.com/api/v10/invites/{code}"
        r = await self._web.get(url, params={"with_counts": "true"})
        if r.status_code == 429:
            r.raise_for_status()  # let backoff handle it (but not retryable type)
        if r.status_code == 404:
            self._cache[code] = None
            return None
        if r.status_code != 200:
            self._cache[code] = None
            return None
        data = r.json()
        if data.get("code") != code and "guild" not in data:
            self._cache[code] = None
            return None
        result = {
            "code": code,
            "url": f"https://discord.gg/{code}",
            "guild_name": (data.get("guild") or {}).get("name"),
            "approx_members": data.get("approximate_member_count"),
            "approx_online": data.get("approximate_presence_count"),
        }
        self._cache[code] = result
        return result

    async def _first_verified(self, text: str | None, rung: str, src: str):
        for code in extract_invite_codes(text):
            info = await self.verify(code)
            if info:
                info["rung"] = rung
                info["source_url"] = src
                return info
        return None

    async def _fetch(self, url: str) -> str | None:
        try:
            r = await self._web.get(url)
            if r.status_code == 200 and "text" in r.headers.get("content-type", ""):
                return r.text
        except _RETRYABLE:
            return None
        return None

    async def resolve(self, *, game_desc: str, game_url: str,
                      group: dict | None, group_url: str | None,
                      owner: dict | None, owner_url: str | None) -> dict | None:
        """Walk the ladder; return the first VERIFIED invite dict or None."""
        # Rung 1: game description
        hit = await self._first_verified(game_desc, "rung1:game-description", game_url)
        if hit:
            return hit

        # Rung 2/3: group description + about + public social links
        if group:
            gdesc = (group.get("description") or "")
            hit = await self._first_verified(gdesc, "rung2:group-description",
                                             group_url or game_url)
            if hit:
                return hit

        # Rung 4: owner profile description
        if owner:
            odesc = owner.get("description") or ""
            hit = await self._first_verified(odesc, "rung4:owner-profile",
                                             owner_url or game_url)
            if hit:
                return hit

        # Rung 5: follow public socials/linktrees found in any text above
        blob = " ".join(filter(None, [
            game_desc,
            (group or {}).get("description"),
            (owner or {}).get("description"),
        ]))
        for social in SOCIAL_RE.findall(blob):
            page = await self._fetch(social)
            hit = await self._first_verified(page, f"rung5:social ({social})", social)
            if hit:
                return hit

        # Rung 6: studio website (first non-social external URL in blob)
        for url in URL_RE.findall(blob):
            if SOCIAL_RE.match(url) or "roblox.com" in url or "discord" in url.lower():
                continue
            page = await self._fetch(url)
            hit = await self._first_verified(page, f"rung6:website ({url})", url)
            if hit:
                return hit

        return None
