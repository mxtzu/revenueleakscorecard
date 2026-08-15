"""Deduplication.

Two passes:

1. **Blocking keys** (exact): Google Place ID, domain, phone, address+postcode,
   normalized-name+locality. Anything sharing a key is the same business.
2. **Fuzzy names**: within a locality bucket, names above the similarity
   threshold are merged when a second signal corroborates them (shared
   locality, phone, domain or address).

Merging keeps full source provenance - a lead carries the list of every source
that contributed to it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Sequence

from ..models import Lead
from .logging import get_logger
from .normalization import (
    address_key,
    company_name_similarity,
    normalize_company_name,
    postcode_outward,
    root_domain,
)

logger = get_logger("dedupe")

# Lower number == more trusted for field-level conflicts.
DEFAULT_SOURCE_PRIORITY: dict[str, int] = {
    "google_places": 10,
    "companies_house": 15,
    "company_website": 20,
    "bing_places": 30,
    "openstreetmap": 40,
    "search": 50,
    "directory": 60,
    "fixture": 70,
}


class UnionFind:
    def __init__(self) -> None:
        self._parent: dict[str, str] = {}

    def add(self, item: str) -> None:
        self._parent.setdefault(item, item)

    def find(self, item: str) -> str:
        self.add(item)
        root = item
        while self._parent[root] != root:
            root = self._parent[root]
        while self._parent[item] != root:  # path compression
            self._parent[item], item = root, self._parent[item]
        return root

    def union(self, a: str, b: str) -> None:
        root_a, root_b = self.find(a), self.find(b)
        if root_a != root_b:
            self._parent[root_b] = root_a

    def groups(self) -> dict[str, list[str]]:
        clusters: dict[str, list[str]] = {}
        for item in self._parent:
            clusters.setdefault(self.find(item), []).append(item)
        return clusters


@dataclass
class DedupeResult:
    leads: list[Lead]
    duplicates_removed: int = 0
    clusters: list[list[str]] = field(default_factory=list)
    merge_reasons: dict[str, list[str]] = field(default_factory=dict)

    @property
    def merged_clusters(self) -> list[list[str]]:
        return [c for c in self.clusters if len(c) > 1]


class Deduplicator:
    """Cluster and merge records that represent the same business."""

    def __init__(
        self,
        *,
        name_threshold: float = 0.88,
        source_priority: dict[str, int] | None = None,
        cross_niche: bool = False,
    ) -> None:
        self.name_threshold = name_threshold
        self.source_priority = source_priority or DEFAULT_SOURCE_PRIORITY
        self.cross_niche = cross_niche

    # ------------------------------------------------------------------ keys
    def blocking_keys(self, lead: Lead) -> list[str]:
        """Exact-match keys. Sharing any one of these means "same business"."""
        keys: list[str] = []
        if lead.google_place_id:
            keys.append(f"place:{lead.google_place_id.strip()}")
        domain = root_domain(lead.domain or lead.website)
        if domain and domain not in _GENERIC_HOSTS:
            keys.append(f"domain:{domain}")
        phone = lead.phone_key
        if phone:
            keys.append(f"phone:{phone}")
        addr = address_key(lead.address, lead.postcode)
        if addr:
            keys.append(f"addr:{addr}")
        name = normalize_company_name(lead.company_name)
        locality = (lead.postcode or "").replace(" ", "") or (lead.city or "").lower()
        if name and locality:
            keys.append(f"name_loc:{name}|{locality.lower()}")
        return keys

    def bucket_key(self, lead: Lead) -> str:
        """Coarse bucket for the fuzzy pass (keeps comparisons O(n) in practice)."""
        outward = postcode_outward(lead.postcode)
        if outward:
            return f"pc:{outward}"
        if lead.city:
            return f"city:{lead.city.strip().lower()}"
        if lead.search_locations:
            return f"search:{lead.search_locations[0].strip().lower()}"
        return "unbucketed"

    # --------------------------------------------------------------- dedupe
    def dedupe(self, leads: Sequence[Lead]) -> DedupeResult:
        if not leads:
            return DedupeResult(leads=[], duplicates_removed=0)

        by_id: dict[str, Lead] = {}
        order: list[str] = []
        for index, lead in enumerate(leads):
            key = f"{index}:{lead.lead_id}"
            by_id[key] = lead
            order.append(key)

        uf = UnionFind()
        for key in order:
            uf.add(key)

        reasons: dict[str, list[str]] = {}

        # Pass 1 - exact blocking keys.
        key_index: dict[str, str] = {}
        for key in order:
            lead = by_id[key]
            for block in self.blocking_keys(lead):
                kind = block.split(":", 1)[0]
                if not self.cross_niche:
                    block = f"{lead.niche}|{block}"
                existing = key_index.get(block)
                if existing is None:
                    key_index[block] = key
                    continue
                # A shared address or name+locality is weaker evidence than a
                # shared place id / domain / phone: two different businesses
                # can sit in one building. Refuse the merge when the records
                # contradict each other on a strong identifier.
                if kind in {"addr", "name_loc"} and self._contradicts(by_id[existing], lead):
                    continue
                uf.union(existing, key)
                reasons.setdefault(uf.find(key), []).append(block.split("|", 1)[-1])

        # Pass 2 - fuzzy names inside a locality bucket.
        buckets: dict[str, list[str]] = {}
        for key in order:
            lead = by_id[key]
            bucket = self.bucket_key(lead)
            if not self.cross_niche:
                bucket = f"{lead.niche}|{bucket}"
            buckets.setdefault(bucket, []).append(key)

        for bucket, members in buckets.items():
            if len(members) < 2 or bucket.endswith("unbucketed"):
                continue
            for i in range(len(members)):
                lead_a = by_id[members[i]]
                for j in range(i + 1, len(members)):
                    lead_b = by_id[members[j]]
                    if uf.find(members[i]) == uf.find(members[j]):
                        continue
                    similarity = company_name_similarity(lead_a.company_name, lead_b.company_name)
                    if similarity < self.name_threshold:
                        continue
                    if not self._corroborated(lead_a, lead_b):
                        continue
                    uf.union(members[i], members[j])
                    reasons.setdefault(uf.find(members[i]), []).append(
                        f"fuzzy_name:{similarity:.2f}"
                    )

        clusters = uf.groups()
        merged_leads: list[Lead] = []
        cluster_ids: list[list[str]] = []
        duplicates_removed = 0
        emitted: set[str] = set()

        for key in order:  # preserve first-seen ordering
            root = uf.find(key)
            if root in emitted:
                continue
            emitted.add(root)
            members = sorted(clusters[root], key=lambda k: order.index(k))
            primary = by_id[members[0]]
            for member in members[1:]:
                primary.merge(by_id[member], source_priority=self.source_priority)
                duplicates_removed += 1
            primary.lead_id = primary.compute_id()
            merged_leads.append(primary)
            cluster_ids.append([by_id[m].company_name for m in members])

        if duplicates_removed:
            logger.info(
                "Deduplicated records",
                extra={"input": len(leads), "output": len(merged_leads), "removed": duplicates_removed},
            )
        return DedupeResult(
            leads=merged_leads,
            duplicates_removed=duplicates_removed,
            clusters=cluster_ids,
            merge_reasons={k: sorted(set(v)) for k, v in reasons.items()},
        )

    def _contradicts(self, a: Lead, b: Lead) -> bool:
        """Do two records disagree on a strong identifier?"""
        domain_a, domain_b = root_domain(a.domain or a.website), root_domain(b.domain or b.website)
        if domain_a and domain_b and domain_a != domain_b:
            return True
        if a.google_place_id and b.google_place_id and a.google_place_id != b.google_place_id:
            return True
        if a.phone_key and b.phone_key and a.phone_key != b.phone_key:
            return True
        return False

    def _corroborated(self, a: Lead, b: Lead) -> bool:
        """A fuzzy name match alone is not enough - require a second signal."""
        domain_a, domain_b = root_domain(a.domain or a.website), root_domain(b.domain or b.website)
        if domain_a and domain_b:
            if domain_a == domain_b:
                return True
            return False  # different domains == genuinely different businesses
        if a.phone_key and b.phone_key:
            if a.phone_key == b.phone_key:
                return True
            return False
        outward_a, outward_b = postcode_outward(a.postcode), postcode_outward(b.postcode)
        if outward_a and outward_b:
            return outward_a == outward_b
        city_a = (a.city or "").strip().lower()
        city_b = (b.city or "").strip().lower()
        if city_a and city_b:
            return city_a == city_b
        return False


_GENERIC_HOSTS = {
    "facebook.com",
    "instagram.com",
    "linkedin.com",
    "twitter.com",
    "x.com",
    "tiktok.com",
    "youtube.com",
    "google.com",
    "business.site",
    "wixsite.com",
    "wordpress.com",
    "weebly.com",
    "yell.com",
    "checkatrade.com",
    "trustpilot.com",
    "sites.google.com",
    "linktr.ee",
}


def find_duplicate_pairs(leads: Iterable[Lead], threshold: float = 0.88) -> list[tuple[str, str, float]]:
    """Diagnostic helper: report near-duplicate pairs without merging them."""
    leads = list(leads)
    pairs: list[tuple[str, str, float]] = []
    for i in range(len(leads)):
        for j in range(i + 1, len(leads)):
            similarity = company_name_similarity(leads[i].company_name, leads[j].company_name)
            if similarity >= threshold:
                pairs.append((leads[i].company_name, leads[j].company_name, round(similarity, 3)))
    return pairs
