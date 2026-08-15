"""Source registry.

To add a source: implement a :class:`~lead_pipeline.sources.base.BaseSource`
subclass and add it to ``SOURCE_CLASSES`` below.
"""

from __future__ import annotations

from typing import Any, Iterable

from ..config import Settings
from .base import BaseSource, SearchQuery, SourceContext, record_to_lead
from .bing import BingPlacesSource
from .companies_house import CompaniesHouseSource
from .directories import DirectorySource
from .fixture import FixtureSource
from .google_places import GooglePlacesSource
from .openstreetmap import OpenStreetMapSource
from .search import SearchSource

SOURCE_CLASSES: dict[str, type[BaseSource]] = {
    GooglePlacesSource.name: GooglePlacesSource,
    BingPlacesSource.name: BingPlacesSource,
    OpenStreetMapSource.name: OpenStreetMapSource,
    SearchSource.name: SearchSource,
    DirectorySource.name: DirectorySource,
    CompaniesHouseSource.name: CompaniesHouseSource,
    FixtureSource.name: FixtureSource,
}

# Discovery sources tried by default, best-quality first.
DEFAULT_DISCOVERY_ORDER = [
    GooglePlacesSource.name,
    BingPlacesSource.name,
    OpenStreetMapSource.name,
    SearchSource.name,
    DirectorySource.name,
]


def build_sources(
    settings: Settings,
    names: Iterable[str] | None = None,
    *,
    fixture_path: str | None = None,
) -> list[BaseSource]:
    """Instantiate the requested sources (or every discovery source)."""
    requested = list(names) if names else list(DEFAULT_DISCOVERY_ORDER)
    if fixture_path and FixtureSource.name not in requested:
        requested.append(FixtureSource.name)

    built: list[BaseSource] = []
    for name in requested:
        key = name.strip().lower()
        cls = SOURCE_CLASSES.get(key)
        if cls is None:
            raise KeyError(f"Unknown source {name!r}. Available: {', '.join(sorted(SOURCE_CLASSES))}")
        built.append(_instantiate(cls, settings, fixture_path))
    return built


def _instantiate(cls: type[BaseSource], settings: Settings, fixture_path: str | None) -> BaseSource:
    if cls is FixtureSource:
        return FixtureSource(settings, fixture_path)
    return cls(settings)


def available_sources(settings: Settings, fixture_path: str | None = None) -> list[dict[str, Any]]:
    """Describe every registered source and whether it can run right now."""
    rows: list[dict[str, Any]] = []
    for name, cls in SOURCE_CLASSES.items():
        source = _instantiate(cls, settings, fixture_path)
        rows.append(
            {
                "name": name,
                "kind": source.kind,
                "description": source.description,
                "attribution": source.attribution,
                "available": source.is_available(),
                "reason": source.unavailable_reason(),
            }
        )
    return rows


__all__ = [
    "BaseSource",
    "SearchQuery",
    "SourceContext",
    "record_to_lead",
    "SOURCE_CLASSES",
    "DEFAULT_DISCOVERY_ORDER",
    "build_sources",
    "available_sources",
    "GooglePlacesSource",
    "BingPlacesSource",
    "OpenStreetMapSource",
    "SearchSource",
    "DirectorySource",
    "CompaniesHouseSource",
    "FixtureSource",
]
