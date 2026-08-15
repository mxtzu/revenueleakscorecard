"""OpenStreetMap / Overpass API adapter.

The only discovery source that needs no API key, which makes it the default
when nothing is configured. Data is ODbL-licensed and must be attributed to
"© OpenStreetMap contributors".

Politeness: the Overpass usage policy asks for a real User-Agent, modest query
rates and cached results - all enforced here (host rate is pinned to one
request every two seconds and responses are cached for the run TTL).
"""

from __future__ import annotations

import re
from typing import Any, AsyncIterator
from urllib.parse import urlencode, urlsplit

from ..models import SourceRecord
from ..utils.geo import MAX_SEARCH_RADIUS_KM, within_radius
from ..utils.http import HttpError
from ..utils.normalization import clean_text
from .base import BaseSource, SearchQuery, SourceContext

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OVERPASS_HOST = "overpass-api.de"
OVERPASS_TIMEOUT = 60          # seconds, declared inside the query itself
MAX_ELEMENTS = 400             # cap on returned elements
MAX_NAME_CLAUSES = 6           # cap on name-regex clauses per query
NAME_REGEX_MAX_RADIUS_KM = 25  # beyond this, name regexes time the query out

# Statuses meaning "we refused your request", not "we refused your query".
# Re-sending a cheaper query changes nothing.
REQUEST_REJECTED_STATUSES = {401, 403, 406, 429}

# Words too common in place names to use as a name regex: matching them across
# a whole city returns thousands of irrelevant elements and Overpass rejects
# the query as too expensive.
GENERIC_NAME_WORDS = {
    "flat", "flats", "house", "home", "homes", "building", "buildings", "centre",
    "center", "court", "lodge", "manor", "farm", "hall", "park", "green", "grove",
    "close", "road", "street", "lane", "avenue", "drive", "view", "hill", "wood",
    "north", "south", "east", "west", "upper", "lower", "great", "little", "old",
    "newer", "emergency", "commercial", "industrial", "local", "quality", "best",
    "first", "national", "international", "british", "english", "royal", "city",
    "town", "village", "works", "yard", "unit", "units", "shop", "store", "group",
    "services", "service", "company", "limited", "solutions", "systems", "design",
    "designs", "installation", "installations", "repair", "repairs", "specialist",
    "specialists", "treatment", "treatments", "consultation", "packages", "package",
    "installer", "installers", "provider", "providers", "practice", "surgery",
}

_TAG_FILTER_RE = re.compile(r'\["([a-zA-Z:_]+)"\s*=\s*"([^"]+)"\]')

SOCIAL_TAGS = {
    "contact:facebook": "facebook_url",
    "facebook": "facebook_url",
    "contact:instagram": "instagram_url",
    "instagram": "instagram_url",
    "contact:linkedin": "linkedin_url",
    "contact:tiktok": "tiktok_url",
    "contact:youtube": "youtube_url",
}


class OpenStreetMapSource(BaseSource):
    name = "openstreetmap"
    kind = "discovery"
    description = "OpenStreetMap business POIs via the Overpass API (no API key required)"
    attribution = "© OpenStreetMap contributors (ODbL)"
    requires_credentials = ()
    default_rate_per_second = 0.5

    async def search(self, query: SearchQuery, ctx: SourceContext) -> AsyncIterator[SourceRecord]:
        location = query.location
        if not location.has_coordinates:
            self.logger.info(
                "OpenStreetMap search needs coordinates; skipping",
                extra={"location": location.raw},
            )
            return

        # Rate-limit whichever endpoint is configured, not just the default host.
        ctx.client.limiter.set_host_rate(self._endpoint_host(), self.default_rate_per_second or 0.5)
        self.logger.debug("Querying Overpass", extra={"endpoint": self._endpoint()})

        radius_m = int(min(MAX_SEARCH_RADIUS_KM * 1000, max(1_000, query.radius_km * 1000)))
        accepted_tags = self._accepted_tags(query)

        payload, status = await self._run_query(self._build_query(query, radius_m), location, ctx)
        if payload is None and status not in REQUEST_REJECTED_STATUSES:
            # Overpass refuses queries it predicts will be too expensive. Retry
            # once with tag filters only - narrower, but far cheaper than the
            # name-regex clauses. Pointless when the request itself was
            # rejected: the cheaper query would be refused identically.
            self.logger.info(
                "Retrying Overpass with tag filters only", extra={"location": location.label}
            )
            payload, _ = await self._run_query(
                self._build_query(query, radius_m, tags_only=True), location, ctx
            )
        if payload is None:
            return

        elements = (payload or {}).get("elements") or []
        emitted = 0
        seen: set[str] = set()
        # Why elements were dropped - otherwise "found=0" cannot be told apart
        # from "the API returned nothing".
        skipped = {"unnamed": 0, "outside_radius": 0, "wrong_niche": 0, "duplicate": 0}
        for element in elements:
            if emitted >= query.limit:
                break
            record = self._to_record(element, query, accepted_tags, skipped)
            if record is None:
                continue
            key = record.source_record_id or record.data.get("company_name", "")
            if key in seen:
                skipped["duplicate"] += 1
                continue
            seen.add(key)
            emitted += 1
            yield record

        log = self.logger.info if elements else self.logger.warning
        log(
            "Overpass returned %d element(s); kept %d" % (len(elements), emitted),
            extra={
                "location": location.label, "niche": query.niche.key,
                "elements": len(elements), "kept": emitted, **skipped,
                "hint": (
                    "OpenStreetMap has no matching POIs here - coverage of trades is patchy. "
                    "Widen --radius, or use Google Places for real coverage."
                ) if not elements else "",
            },
        )

    # ------------------------------------------------------------------
    def _endpoint(self) -> str:
        return getattr(self.settings, "overpass_url", None) or OVERPASS_URL

    def _endpoint_host(self) -> str:
        return urlsplit(self._endpoint()).hostname or OVERPASS_HOST

    async def _run_query(
        self, overpass_query: str, location: Any, ctx: SourceContext
    ) -> tuple[Any, int | None]:
        """POST one Overpass query.

        Returns ``(payload, None)`` on success and ``(None, status)`` on
        failure - the status lets the caller tell a refused *request* from a
        refused *query*.
        """
        try:
            payload = await ctx.client.post_json(
                self._endpoint(),
                # Canonical form: urlencoded "data=<query>" as a raw string body,
                # so no form-encoding layer can reinterpret it.
                data=urlencode({"data": overpass_query}),
                headers={"Content-Type": "application/x-www-form-urlencoded; charset=utf-8"},
                check_robots=False,  # documented public API endpoint
                cache_ttl=self.settings.cache_ttl_seconds,
                timeout=OVERPASS_TIMEOUT + 30,
                label="overpass",
            )
            # Overpass reports runtime failures - query timeout, out of memory -
            # as HTTP 200 with an empty element list and a "remark". Without
            # this check a timed-out query is indistinguishable from "no
            # businesses here", which is a much more damaging lie.
            remark = (payload or {}).get("remark")
            if remark:
                ctx.record_error(
                    stage="discovery", source=self.name, target=str(location.label),
                    error=str(remark), error_type="overpass_runtime_error",
                )
                self.logger.warning(
                    "Overpass accepted the query but could not complete it: %s" % remark,
                    extra={"endpoint": self._endpoint(), "location": location.label},
                )
                # HTTP was fine, so the caller is free to retry something cheaper.
                return (None, 200)
            return (payload, None)
        except HttpError as exc:
            ctx.record_error(stage="discovery", source=self.name, target=str(location.label),
                             error=exc, error_type=exc.kind)
            if exc.status in (403, 406):
                # Overpass fronts its API with Apache; a rejected User-Agent is
                # refused here with no useful explanation. Say what to do.
                self.logger.warning(
                    "Overpass rejected the request itself (not the query). This is almost always "
                    "the User-Agent: set a short USER_AGENT in .env (e.g. 'MyTool/1.0 "
                    "(you@example.co.uk)'), or point OVERPASS_URL at a mirror such as "
                    "https://overpass.kumi.systems/api/interpreter",
                    extra={"status": exc.status, "user_agent": ctx.client.user_agent,
                           "endpoint": self._endpoint()},
                )
            else:
                self.logger.warning(
                    "Overpass query failed",
                    extra={"endpoint": self._endpoint(), "location": location.label,
                           "error": str(exc), "query": overpass_query[:200]},
                )
            return (None, exc.status)

    def _build_query(self, query: SearchQuery, radius_m: int, *, tags_only: bool = False) -> str:
        """Build the Overpass QL union.

        ``out`` parameter order is fixed by the grammar: verbosity, then
        geometry, then sort order, then limit - ``out tags center 400``.
        """
        lat, lon = query.location.latitude, query.location.longitude
        around = f"(around:{radius_m},{lat},{lon})"
        clauses: list[str] = []

        for raw_filter in query.niche.osm_filters:
            clause = raw_filter.strip().rstrip(";")
            if not clause:
                continue
            clauses.append(f"{clause}{around};")

        # A name regex is evaluated against every named element in the search
        # area, so its cost grows with the radius. Past a threshold it reliably
        # blows the query timeout and Overpass returns nothing at all - worse
        # than the extra recall it buys. Tag filters stay cheap at any radius.
        wide_area = radius_m > NAME_REGEX_MAX_RADIUS_KM * 1000
        if not tags_only and not wide_area:
            for keyword in self._name_keywords(query.niche):
                clauses.append(f'nwr["name"~"{keyword}",i]{around};')

        if not clauses:
            clauses.append(f'nwr["shop"]{around};')

        body = "\n  ".join(clauses)
        return f"[out:json][timeout:{OVERPASS_TIMEOUT}];\n(\n  {body}\n);\nout tags center {MAX_ELEMENTS};"

    def _name_keywords(self, niche: Any) -> list[str]:
        """Distinctive words to match against POI names.

        A name regex runs over every named element in the radius, so a generic
        word ("flat", "new", "home") matches thousands of unrelated features and
        Overpass refuses the query as too expensive. Curated
        ``osm_name_keywords`` in the niche config are used when present;
        otherwise words are derived conservatively and generic ones dropped.
        """
        curated = [str(k).lower() for k in getattr(niche, "osm_name_keywords", [])]
        if curated:
            candidates = curated
        else:
            candidates = []
            for term in list(niche.search_terms)[:6] + list(niche.service_keywords)[:6]:
                for word in str(term).lower().split():
                    if len(word) >= 5 and word not in GENERIC_NAME_WORDS:
                        candidates.append(word)

        seen: dict[str, None] = {}
        for keyword in candidates:
            cleaned = re.sub(r"[^a-z0-9]", "", keyword.lower())
            if len(cleaned) >= 4 and cleaned not in GENERIC_NAME_WORDS:
                seen.setdefault(cleaned, None)
        return list(seen)[:MAX_NAME_CLAUSES]

    def _accepted_tags(self, query: SearchQuery) -> set[tuple[str, str]]:
        accepted: set[tuple[str, str]] = set()
        for raw_filter in query.niche.osm_filters:
            for key, value in _TAG_FILTER_RE.findall(raw_filter):
                accepted.add((key, value.lower()))
        return accepted

    def _to_record(
        self,
        element: dict[str, Any],
        query: SearchQuery,
        accepted_tags: set[tuple[str, str]],
        skipped: dict[str, int] | None = None,
    ) -> SourceRecord | None:
        counts = skipped if skipped is not None else {}
        tags = element.get("tags") or {}
        name = clean_text(tags.get("name") or tags.get("brand") or tags.get("operator") or "")
        if not name:
            counts["unnamed"] = counts.get("unnamed", 0) + 1
            return None

        center = element.get("center") or {}
        latitude = element.get("lat") if element.get("lat") is not None else center.get("lat")
        longitude = element.get("lon") if element.get("lon") is not None else center.get("lon")
        if not within_radius(query.location, latitude, longitude):
            counts["outside_radius"] = counts.get("outside_radius", 0) + 1
            return None

        if not self._is_relevant(name, tags, query, accepted_tags):
            counts["wrong_niche"] = counts.get("wrong_niche", 0) + 1
            return None

        street = clean_text(tags.get("addr:street") or "")
        house = clean_text(tags.get("addr:housenumber") or "")
        city = clean_text(tags.get("addr:city") or tags.get("addr:town") or "")
        postcode = clean_text(tags.get("addr:postcode") or "")
        address_parts = [p for p in [" ".join(x for x in (house, street) if x), city, postcode] if p]

        data: dict[str, Any] = {
            "company_name": name,
            "website": tags.get("website") or tags.get("contact:website") or tags.get("url"),
            "business_phone": tags.get("phone") or tags.get("contact:phone") or tags.get("contact:mobile"),
            "business_email": tags.get("email") or tags.get("contact:email"),
            "address": ", ".join(address_parts) or None,
            "city": city or None,
            "postcode": postcode or None,
            "country": query.country,
            "latitude": latitude,
            "longitude": longitude,
            "opening_hours": [tags["opening_hours"]] if tags.get("opening_hours") else [],
            "google_category": tags.get("amenity") or tags.get("shop") or tags.get("craft")
            or tags.get("healthcare") or tags.get("office"),
            "description": tags.get("description"),
        }
        for tag_key, field_name in SOCIAL_TAGS.items():
            if tags.get(tag_key) and not data.get(field_name):
                data[field_name] = tags[tag_key]

        element_id = f"{element.get('type', 'node')}/{element.get('id')}"
        return self.make_record(
            data,
            source_url=f"https://www.openstreetmap.org/{element_id}",
            source_record_id=element_id,
            raw={"osm": element},
        )

    def _is_relevant(
        self, name: str, tags: dict[str, Any], query: SearchQuery, accepted_tags: set[tuple[str, str]]
    ) -> bool:
        for key, value in accepted_tags:
            if str(tags.get(key, "")).lower() == value:
                return True
        haystack = " ".join(
            [name.lower()]
            + [str(tags.get(k, "")).lower() for k in ("description", "shop", "craft", "amenity", "office", "healthcare")]
        )
        for keyword in query.niche.service_keywords + [t.lower() for t in query.niche.search_terms]:
            if keyword and keyword in haystack:
                return True
        for keyword in self._name_keywords(query.niche):
            if keyword in haystack:
                return True
        return False
