"""Normalization helpers.

Every value that participates in matching (company name, phone, domain,
address, postcode) is pushed through here first so records coming from
different sources compare on equal terms.
"""

from __future__ import annotations

import html
import re
import unicodedata
from difflib import SequenceMatcher
from typing import Iterable
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

# Legal / marketing suffixes that carry no identity information.
LEGAL_SUFFIXES = {
    "ltd",
    "ltd.",
    "limited",
    "llp",
    "lp",
    "plc",
    "cic",
    "co",
    "co.",
    "company",
    "corp",
    "corporation",
    "inc",
    "incorporated",
    "holdings",
    "group",
    "uk",
    "gb",
    "england",
    "trading",
    "t/a",
}

# Words that appear so often in these verticals they add no discriminating power
# when comparing two names, but we keep them unless the name would vanish.
GENERIC_NAME_WORDS = {"the", "and", "&", "of", "at", "in", "for", "your"}

ADDRESS_ABBREVIATIONS = {
    "street": "st",
    "saint": "st",
    "road": "rd",
    "avenue": "ave",
    "drive": "dr",
    "lane": "ln",
    "court": "ct",
    "place": "pl",
    "square": "sq",
    "terrace": "ter",
    "crescent": "cres",
    "close": "cl",
    "gardens": "gdns",
    "park": "pk",
    "north": "n",
    "south": "s",
    "east": "e",
    "west": "w",
    "suite": "ste",
    "unit": "unit",
    "floor": "fl",
    "building": "bldg",
    "united kingdom": "uk",
    "great britain": "uk",
}

TRACKING_PARAMS = {
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "utm_id",
    "gclid",
    "gbraid",
    "wbraid",
    "gad_source",
    "fbclid",
    "msclkid",
    "mc_cid",
    "mc_eid",
    "igshid",
    "ref",
    "referrer",
    "_ga",
    "yclid",
    "ttclid",
}

UK_POSTCODE_RE = re.compile(
    r"\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b",
    re.IGNORECASE,
)

_WS_RE = re.compile(r"\s+")
_NON_ALNUM_RE = re.compile(r"[^a-z0-9\s]")


def clean_text(value: str | None) -> str:
    """Unescape entities, strip control characters and collapse whitespace."""
    if not value:
        return ""
    text = html.unescape(str(value))
    text = text.replace(" ", " ").replace("​", "")
    text = "".join(ch for ch in text if ch == "\n" or ch == "\t" or unicodedata.category(ch)[0] != "C")
    return _WS_RE.sub(" ", text).strip()


def strip_accents(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def normalize_company_name(name: str | None) -> str:
    """Casefold, drop punctuation and legal suffixes, collapse whitespace.

    ``"The Smile Studio (Newcastle) Ltd."`` -> ``"smile studio newcastle"``
    """
    text = clean_text(name)
    if not text:
        return ""
    text = strip_accents(text).lower()
    text = text.replace("&", " and ")
    text = re.sub(r"\bt/?a\b", " ", text)
    text = _NON_ALNUM_RE.sub(" ", text)
    tokens = [t for t in text.split() if t]
    while tokens and tokens[-1] in LEGAL_SUFFIXES:
        tokens.pop()
    tokens = [t for t in tokens if t not in LEGAL_SUFFIXES]
    if not tokens:
        # Name was nothing but suffixes - fall back to the punctuation-stripped form.
        tokens = [t for t in _NON_ALNUM_RE.sub(" ", strip_accents(text).lower()).split() if t]
    meaningful = [t for t in tokens if t not in GENERIC_NAME_WORDS]
    return " ".join(meaningful or tokens)


def name_tokens(name: str | None) -> set[str]:
    return {t for t in normalize_company_name(name).split() if len(t) > 1}


def normalize_phone(raw: str | None, country: str = "UK") -> str | None:
    """Return an E.164-style phone string, or ``None`` when implausible."""
    if not raw:
        return None
    text = clean_text(raw)
    # Keep a leading + but drop every other non-digit (extensions included).
    text = re.sub(r"(?<!^)\+", "", text)
    has_plus = text.startswith("+")
    digits = re.sub(r"\D", "", text)
    if not digits:
        return None

    cc = _country_calling_code(country)
    if has_plus:
        normalized = "+" + digits
    elif digits.startswith("00"):
        normalized = "+" + digits[2:]
    elif cc and digits.startswith("0"):
        normalized = f"+{cc}{digits[1:]}"
    elif cc and digits.startswith(cc) and len(digits) >= 10:
        normalized = "+" + digits
    elif cc:
        normalized = f"+{cc}{digits}"
    else:
        normalized = "+" + digits

    body = normalized[1:]
    if len(body) < 8 or len(body) > 15:
        return None
    if len(set(body)) <= 1:
        return None
    return normalized


def _country_calling_code(country: str | None) -> str | None:
    if not country:
        return None
    key = country.strip().lower()
    codes = {
        "uk": "44",
        "gb": "44",
        "united kingdom": "44",
        "great britain": "44",
        "ie": "353",
        "ireland": "353",
        "us": "1",
        "usa": "1",
        "united states": "1",
        "ca": "1",
        "canada": "1",
        "au": "61",
        "australia": "61",
        "nz": "64",
        "new zealand": "64",
        "de": "49",
        "germany": "49",
        "fr": "33",
        "france": "33",
        "es": "34",
        "spain": "34",
        "nl": "31",
        "netherlands": "31",
    }
    return codes.get(key)


def phone_digits(raw: str | None, country: str = "UK") -> str | None:
    """Last 9 significant digits - a robust key for matching."""
    normalized = normalize_phone(raw, country)
    if not normalized:
        return None
    return normalized[1:][-9:]


def normalize_url(url: str | None, *, keep_path: bool = True, strip_tracking: bool = True) -> str | None:
    """Canonicalise a URL: scheme, lowercase host, no ``www.``, no tracking params."""
    if not url:
        return None
    raw = clean_text(url)
    if not raw or raw.lower() in {"n/a", "none", "-"}:
        return None
    if raw.startswith("//"):
        raw = "https:" + raw
    if not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", raw):
        if raw.startswith(("mailto:", "tel:", "javascript:", "#")):
            return None
        raw = "https://" + raw
    try:
        parts = urlsplit(raw)
    except ValueError:
        return None
    if parts.scheme not in {"http", "https"}:
        return None
    host = (parts.hostname or "").lower().strip(".")
    if not host or "." not in host:
        return None
    if host.startswith("www."):
        host = host[4:]
    netloc = host
    if parts.port and parts.port not in (80, 443):
        netloc = f"{host}:{parts.port}"

    path = parts.path if keep_path else ""
    if path in ("/",):
        path = ""
    path = re.sub(r"/{2,}", "/", path).rstrip("/")

    query = ""
    if keep_path and parts.query:
        pairs = [
            (k, v)
            for k, v in parse_qsl(parts.query, keep_blank_values=True)
            if not (strip_tracking and k.lower() in TRACKING_PARAMS)
        ]
        query = urlencode(pairs)
    if query and not path:
        path = "/"  # keep "https://host/?q=1" rather than "https://host?q=1"

    return urlunsplit((parts.scheme, netloc, path, query, ""))


def extract_domain(url: str | None) -> str | None:
    """Hostname without ``www.`` - the primary dedupe key for a business."""
    normalized = normalize_url(url, keep_path=False)
    if not normalized:
        return None
    host = urlsplit(normalized).hostname or ""
    return host or None


def root_domain(url_or_host: str | None) -> str | None:
    """Best-effort registrable domain (handles common multi-part UK TLDs)."""
    host = extract_domain(url_or_host) or (url_or_host or "").lower().strip()
    if not host or "." not in host:
        return None
    parts = host.split(".")
    multi = {"co", "org", "ac", "gov", "net", "ltd", "plc", "me", "sch"}
    if len(parts) >= 3 and parts[-2] in multi and len(parts[-1]) == 2:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def normalize_postcode(value: str | None) -> str | None:
    """Return a canonical UK postcode (``NE1 4ST``) when one is present."""
    if not value:
        return None
    match = UK_POSTCODE_RE.search(clean_text(value).upper())
    if not match:
        return None
    return f"{match.group(1).upper()} {match.group(2).upper()}"


def postcode_outward(value: str | None) -> str | None:
    postcode = normalize_postcode(value)
    if not postcode:
        return None
    return postcode.split(" ")[0]


def normalize_address(value: str | None) -> str:
    """Lowercase, de-punctuate and abbreviate an address for comparison."""
    text = clean_text(value)
    if not text:
        return ""
    text = strip_accents(text).lower()
    text = text.replace(",", " ")
    text = _NON_ALNUM_RE.sub(" ", text)
    tokens = text.split()
    mapped = [ADDRESS_ABBREVIATIONS.get(tok, tok) for tok in tokens]
    return " ".join(mapped)


def address_key(address: str | None, postcode: str | None = None) -> str | None:
    """A comparable key: building number + first street token + postcode."""
    normalized = normalize_address(address)
    pc = normalize_postcode(postcode) or normalize_postcode(address)
    if not normalized and not pc:
        return None
    tokens = normalized.split()
    number = next((t for t in tokens if t.isdigit()), "")
    street = next((t for t in tokens if t.isalpha() and len(t) > 2), "")
    parts = [p for p in (number, street, pc or "") if p]
    key = " ".join(parts).strip()
    return key or None


def normalize_email(value: str | None) -> str | None:
    """Trim wrappers and trailing punctuation, lowercase the domain.

    Deliberately conservative: characters that are legal in a local part
    (a leading dot, for instance) are left alone so an invalid address stays
    invalid instead of being silently rewritten into a different one.
    """
    if not value:
        return None
    text = clean_text(value).strip().strip("<>").strip()
    if text.lower().startswith("mailto:"):
        text = text[7:]
    text = text.split("?")[0]
    text = text.lstrip("([{'\"").rstrip(".,;:'\")]}>")
    if not text or "@" not in text:
        return None
    local, _, domain = text.rpartition("@")
    if not local or not domain:
        return None
    return f"{local}@{domain.lower()}"


def slugify(value: str | None) -> str:
    text = strip_accents(clean_text(value)).lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text


def title_case_company(value: str | None) -> str:
    """Tidy an ALL-CAPS or all-lowercase company name without mangling acronyms."""
    text = clean_text(value)
    if not text:
        return ""
    if text.isupper() or text.islower():
        words = []
        for word in text.split():
            if len(word) <= 3 and word.isalpha() and text.isupper():
                words.append(word.upper())
            else:
                words.append(word.capitalize())
        return " ".join(words)
    return text


def parse_address_components(formatted_address: str | None, country_hint: str = "UK") -> dict[str, str | None]:
    """Split a one-line formatted address into city / postcode / region / country."""
    result: dict[str, str | None] = {
        "address": None,
        "city": None,
        "postcode": None,
        "region": None,
        "country": None,
    }
    text = clean_text(formatted_address)
    if not text:
        return result
    result["address"] = text
    result["postcode"] = normalize_postcode(text)

    parts = [clean_text(p) for p in text.split(",") if clean_text(p)]
    if not parts:
        return result

    known_countries = {
        "uk": "UK",
        "u.k.": "UK",
        "united kingdom": "UK",
        "england": "UK",
        "scotland": "UK",
        "wales": "UK",
        "northern ireland": "UK",
        "ireland": "Ireland",
    }
    tail = parts[-1].lower()
    if tail in known_countries:
        result["country"] = known_countries[tail]
        parts = parts[:-1]
    else:
        result["country"] = country_hint

    # The postcode usually sits in the final remaining chunk, often with the city.
    if parts:
        last = parts[-1]
        pc = normalize_postcode(last)
        if pc:
            without_pc = UK_POSTCODE_RE.sub("", last).strip(" ,")
            if without_pc:
                result["city"] = clean_text(without_pc)
                parts = parts[:-1]
            else:
                parts = parts[:-1]
                if parts:
                    result["city"] = parts[-1]
                    parts = parts[:-1]
        else:
            result["city"] = last
            parts = parts[:-1]

    if parts and not result["region"]:
        candidate = parts[-1]
        if result["city"] and candidate.lower() != result["city"].lower() and len(parts) >= 2:
            result["region"] = candidate
    return result


# --------------------------------------------------------------------------
# Fuzzy matching (stdlib only)
# --------------------------------------------------------------------------
def ratio(a: str, b: str) -> float:
    """Similarity in ``[0, 1]`` using difflib."""
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    return SequenceMatcher(None, a, b).ratio()


def token_sort_ratio(a: str, b: str) -> float:
    return ratio(" ".join(sorted(a.split())), " ".join(sorted(b.split())))


def token_set_ratio(a: str, b: str) -> float:
    """Order-insensitive similarity that tolerates extra words on one side."""
    tokens_a = set(a.split())
    tokens_b = set(b.split())
    if not tokens_a or not tokens_b:
        return 0.0
    intersection = sorted(tokens_a & tokens_b)
    rest_a = sorted(tokens_a - tokens_b)
    rest_b = sorted(tokens_b - tokens_a)
    combined_a = " ".join(intersection + rest_a).strip()
    combined_b = " ".join(intersection + rest_b).strip()
    base = " ".join(intersection).strip()
    return max(
        ratio(base, combined_a) if base else 0.0,
        ratio(base, combined_b) if base else 0.0,
        ratio(combined_a, combined_b),
    )


def company_name_similarity(a: str | None, b: str | None) -> float:
    """Similarity between two company names after normalization."""
    na, nb = normalize_company_name(a), normalize_company_name(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    tokens_a, tokens_b = set(na.split()), set(nb.split())
    if tokens_a and tokens_b and (tokens_a <= tokens_b or tokens_b <= tokens_a):
        # One name is a strict subset of the other ("smile studio" vs
        # "smile studio newcastle") - treat as a strong but not perfect match.
        return max(0.93, token_set_ratio(na, nb))
    return max(token_set_ratio(na, nb), token_sort_ratio(na, nb))


def dedupe_preserve_order(values: Iterable[str | None]) -> list[str]:
    seen: dict[str, None] = {}
    for value in values:
        if not value:
            continue
        key = value.strip()
        if key and key not in seen:
            seen[key] = None
    return list(seen)
