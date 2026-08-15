"""Shared fixtures.

Everything here is offline: HTTP goes through :class:`FakeTransport`, the
database is a temp file, and the cache is disabled unless a test asks for it.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PACKAGE_ROOT.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from lead_pipeline.config import Settings, load_niches  # noqa: E402
from lead_pipeline.database import Database  # noqa: E402
from lead_pipeline.models import Lead, SourceRecord  # noqa: E402
from lead_pipeline.sources.base import SourceContext  # noqa: E402
from lead_pipeline.utils.cache import NullCache  # noqa: E402
from lead_pipeline.utils.http import FakeTransport, HttpClient  # noqa: E402
from lead_pipeline.utils.rate_limit import RateLimiter  # noqa: E402

# ---------------------------------------------------------------------------
# Sample HTML pages
# ---------------------------------------------------------------------------
GOOD_DENTAL_HOMEPAGE = """
<!doctype html>
<html lang="en">
<head>
  <title>Riverside Dental Studio | Invisalign &amp; Cosmetic Dentistry Newcastle</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Award winning cosmetic dentistry in Newcastle. Invisalign, veneers and composite bonding with 0% finance available.">
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC1234567"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('config', 'G-ABC1234567');
    gtag('config', 'AW-987654321');
  </script>
  <script>
    !function(f,b,e,v,n,t,s){}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
    fbq('init', '123456789012345');
    fbq('track', 'PageView');
  </script>
  <style>@media (max-width: 600px) { .nav { display: none; } }</style>
</head>
<body class="wp-content home">
  <header>
    <a class="btn-primary" href="tel:+441915550101">Call us today 0191 555 0101</a>
    <a href="https://calendly.com/riverside-dental/consultation">Book a consultation</a>
  </header>
  <h1>Straighter teeth in Newcastle with Invisalign</h1>
  <h2>Veneers, composite bonding and teeth whitening</h2>
  <p>We are a private dental practice offering Invisalign, veneers, composite bonding,
     teeth whitening and dental implants. Smile makeover packages from £1,850 with 0% finance available
     and monthly payments.</p>
  <section class="testimonials">
    <h2>What our patients say</h2>
    <blockquote>Fantastic results - the team were brilliant.</blockquote>
    <p>Rated 4.8 out of 5 across 237 Google reviews on Trustpilot and Google.</p>
  </section>
  <section class="gallery">
    <h2>Before and after gallery</h2>
    <img src="/img/before-after-invisalign.jpg" alt="Before and after Invisalign">
  </section>
  <nav>
    <a href="/invisalign">Invisalign</a>
    <a href="/veneers">Veneers</a>
    <a href="/composite-bonding">Composite bonding</a>
    <a href="/prices">Prices</a>
    <a href="/contact">Contact</a>
  </nav>
  <footer>
    <p>12 Grey Street, Newcastle upon Tyne, NE1 6EE</p>
    <p>Also at 4 Front Street, Tynemouth, NE30 4DX</p>
    <p>Email: <a href="mailto:hello@riversidedentalstudio.co.uk">hello@riversidedentalstudio.co.uk</a></p>
    <a href="https://www.facebook.com/riversidedentalstudio">Facebook</a>
    <a href="https://www.instagram.com/riversidedental/">Instagram</a>
    <p>&copy; 2024 Riverside Dental Studio</p>
  </footer>
</body>
</html>
"""

INVISALIGN_LANDING_PAGE = """
<!doctype html>
<html><head><title>Invisalign Newcastle | Riverside Dental Studio</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Invisalign clear aligners in Newcastle from £2,495 with 0% finance.">
</head>
<body>
<h1>Invisalign clear aligners in Newcastle</h1>
<p>Book a free Invisalign consultation with an iTero scan. Finance available, payment plan from £89 per month.</p>
<form action="/enquiry"><input type="text" name="name"><input type="email" name="email">
<input type="tel" name="phone"><textarea name="message"></textarea><button>Book a consultation</button></form>
<a href="https://calendly.com/riverside-dental/invisalign">Book online</a>
</body></html>
"""

CONTACT_PAGE = """
<!doctype html><html><head><title>Contact | Riverside Dental Studio</title>
<meta name="viewport" content="width=device-width"></head>
<body>
<h1>Contact us</h1>
<p>Email <a href="mailto:hello@riversidedentalstudio.co.uk">hello@riversidedentalstudio.co.uk</a>
   or <a href="mailto:sarah.jones@riversidedentalstudio.co.uk">sarah.jones@riversidedentalstudio.co.uk</a></p>
<p>Call <a href="tel:+441915550101">0191 555 0101</a></p>
<form><input type="email" name="email"><textarea name="message"></textarea></form>
</body></html>
"""

POOR_ROOFER_HOMEPAGE = """
<!doctype html>
<html><head><title>Northern Roofing Solutions</title></head>
<body>
<h1>Northern Roofing Solutions</h1>
<p>Roofing services in Sunderland. Call 0191 555 0303.</p>
<p>Roof repair and new roofs.</p>
</body></html>
"""

ROBOTS_ALLOW_ALL = "User-agent: *\nAllow: /\n"
ROBOTS_DISALLOW_ALL = "User-agent: *\nDisallow: /\n"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(scope="session")
def niches():
    return load_niches()


@pytest.fixture()
def settings(tmp_path) -> Settings:
    return Settings(
        user_agent="LeadPipelineTest/1.0 (+https://example.test; contact: test@example.test)",
        cache_enabled=False,
        cache_dir=tmp_path / "cache",
        db_path=tmp_path / "leads.sqlite",
        output_dir=tmp_path / "output",
        respect_robots=True,
        max_retries=2,
        backoff_base=0.0,
        backoff_max=0.0,
        default_rate_per_second=1000.0,
        global_concurrency=8,
        per_host_concurrency=4,
        max_pages_per_site=4,
        min_score=60.0,
    )


@pytest.fixture()
def transport() -> FakeTransport:
    return FakeTransport(
        routes={
            "/robots.txt": {"status": 200, "text": ROBOTS_ALLOW_ALL,
                            "headers": {"content-type": "text/plain"}},
            "riversidedentalstudio.co.uk/invisalign": {"status": 200, "text": INVISALIGN_LANDING_PAGE},
            "riversidedentalstudio.co.uk/contact": {"status": 200, "text": CONTACT_PAGE},
            "riversidedentalstudio.co.uk": {"status": 200, "text": GOOD_DENTAL_HOMEPAGE},
            "northernroofingsolutions.co.uk": {"status": 200, "text": POOR_ROOFER_HOMEPAGE},
        },
        default={"status": 404, "text": "not found", "headers": {"content-type": "text/html"}},
    )


@pytest.fixture()
def client(settings: Settings, transport: FakeTransport) -> HttpClient:
    return HttpClient(
        user_agent=settings.user_agent,
        transport=transport,
        cache=NullCache(),
        limiter=RateLimiter(1000.0, global_concurrency=8, per_host_concurrency=4),
        respect_robots=settings.respect_robots,
        max_retries=settings.max_retries,
        backoff_base=0.0,
        backoff_max=0.0,
        jitter=False,
    )


@pytest.fixture()
def ctx(settings: Settings, client: HttpClient) -> SourceContext:
    return SourceContext(settings=settings, client=client)


@pytest.fixture()
def db(tmp_path) -> Database:
    database = Database(tmp_path / "test_leads.sqlite")
    yield database
    database.close()


def make_lead(**overrides) -> Lead:
    """Build a lead with sensible defaults for scoring/dedupe tests."""
    source_name = overrides.pop("source_name", "google_places")
    payload = {
        "company_name": "Riverside Dental Studio",
        "niche": "invisalign_dental_practices",
        "website": "https://riversidedentalstudio.co.uk",
        "business_phone": "0191 555 0101",
        "address": "12 Grey Street, Newcastle upon Tyne, NE1 6EE",
        "city": "Newcastle upon Tyne",
        "postcode": "NE1 6EE",
        "country": "UK",
        "google_rating": 4.8,
        "google_review_count": 237,
        "google_place_id": "ChIJtest0001",
    }
    payload.update(overrides)
    lead = Lead(**payload)
    lead.add_source(SourceRecord(source=source_name, source_url=lead.website))
    return lead


@pytest.fixture()
def lead_factory():
    return make_lead
