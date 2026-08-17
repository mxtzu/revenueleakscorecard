"""On-page signal extraction.

Pure functions over HTML - no network, no state - so every detection is unit
testable. :mod:`lead_pipeline.enrichment.website` does the fetching and calls
in here for the analysis.

Parsing uses BeautifulSoup when available and falls back to a stdlib
``HTMLParser`` extractor, so signal detection still works in minimal
environments.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import Any, Iterable
from urllib.parse import urljoin, urlsplit

from ..models import PersonMention
from ..utils.email_validation import extract_emails
from ..utils.normalization import clean_text, normalize_postcode, normalize_url
from .people import extract_people

# --------------------------------------------------------------------------
# Signal vocabularies
# --------------------------------------------------------------------------
BOOKING_PROVIDERS = {
    "calendly": "Calendly",
    "acuityscheduling": "Acuity",
    "squarespacescheduling": "Acuity",
    "setmore": "Setmore",
    "simplybook": "SimplyBook.me",
    "bookinglive": "BookingLive",
    "10to8": "10to8",
    "youcanbook.me": "YouCanBook.me",
    "cliniko": "Cliniko",
    "pabau": "Pabau",
    "phorest": "Phorest",
    "treatwell": "Treatwell",
    "fresha": "Fresha",
    "timely": "Timely",
    "dentally": "Dentally",
    "zesty.co.uk": "Zesty",
    "dentr": "Dentr",
    "carestack": "CareStack",
    "appointedd": "Appointedd",
    "bookwhen": "Bookwhen",
    "gettimely": "Timely",
    "square.site": "Square Appointments",
    "squareup.com/appointments": "Square Appointments",
    "mindbody": "Mindbody",
    "resurva": "Resurva",
    "booksy": "Booksy",
    "servicem8": "ServiceM8",
    "housecallpro": "Housecall Pro",
    "jobber": "Jobber",
}

CHAT_PROVIDERS = {
    "tawk.to": "Tawk.to",
    "intercom": "Intercom",
    "drift.com": "Drift",
    "crisp.chat": "Crisp",
    "livechatinc": "LiveChat",
    "zdassets": "Zendesk Chat",
    "zopim": "Zendesk Chat",
    "tidio": "Tidio",
    "olark": "Olark",
    "hs-scripts.com": "HubSpot",
    "smartsupp": "Smartsupp",
    "jivosite": "JivoChat",
    "chatway": "Chatway",
    "podium": "Podium",
    "wa.me/": "WhatsApp",
    "api.whatsapp.com": "WhatsApp",
    "messenger.com": "Facebook Messenger",
}

FORM_PLUGINS = (
    "wpcf7",
    "contact-form-7",
    "gravity_form",
    "gform_wrapper",
    "wpforms",
    "ninja-forms",
    "formidable",
    "hbspt.forms",
    "js.hsforms.net",
    "typeform",
    "jotform",
    "formstack",
    "gravityforms",
    "elementor-form",
    "fluentform",
    "forminator",
)

CTA_PHRASES = (
    "book now",
    "book online",
    "book a consultation",
    "book an appointment",
    "book your",
    "request a callback",
    "request a quote",
    "get a quote",
    "get your quote",
    "free quote",
    "free consultation",
    "free survey",
    "free estimate",
    "free design",
    "enquire now",
    "make an enquiry",
    "contact us today",
    "call us today",
    "arrange a visit",
    "schedule a call",
    "start your",
    "claim your",
    "get started",
    "apply now",
    "check availability",
)

PRICING_PATTERNS = (
    re.compile(r"£\s?\d[\d,]*(?:\.\d{2})?"),
    re.compile(r"\bfrom\s+£\s?\d", re.IGNORECASE),
    re.compile(r"\b(?:price list|our prices|pricing|price guide|cost guide|treatment prices)\b", re.IGNORECASE),
    re.compile(r"\b\d+\s*(?:per month|pm|a month)\b", re.IGNORECASE),
)

TESTIMONIAL_PATTERNS = (
    re.compile(r"\btestimonial", re.IGNORECASE),
    re.compile(r"what (?:our|my) (?:clients|customers|patients|guests) say", re.IGNORECASE),
    re.compile(r"\bclient stories\b|\bpatient stories\b|\bhappy customers\b", re.IGNORECASE),
)

REVIEW_PATTERNS = (
    re.compile(r"google reviews?", re.IGNORECASE),
    re.compile(r"trustpilot", re.IGNORECASE),
    re.compile(r"reviews?\.io", re.IGNORECASE),
    re.compile(r"checkatrade", re.IGNORECASE),
    re.compile(r"trustatrader", re.IGNORECASE),
    re.compile(r"feefo", re.IGNORECASE),
    re.compile(r"\b\d(?:\.\d)?\s*(?:star|★|out of 5)", re.IGNORECASE),
    re.compile(r"aggregaterating", re.IGNORECASE),
)

BEFORE_AFTER_PATTERNS = (
    re.compile(r"before\s*(?:and|&|/)\s*after", re.IGNORECASE),
    re.compile(r"\bbefore-and-after\b|\bbefore_after\b|\bbeforeafter\b", re.IGNORECASE),
    re.compile(r"smile gallery|results gallery|transformation", re.IGNORECASE),
)

CASE_STUDY_PATTERNS = (
    re.compile(r"case stud(?:y|ies)", re.IGNORECASE),
    re.compile(r"recent (?:work|projects|installations|jobs)", re.IGNORECASE),
    re.compile(r"our (?:portfolio|projects)", re.IGNORECASE),
)

FINANCE_PATTERNS = (
    re.compile(r"0%\s*(?:apr|finance|interest)", re.IGNORECASE),
    re.compile(r"finance (?:available|options|plans)", re.IGNORECASE),
    re.compile(r"payment plan|monthly payments|spread the cost|pay monthly", re.IGNORECASE),
    re.compile(r"\bklarna\b|\bclearpay\b|\btabeo\b|\bmedenta\b|\bchrysalis finance\b|\bdivido\b", re.IGNORECASE),
)

CMS_SIGNATURES = (
    ("wp-content", "WordPress"),
    ("wp-includes", "WordPress"),
    ("wixstatic.com", "Wix"),
    ("_wix", "Wix"),
    ("squarespace", "Squarespace"),
    ("cdn.shopify.com", "Shopify"),
    ("webflow.io", "Webflow"),
    ("webflow.com", "Webflow"),
    ("godaddysites", "GoDaddy Website Builder"),
    ("duda", "Duda"),
    ("weebly", "Weebly"),
    ("joomla", "Joomla"),
    ("drupal", "Drupal"),
    ("hubspot", "HubSpot CMS"),
    ("umbraco", "Umbraco"),
    ("craftcms", "Craft CMS"),
    ("_next/static", "Next.js"),
    ("gatsby", "Gatsby"),
)

SOCIAL_HOSTS = {
    "facebook.com": "facebook_url",
    "fb.com": "facebook_url",
    "instagram.com": "instagram_url",
    "linkedin.com": "linkedin_url",
    "tiktok.com": "tiktok_url",
    "youtube.com": "youtube_url",
    "youtu.be": "youtube_url",
}

SOCIAL_IGNORE_PATH_TOKENS = ("sharer", "share.php", "intent", "plugins", "dialog")

CONTACT_PAGE_HINTS = ("contact", "get-in-touch", "enquir", "book", "appointment", "quote", "consultation")
ABOUT_PAGE_HINTS = ("about", "our-team", "meet-the-team", "who-we-are")
PRICE_PAGE_HINTS = ("price", "pricing", "fees", "cost", "finance")
# Pages that name who runs the business. Ranked above pricing because a lead
# with a named decision-maker is worth more than one with a published price.
TEAM_PAGE_HINTS = ("team", "our-people", "staff", "meet-", "who-we-are", "leadership", "our-story")

# Elements whose text is short enough to be a name or a job title on its own.
BLOCK_TAGS = (
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "li", "span", "strong", "b", "em", "figcaption", "td", "th", "dt", "dd",
)
MAX_TEXT_BLOCKS = 800


# --------------------------------------------------------------------------
# Parsed document
# --------------------------------------------------------------------------
@dataclass
class ParsedDocument:
    url: str
    html: str
    title: str = ""
    meta: dict[str, str] = field(default_factory=dict)
    h1s: list[str] = field(default_factory=list)
    h2s: list[str] = field(default_factory=list)
    text: str = ""
    links: list[tuple[str, str]] = field(default_factory=list)  # (href, anchor text)
    scripts: list[str] = field(default_factory=list)
    iframes: list[str] = field(default_factory=list)
    forms: list[dict[str, Any]] = field(default_factory=list)
    images: list[str] = field(default_factory=list)
    buttons: list[str] = field(default_factory=list)
    classes: list[str] = field(default_factory=list)
    blocks: list[str] = field(default_factory=list)
    """Short text runs in document order.

    Adjacency is the signal: a team card is a name in one element and a role in
    the next, and that relationship is lost once the page is flattened to a
    single string.
    """

    @property
    def lowered_html(self) -> str:
        return self.html.lower()


class _FallbackParser(HTMLParser):
    """Minimal stdlib parser used when BeautifulSoup is unavailable."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.meta: dict[str, str] = {}
        self.h1s: list[str] = []
        self.h2s: list[str] = []
        self.text_parts: list[str] = []
        self.links: list[tuple[str, str]] = []
        self.scripts: list[str] = []
        self.iframes: list[str] = []
        self.forms: list[dict[str, Any]] = []
        self.images: list[str] = []
        self.buttons: list[str] = []
        self.classes: list[str] = []
        self._stack: list[str] = []
        self._capture: list[str] | None = None
        self._current_href: str | None = None
        self._in_form = False
        self._form_inputs: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = {k.lower(): (v or "") for k, v in attrs}
        self._stack.append(tag)
        if attributes.get("class"):
            self.classes.append(attributes["class"])
        if attributes.get("id"):
            self.classes.append(attributes["id"])
        if tag in {"script", "style", "noscript"}:
            self._skip_depth += 1
            if tag == "script" and attributes.get("src"):
                self.scripts.append(attributes["src"])
        elif tag == "meta":
            name = (attributes.get("name") or attributes.get("property") or "").lower()
            if name:
                self.meta[name] = attributes.get("content", "")
        elif tag == "a":
            self._current_href = attributes.get("href", "")
            self._capture = []
        elif tag in {"h1", "h2", "title", "button"}:
            self._capture = []
        elif tag == "iframe":
            self.iframes.append(attributes.get("src", ""))
        elif tag == "img":
            self.images.append(attributes.get("src", "") + " " + attributes.get("alt", ""))
        elif tag == "form":
            self._in_form = True
            self._form_inputs = []
            self.forms.append({"action": attributes.get("action", ""), "inputs": self._form_inputs,
                               "class": attributes.get("class", "")})
        elif tag in {"input", "textarea", "select"} and self._in_form:
            self._form_inputs.append(
                f"{tag}:{attributes.get('type', '')}:{attributes.get('name', '')}:{attributes.get('placeholder', '')}"
            )

    def handle_endtag(self, tag: str) -> None:
        captured = clean_text(" ".join(self._capture)) if self._capture is not None else ""
        if tag == "a":
            if self._current_href is not None:
                self.links.append((self._current_href, captured))
            self._current_href = None
            self._capture = None
            if captured:
                self.text_parts.append(captured)
        elif tag == "h1":
            if captured:
                self.h1s.append(captured)
                self.text_parts.append(captured)
            self._capture = None
        elif tag == "h2":
            if captured:
                self.h2s.append(captured)
                self.text_parts.append(captured)
            self._capture = None
        elif tag == "title":
            self.title = captured
            self._capture = None
        elif tag == "button":
            if captured:
                self.buttons.append(captured)
                self.text_parts.append(captured)
            self._capture = None
        elif tag in {"script", "style", "noscript"}:
            self._skip_depth = max(0, self._skip_depth - 1)
        elif tag == "form":
            self._in_form = False
        if self._stack and tag in self._stack:
            while self._stack:
                if self._stack.pop() == tag:
                    break

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        text = data.strip()
        if not text:
            return
        if self._capture is not None:
            self._capture.append(text)
        else:
            self.text_parts.append(text)


def _text_blocks(texts: Iterable[str]) -> list[str]:
    """Keep short, non-repeating text runs in document order.

    Nested elements yield the same text more than once (a `<p>` inside a `<div>`
    inside a `<li>`), which would fake adjacency between an element and itself.
    Consecutive duplicates are collapsed for that reason.
    """
    blocks: list[str] = []
    for text in texts:
        if not text or len(text) > 200:
            continue
        if blocks and blocks[-1] == text:
            continue
        blocks.append(text)
        if len(blocks) >= MAX_TEXT_BLOCKS:
            break
    return blocks


def parse_html(html: str, url: str = "") -> ParsedDocument:
    """Parse a page into the structures the detectors need."""
    document = ParsedDocument(url=url, html=html or "")
    if not html:
        return document
    try:
        from bs4 import BeautifulSoup  # noqa: PLC0415

        soup = BeautifulSoup(html, "html.parser")
        if soup.title and soup.title.string:
            document.title = clean_text(soup.title.string)
        for meta in soup.find_all("meta"):
            name = (meta.get("name") or meta.get("property") or "").lower()
            if name:
                document.meta[name] = meta.get("content", "") or ""
        document.h1s = [clean_text(h.get_text(" ", strip=True)) for h in soup.find_all("h1")]
        document.h2s = [clean_text(h.get_text(" ", strip=True)) for h in soup.find_all("h2")]
        for tag in soup(["script", "style", "noscript"]):
            if tag.name == "script" and tag.get("src"):
                document.scripts.append(tag.get("src"))
            tag.decompose()
        document.text = clean_text(soup.get_text(" ", strip=True))
        document.links = [
            (a.get("href") or "", clean_text(a.get_text(" ", strip=True))) for a in soup.find_all("a")
        ]
        document.iframes = [i.get("src") or "" for i in soup.find_all("iframe")]
        document.images = [f"{i.get('src') or ''} {i.get('alt') or ''}" for i in soup.find_all("img")]
        document.buttons = [clean_text(b.get_text(" ", strip=True)) for b in soup.find_all("button")]
        for form in soup.find_all("form"):
            inputs = [
                f"{i.name}:{i.get('type', '')}:{i.get('name', '')}:{i.get('placeholder', '')}"
                for i in form.find_all(["input", "textarea", "select"])
            ]
            document.forms.append(
                {"action": form.get("action", ""), "inputs": inputs, "class": " ".join(form.get("class") or [])}
            )
        document.classes = [
            " ".join(tag.get("class") or []) + " " + str(tag.get("id") or "")
            for tag in soup.find_all(attrs={"class": True})
        ][:400]
        document.blocks = _text_blocks(
            clean_text(tag.get_text(" ", strip=True)) for tag in soup.find_all(BLOCK_TAGS)
        )
        return document
    except ImportError:
        pass

    parser = _FallbackParser()
    try:
        parser.feed(html)
        parser.close()
    except Exception:  # pragma: no cover - malformed markup
        pass
    document.title = parser.title
    document.meta = parser.meta
    document.h1s = parser.h1s
    document.h2s = parser.h2s
    document.text = clean_text(" ".join(parser.text_parts))
    document.links = parser.links
    document.scripts = parser.scripts
    document.iframes = parser.iframes
    document.images = parser.images
    document.buttons = parser.buttons
    document.forms = parser.forms
    document.classes = parser.classes
    # The fallback parser emits text in document order already, so the raw run
    # sequence is a serviceable stand-in for element blocks.
    document.blocks = _text_blocks(clean_text(part) for part in parser.text_parts)
    return document


# --------------------------------------------------------------------------
# Signals
# --------------------------------------------------------------------------
@dataclass
class TrackingSignals:
    google_analytics: bool = False
    google_tag_manager: bool = False
    google_ads_tag: bool = False
    meta_pixel: bool = False
    tiktok_pixel: bool = False
    linkedin_insight: bool = False
    other_pixels: list[str] = field(default_factory=list)
    ids: dict[str, list[str]] = field(default_factory=dict)

    @property
    def has_any_pixel(self) -> bool:
        return any(
            [
                self.google_analytics,
                self.google_tag_manager,
                self.google_ads_tag,
                self.meta_pixel,
                self.tiktok_pixel,
                self.linkedin_insight,
                bool(self.other_pixels),
            ]
        )


@dataclass
class PageSignals:
    """Everything observable on one page."""

    url: str = ""
    title: str = ""
    meta_description: str = ""
    h1: str = ""
    word_count: int = 0
    has_viewport: bool = False
    responsive_css: bool = False
    has_contact_form: bool = False
    has_phone_cta: bool = False
    phone_links: list[str] = field(default_factory=list)
    has_primary_cta: bool = False
    cta_phrases: list[str] = field(default_factory=list)
    has_booking: bool = False
    booking_providers: list[str] = field(default_factory=list)
    has_online_booking: bool = False
    has_live_chat: bool = False
    chat_providers: list[str] = field(default_factory=list)
    has_pricing: bool = False
    has_testimonials: bool = False
    has_reviews: bool = False
    has_before_after: bool = False
    has_case_studies: bool = False
    has_finance: bool = False
    tracking: TrackingSignals = field(default_factory=TrackingSignals)
    emails: list[str] = field(default_factory=list)
    people: list[PersonMention] = field(default_factory=list)
    social_links: dict[str, str] = field(default_factory=dict)
    internal_links: list[str] = field(default_factory=list)
    keywords_found: list[str] = field(default_factory=list)
    schema_types: list[str] = field(default_factory=list)
    cms: str | None = None
    copyright_year: int | None = None
    postcodes: list[str] = field(default_factory=list)
    image_count: int = 0
    script_count: int = 0
    html_bytes: int = 0


def analyse_page(
    html: str,
    url: str,
    *,
    keywords: Iterable[str] = (),
    company_name: str = "",
    locality: str = "",
    collect_people: bool = True,
) -> PageSignals:
    """Extract every on-page signal from one HTML document.

    ``company_name`` and ``locality`` are used only to reject a trading name or
    a town that reads like a person ("Smith & Sons", "Newcastle Upon Tyne");
    ``collect_people`` turns off named-contact extraction entirely.
    """
    document = parse_html(html, url)
    lowered = document.lowered_html
    text_lower = document.text.lower()
    signals = PageSignals(url=url, html_bytes=len(html or ""))

    signals.title = document.title
    signals.meta_description = clean_text(document.meta.get("description", ""))
    signals.h1 = document.h1s[0] if document.h1s else ""
    signals.word_count = len(document.text.split())
    signals.image_count = len(document.images)
    signals.script_count = len(document.scripts)

    viewport = document.meta.get("viewport", "")
    signals.has_viewport = "width=device-width" in viewport.lower().replace(" ", "")
    signals.responsive_css = "@media" in lowered or "col-md" in lowered or "flex" in lowered

    # --- contact / conversion --------------------------------------------
    signals.phone_links = [
        href for href, _ in document.links if href.lower().startswith("tel:")
    ]
    signals.has_phone_cta = bool(signals.phone_links) or bool(
        re.search(r"\b(?:call us|call now|phone us|speak to (?:us|our team))\b", text_lower)
    )

    signals.has_contact_form = _detect_contact_form(document, lowered)

    anchor_and_button_text = [t.lower() for _, t in document.links if t] + [
        b.lower() for b in document.buttons if b
    ]
    for phrase in CTA_PHRASES:
        if any(phrase in t for t in anchor_and_button_text) or phrase in text_lower:
            signals.cta_phrases.append(phrase)
    signals.has_primary_cta = bool(signals.cta_phrases) or any(
        c in " ".join(document.classes).lower() for c in ("btn-primary", "cta-button", "hero-cta", "elementor-button")
    ) and bool(anchor_and_button_text)

    for token, provider in BOOKING_PROVIDERS.items():
        if token in lowered:
            signals.booking_providers.append(provider)
    signals.booking_providers = sorted(set(signals.booking_providers))
    booking_link = any(
        any(hint in (href or "").lower() for hint in ("/book", "book-online", "booking", "appointment"))
        for href, _ in document.links
    )
    booking_text = bool(
        re.search(r"\bbook (?:online|now|an appointment|a consultation|your)\b", text_lower)
    )
    signals.has_booking = bool(signals.booking_providers) or booking_link or booking_text
    signals.has_online_booking = bool(signals.booking_providers) or (
        booking_link and any(h.lower().startswith("http") for h, _ in document.links if "book" in (h or "").lower())
    ) or booking_text and booking_link

    for token, provider in CHAT_PROVIDERS.items():
        if token in lowered:
            signals.chat_providers.append(provider)
    signals.chat_providers = sorted(set(signals.chat_providers))
    signals.has_live_chat = bool(signals.chat_providers) or "live chat" in text_lower

    signals.has_pricing = any(pattern.search(document.text) for pattern in PRICING_PATTERNS)
    signals.has_testimonials = any(p.search(document.text) for p in TESTIMONIAL_PATTERNS) or any(
        p.search(" ".join(document.classes)) for p in TESTIMONIAL_PATTERNS
    )
    signals.has_reviews = any(p.search(document.text) for p in REVIEW_PATTERNS) or any(
        p.search(lowered) for p in REVIEW_PATTERNS
    )
    haystack_media = document.text + " " + " ".join(document.images) + " " + " ".join(document.classes)
    signals.has_before_after = any(p.search(haystack_media) for p in BEFORE_AFTER_PATTERNS)
    signals.has_case_studies = any(p.search(document.text) for p in CASE_STUDY_PATTERNS)
    signals.has_finance = any(p.search(document.text) for p in FINANCE_PATTERNS)

    # --- tracking ---------------------------------------------------------
    signals.tracking = detect_tracking(html or "")

    # --- contact details --------------------------------------------------
    mailtos = [href[7:] for href, _ in document.links if href.lower().startswith("mailto:")]
    signals.emails = list(dict.fromkeys(extract_emails(" ".join(mailtos)) + extract_emails(document.text)))

    if collect_people:
        signals.people = extract_people(
            document, company_name=company_name, locality=locality
        )

    signals.social_links = extract_social_links(document.links)
    signals.internal_links = _internal_links(document.links, url)

    haystack = f"{document.text} {document.title} {' '.join(document.h1s)} {' '.join(document.h2s)}".lower()
    signals.keywords_found = sorted({kw for kw in keywords if kw and kw in haystack})

    signals.schema_types = sorted(set(re.findall(r'"@type"\s*:\s*"([A-Za-z]+)"', html or "")))
    for token, cms in CMS_SIGNATURES:
        if token in lowered:
            signals.cms = cms
            break

    year_match = re.findall(r"(?:©|&copy;|copyright)[^\d]{0,20}(20\d{2})", lowered)
    if year_match:
        signals.copyright_year = max(int(y) for y in year_match)

    signals.postcodes = sorted({p for p in _find_postcodes(document.text)})
    return signals


def detect_tracking(html: str) -> TrackingSignals:
    """Identify analytics/advertising tags in the raw HTML."""
    tracking = TrackingSignals()
    lowered = (html or "").lower()

    ga_ids = re.findall(r"\b(g-[a-z0-9]{6,12})\b", lowered) + re.findall(r"\b(ua-\d{4,10}-\d{1,4})\b", lowered)
    if ga_ids or "google-analytics.com/analytics.js" in lowered or "gtag/js?id=g-" in lowered or "ga('create'" in lowered:
        tracking.google_analytics = True
        if ga_ids:
            tracking.ids["google_analytics"] = sorted(set(ga_ids))

    gtm_ids = re.findall(r"\b(gtm-[a-z0-9]{4,10})\b", lowered)
    if gtm_ids or "googletagmanager.com/gtm.js" in lowered:
        tracking.google_tag_manager = True
        if gtm_ids:
            tracking.ids["google_tag_manager"] = sorted(set(gtm_ids))

    aw_ids = re.findall(r"\b(aw-\d{6,12})\b", lowered)
    if (
        aw_ids
        or "googleadservices.com/pagead/conversion" in lowered
        or "google_conversion_id" in lowered
        or "gtag('event', 'conversion'" in lowered
        or 'gtag("event", "conversion"' in lowered
    ):
        tracking.google_ads_tag = True
        if aw_ids:
            tracking.ids["google_ads"] = sorted(set(aw_ids))

    if (
        "connect.facebook.net" in lowered
        and ("fbevents.js" in lowered or "fbq(" in lowered)
        or "facebook.com/tr?id=" in lowered
        or "fbq('init'" in lowered
        or 'fbq("init"' in lowered
    ):
        tracking.meta_pixel = True
        pixel_ids = re.findall(r"fbq\(\s*['\"]init['\"]\s*,\s*['\"](\d{8,20})['\"]", lowered)
        pixel_ids += re.findall(r"facebook\.com/tr\?id=(\d{8,20})", lowered)
        if pixel_ids:
            tracking.ids["meta_pixel"] = sorted(set(pixel_ids))

    if "analytics.tiktok.com" in lowered or "ttq.load(" in lowered:
        tracking.tiktok_pixel = True
    if "snap.licdn.com" in lowered or "_linkedin_partner_id" in lowered:
        tracking.linkedin_insight = True

    for token, label in (
        ("static.hotjar.com", "Hotjar"),
        ("clarity.ms", "Microsoft Clarity"),
        ("bat.bing.com", "Microsoft Ads UET"),
        ("static.ads-twitter.com", "X/Twitter Pixel"),
        ("sc-static.net", "Snap Pixel"),
        ("pinimg.com/ct.js", "Pinterest Tag"),
        ("js.hs-scripts.com", "HubSpot"),
    ):
        if token in lowered:
            tracking.other_pixels.append(label)
    tracking.other_pixels = sorted(set(tracking.other_pixels))
    return tracking


def extract_social_links(links: Iterable[tuple[str, str]]) -> dict[str, str]:
    """Map social platform -> canonical profile URL found in page links."""
    found: dict[str, str] = {}
    for href, _ in links:
        if not href:
            continue
        normalized = normalize_url(href)
        if not normalized:
            continue
        host = (urlsplit(normalized).hostname or "").lower()
        host = host[4:] if host.startswith("www.") else host
        for social_host, field_name in SOCIAL_HOSTS.items():
            if host == social_host or host.endswith("." + social_host):
                path = urlsplit(normalized).path.strip("/")
                if not path or any(token in normalized.lower() for token in SOCIAL_IGNORE_PATH_TOKENS):
                    continue
                found.setdefault(field_name, normalized)
    return found


def _detect_contact_form(document: ParsedDocument, lowered: str) -> bool:
    for form in document.forms:
        inputs = " ".join(form.get("inputs", [])).lower()
        action = (form.get("action") or "").lower()
        if "search" in action or "search" in (form.get("class") or "").lower():
            continue
        if any(token in inputs for token in ("email", "tel", "phone", "textarea", "message", "name")):
            return True
    if any(plugin in lowered for plugin in FORM_PLUGINS):
        return True
    for src in document.iframes:
        if any(token in (src or "").lower() for token in ("typeform", "jotform", "hsforms", "google.com/forms")):
            return True
    return False


def _internal_links(links: Iterable[tuple[str, str]], base_url: str) -> list[str]:
    base_host = (urlsplit(base_url).hostname or "").lower().removeprefix("www.")
    internal: dict[str, None] = {}
    for href, _ in links:
        if not href or href.startswith(("mailto:", "tel:", "javascript:", "#")):
            continue
        absolute = urljoin(base_url, href)
        parts = urlsplit(absolute)
        if parts.scheme not in ("http", "https"):
            continue
        host = (parts.hostname or "").lower().removeprefix("www.")
        if host != base_host:
            continue
        clean = f"{parts.scheme}://{parts.netloc}{parts.path}".rstrip("/")
        if clean and clean not in internal:
            internal[clean] = None
    return list(internal)


def _find_postcodes(text: str) -> list[str]:
    found = []
    for match in re.finditer(r"\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b", text.upper()):
        postcode = normalize_postcode(match.group(0))
        if postcode:
            found.append(postcode)
    return found


def rank_internal_links(links: Iterable[str], *, url_hints: Iterable[str], limit: int) -> list[str]:
    """Pick the most useful internal pages to fetch next."""
    hints = [h.lower() for h in url_hints]
    scored: list[tuple[int, str]] = []
    for link in links:
        lowered = link.lower()
        score = 0
        for hint in hints:
            if hint and hint in lowered:
                score += 5
        for hint in CONTACT_PAGE_HINTS:
            if hint in lowered:
                score += 4
        for hint in TEAM_PAGE_HINTS:
            if hint in lowered:
                score += 3
                break  # "meet-the-team" must not out-score a real contact page
        for hint in PRICE_PAGE_HINTS:
            if hint in lowered:
                score += 2
        for hint in ABOUT_PAGE_HINTS:
            if hint in lowered:
                score += 1
        depth = lowered.count("/") - 2
        score -= max(0, depth)
        if score > 0:
            scored.append((score, link))
    scored.sort(key=lambda item: (-item[0], len(item[1])))
    return [link for _, link in scored[:limit]]


def estimate_page_speed(
    *, load_time_ms: float | None, html_bytes: int, script_count: int, image_count: int
) -> int:
    """Heuristic 0-100 speed proxy when the PageSpeed API is not configured.

    This is explicitly an estimate: ``page_speed_source`` records which method
    produced the number.
    """
    score = 100.0
    if load_time_ms is not None:
        if load_time_ms > 6000:
            score -= 45
        elif load_time_ms > 4000:
            score -= 32
        elif load_time_ms > 2500:
            score -= 20
        elif load_time_ms > 1500:
            score -= 10
        elif load_time_ms > 800:
            score -= 4
    if html_bytes > 900_000:
        score -= 20
    elif html_bytes > 500_000:
        score -= 12
    elif html_bytes > 250_000:
        score -= 6
    if script_count > 40:
        score -= 18
    elif script_count > 25:
        score -= 12
    elif script_count > 15:
        score -= 6
    if image_count > 80:
        score -= 10
    elif image_count > 40:
        score -= 5
    return int(max(5, min(100, round(score))))
