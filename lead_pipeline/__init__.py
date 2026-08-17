"""Local business lead scraping, enrichment, scoring and export pipeline.

The package is deliberately dependency-light: everything except HTTP
(``aiohttp``) and HTML parsing (``beautifulsoup4``) is implemented on the
standard library so the scoring/dedup/export core can run anywhere, including
in tests with no network access.
"""

__version__ = "1.0.0"

__all__ = ["__version__"]
