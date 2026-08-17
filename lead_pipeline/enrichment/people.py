"""Named business contacts published on a company's own website.

Local businesses routinely publish who runs them - "Meet the team", "About us",
a director's name in the footer, a `Person` entry in structured data. That is
public business information, and knowing whether to address an approach to the
practice principal or the marketing manager is the difference between a useful
lead and a name on a list.

What this module will and will not do:

* It reads only pages the site publishes and robots.txt allows. Fetching is the
  caller's job; this module is pure parsing.
* A name is recorded **only** when the page states a business role next to it.
  A capitalised phrase on its own is not evidence of anything, and inferring a
  person from one would be fabrication.
* Only decision-maker roles are collected - owner, director, principal, partner,
  practice/marketing manager and the like. Clinical, reception and junior staff
  are deliberately skipped: they are not who an agency pitches, and collecting a
  full staff directory would gather personal data the pipeline has no use for.
* Every mention keeps the URL it came from and the exact published text it was
  read from, so any claim can be traced back and checked.
* At most :data:`MAX_PEOPLE_PER_SITE` people are kept per business.

Nothing here contacts anybody. It records who a human should address, and stops.
"""

from __future__ import annotations

import json
import re
from typing import TYPE_CHECKING, Iterable

from ..models import PersonMention
from ..utils.normalization import clean_text, normalize_company_name

if TYPE_CHECKING:  # pragma: no cover - import cycle guard
    from .seo import ParsedDocument

__all__ = [
    "MAX_PEOPLE_PER_SITE",
    "best_contact",
    "dedupe_people",
    "extract_people",
    "is_role_label",
    "looks_like_person_name",
    "match_role",
]

MAX_PEOPLE_PER_SITE = 5

# Longest patterns first: "managing director" must win over "director", and
# "practice manager" over "manager". Seniority drives which contact we surface.
ROLE_DEFINITIONS: tuple[tuple[str, str, int], ...] = (
    # --- ownership and board (1) ---
    (r"co[-\s]?founder(?:\s*&\s*(?:ceo|director|md))?", "Co-Founder", 1),
    (r"founder(?:\s*(?:&|and)\s*(?:ceo|owner|director|md))?", "Founder", 1),
    (r"(?:business|company|practice|salon|clinic|studio|garage|gym)?\s*owner", "Owner", 1),
    (r"proprietor", "Proprietor", 1),
    (r"managing\s+director", "Managing Director", 1),
    (r"(?:chief\s+executive(?:\s+officer)?|ceo)", "Chief Executive", 1),
    (r"(?:managing|senior|equity|founding)?\s*partner", "Partner", 1),
    (r"director", "Director", 1),
    # --- clinical / professional leadership (2) ---
    (r"clinical\s+director", "Clinical Director", 2),
    (r"medical\s+director", "Medical Director", 2),
    (r"principal\s+(?:dentist|solicitor|optometrist|vet|surgeon|physiotherapist|osteopath)",
     "Principal Practitioner", 2),
    (r"(?:practice\s+)?principal", "Principal", 2),
    (r"head\s+of\s+(?:practice|clinic|surgery)", "Head of Practice", 2),
    (r"lead\s+(?:dentist|clinician|practitioner|surgeon|installer|engineer)", "Lead Practitioner", 2),
    # --- running the business day to day (3) ---
    (r"practice\s+manager", "Practice Manager", 3),
    (r"general\s+manager", "General Manager", 3),
    (r"operations\s+(?:director|manager|lead)", "Operations Manager", 3),
    (r"business\s+(?:development\s+)?manager", "Business Manager", 3),
    (r"(?:clinic|salon|studio|centre|center|branch|site)\s+manager", "Clinic Manager", 3),
    (r"office\s+manager", "Office Manager", 3),
    # --- the person who would brief an agency (4) ---
    (r"(?:head\s+of\s+)?marketing\s*(?:director|manager|lead|executive)?", "Marketing Lead", 4),
    (r"head\s+of\s+(?:growth|digital|sales)", "Growth Lead", 4),
)

ROLE_PATTERNS: tuple[tuple[re.Pattern[str], str, int], ...] = tuple(
    (re.compile(rf"\b{pattern}\b", re.IGNORECASE), label, rank)
    for pattern, label, rank in ROLE_DEFINITIONS
)

HONORIFICS = {
    "dr", "dr.", "mr", "mr.", "mrs", "mrs.", "ms", "ms.", "miss", "prof", "prof.",
    "professor", "sir", "dame", "rev", "rev.",
}

SUFFIXES = {"jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "bds", "mba", "bsc", "msc", "phd"}

# "Newcastle upon Tyne", "Weston super Mare", "Bourton on the Water". Place names
# have the shape of a person's name and appear all over a local business site -
# a multi-location page listing a town above a manager's title would otherwise
# invent a person called Newcastle Upon Tyne. No surname contains these; the
# genuine name particles (de, van, von, della, mac) are deliberately absent.
PLACE_CONNECTIVES = {"upon", "under", "super", "cum", "juxta", "next", "in", "on", "by"}

# Lowercase particles that are genuinely part of a surname. Without these,
# "Maria de Souza" and "Jan van Dijk" fail the capitalisation rule and their
# owners silently never appear as contacts.
NAME_PARTICLES = {
    "de", "del", "della", "de-la", "da", "das", "dos", "di", "du", "la", "le",
    "van", "von", "der", "den", "ten", "ter", "bin", "bint", "al", "el",
    "mac", "mc", "st", "ap", "ibn",
}

# A name token may never be one of these. Team pages are full of headings and
# service words that pattern-match a name shape but are not people.
NON_NAME_WORDS = frozenset(
    """
    about academy accounts advice aesthetic aesthetics agency all alliance and appointment
    appointments approved architects area associates auto automotive available award awards
    back beauty best blog book booking bookings brand branch bridal build builders building
    business call care careers centre center certified charity check childrens choose city
    clean cleaning clinic clinics clinical club company complaints consultancy consultant
    consultation consultations contact contractors cookie cookies core corporate cosmetic
    cost costs county cover covid customer customers dental dentist dentistry dentists design
    developments digital directions directory discover doctors dog domestic drive east email
    emergency energy engineering enquire enquiries enquiry equipment estate excellence expert
    experts facebook family faq faqs fees finance financial find finish fitness fitted fitting
    free friendly from front full furniture gallery garage garden general get gift group
    growth guarantee guide gym hair health healthcare heating hello help hire holistic home
    hours house how implants industries info information insight installation installations
    instagram insurance interiors introducing joinery journal kitchen kitchens landing law
    leading learn legal letting lettings library limited link linkedin list living local
    location locations login london ltd luxury made maintenance make management manufacturing
    map maps market marketing massage media medical meet member members membership menu
    mission mobile modern more mortgage motor national natural near new news newsletter next
    north offer offers office online open opening operations opticians options order our out
    packages page pages partners patient patients pay payment payments people performance
    personal pet pharmacy phone photo photography physio physiotherapy plan planning plans
    please plumbing policy portfolio practice premium press price prices pricing privacy
    private products professional profile project projects properties property provider
    quality question questions quote quotes range rated rates read ready reception recruitment
    refer referral register removal removals repair repairs request reserve residential
    resources results retail review reviews right roofing room rooms safety sales salon save
    school search see self service services shop show sign signature site skin sleep small
    smile social solicitors solutions south space spa specialist specialists sports staff
    start started state stories story studio studios style success support surgery survey
    sustainable systems talk team teeth terms testimonial testimonials the therapy time
    tips today total tours town trade trading training transport travel treatment treatments
    trust twitter uk unit united updates upvc us value values vehicle vets veterinary video
    view virtual visit vision walk want warranty water way we website wedding welcome
    wellbeing wellness west what where whitening who why windows with work works workshop
    world write year years yoga you your
    """.split()
)

# Splits "Jane Smith - Practice Manager" into its two halves.
SEPARATOR = re.compile(r"\s*(?:[-‐-―−|/·•]|:|,)\s*")

NAME_TOKEN = re.compile(r"^[A-Z][A-Za-z'’]*(?:-[A-Z][A-Za-z'’]*)*$")
INITIAL_TOKEN = re.compile(r"^[A-Z]\.?$")
ALL_CAPS = re.compile(r"^[A-Z][A-Z'’-]+$")

# "our practice manager Jane Smith" / "Jane Smith, our managing director"
ROLE_ALTERNATION = "|".join(pattern for pattern, _, _ in ROLE_DEFINITIONS)
ROLE_THEN_NAME = re.compile(
    rf"\b(?:our|the|meet(?:\s+our)?|led\s+by|owned\s+by|run\s+by)\s+"
    rf"(?P<role>{ROLE_ALTERNATION})\s*,?\s+"
    rf"(?P<name>(?:[A-Z][\w'’-]+\s+){{1,3}}[A-Z][\w'’-]+)",
    re.IGNORECASE,
)
NAME_THEN_ROLE = re.compile(
    rf"(?P<name>(?:[A-Z][\w'’-]+\s+){{1,3}}[A-Z][\w'’-]+)\s*,\s*"
    rf"(?:our|the)?\s*(?P<role>{ROLE_ALTERNATION})\b",
)

JSON_LD_BLOCK = re.compile(
    r"<script[^>]+application/ld\+json[^>]*>(.*?)</script>", re.IGNORECASE | re.DOTALL
)

MAX_BLOCK_CHARS = 120


# ---------------------------------------------------------------------------
# Name validation
# ---------------------------------------------------------------------------
def _strip_affixes(tokens: list[str]) -> list[str]:
    while tokens and tokens[0].lower().rstrip(".") in {h.rstrip(".") for h in HONORIFICS}:
        tokens = tokens[1:]
    while tokens and tokens[-1].lower().rstrip(".") in {s.rstrip(".") for s in SUFFIXES}:
        tokens = tokens[:-1]
    return tokens


def looks_like_person_name(
    candidate: str, *, company_name: str = "", locality: str = ""
) -> str | None:
    """Return the normalised name, or ``None`` if this is not a person's name.

    Strict by design. A false positive puts a made-up contact in front of a
    salesperson, which is worse than no contact at all. ``company_name`` and
    ``locality`` are what the pipeline already knows about this business, used
    to reject a trading name or a town that happens to read like a person.
    """
    text = clean_text(candidate or "").strip(" .,-–—|")
    if not text or len(text) > 60:
        return None
    if any(character.isdigit() for character in text) or "@" in text or "/" in text:
        return None

    tokens = _strip_affixes(text.split())
    if not 2 <= len(tokens) <= 4:
        return None
    if any(token.lower().strip(".,") in PLACE_CONNECTIVES for token in tokens[1:-1]):
        return None

    normalised: list[str] = []
    for position, token in enumerate(tokens):
        bare = token.strip(".,").replace("'", "").replace("’", "")
        if not bare:
            return None
        if bare.lower() in NON_NAME_WORDS:
            return None
        if INITIAL_TOKEN.match(token):
            normalised.append(token if token.endswith(".") else f"{token}.")
            continue
        # A surname particle skips the capital rule but keeps the casing the
        # person uses - "de Souza" and "Mac Donald" are both written correctly
        # already. It may only appear inside the name, never at either end.
        if bare.lower() in NAME_PARTICLES and 0 < position < len(tokens) - 1:
            normalised.append(token.strip(".,"))
            continue
        if len(bare) < 2:
            return None
        if ALL_CAPS.match(token):
            # "JANE SMITH" is a styling choice, not a different name.
            token = token.title()
        if not NAME_TOKEN.match(token.strip(".,")):
            return None
        normalised.append(token.strip(".,"))

    if all(INITIAL_TOKEN.match(token) for token in normalised):
        return None

    name = " ".join(normalised)

    name_tokens = {token.lower().strip(".") for token in normalised}

    # A business trading under a personal name ("Smith & Sons Roofing") must not
    # be mistaken for a person we can address.
    if company_name:
        company_tokens = set(normalize_company_name(company_name).split())
        if name_tokens and name_tokens <= company_tokens:
            return None

    # Nor may the town the business sits in.
    if locality:
        locality_tokens = {word.lower().strip(".,") for word in locality.split()}
        if name_tokens and name_tokens <= locality_tokens:
            return None

    # A role hiding inside the name means the split went wrong.
    if match_role(name):
        return None
    return name


def is_role_label(text: str) -> bool:
    """Is this text a job title, as opposed to a sentence that mentions one?

    A team card puts a short label under a name - "Practice Manager", "Founder &
    MD". Body copy also contains role words ("Our Director of Operations
    oversees every job") but pairing that with the heading above it invents a
    person out of whatever words happened to sit there. Requiring a label shape
    fixes that structurally, rather than by adding more words to a blacklist
    that can never be complete.
    """
    stripped = (text or "").strip()
    if not stripped or len(stripped) > 50:
        return False
    if stripped.rstrip()[-1] in ".!?":
        return False
    return len(stripped.split()) <= 6 and match_role(stripped) is not None


def match_role(text: str) -> tuple[str, int] | None:
    """Return ``(canonical role, seniority)`` for the most senior role in *text*."""
    if not text or len(text) > MAX_BLOCK_CHARS:
        return None
    best: tuple[str, int] | None = None
    for pattern, label, rank in ROLE_PATTERNS:
        if pattern.search(text):
            if best is None or rank < best[1]:
                best = (label, rank)
    return best


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------
def _mention(
    name: str, role: tuple[str, int], url: str, evidence: str
) -> PersonMention:
    return PersonMention(
        name=name,
        role=role[0],
        role_seniority=role[1],
        source="company_website",
        source_url=url or None,
        evidence=clean_text(evidence)[:200],
    )


def _from_single_block(
    block: str, url: str, company_name: str, locality: str
) -> PersonMention | None:
    """"Jane Smith - Practice Manager" and its many punctuation variants."""
    parts = [part for part in SEPARATOR.split(block) if part.strip()]
    if len(parts) < 2:
        return None
    for index, part in enumerate(parts):
        if not is_role_label(part):
            continue
        role = match_role(part)
        if not role:
            continue
        for other in parts[:index] + parts[index + 1 :]:
            name = looks_like_person_name(other, company_name=company_name, locality=locality)
            if name:
                return _mention(name, role, url, block)
    return None


def _from_adjacent_blocks(
    blocks: list[str], url: str, company_name: str, locality: str
) -> list[PersonMention]:
    """The standard team-card shape: a name heading, then a role beneath it.

    Pairs are consumed greedily, left to right. Overlapping windows would read
    a run of cards - name, role, name, role - as *both* "name then role" and
    "role then name", attaching each card's job title to the next card's person.
    Once two blocks are paired, neither can pair again.
    """
    found: list[PersonMention] = []
    index = 0
    while index < len(blocks) - 1:
        first, second = blocks[index], blocks[index + 1]
        first_role = match_role(first) if is_role_label(first) else None
        second_role = match_role(second) if is_role_label(second) else None
        first_name = (
            None if first_role
            else looks_like_person_name(first, company_name=company_name, locality=locality)
        )
        second_name = (
            None if second_role
            else looks_like_person_name(second, company_name=company_name, locality=locality)
        )

        # Name then role is the overwhelmingly common layout; try it first.
        if first_name and second_role:
            found.append(_mention(first_name, second_role, url, f"{first} — {second}"))
            index += 2
            continue
        if first_role and second_name:
            found.append(_mention(second_name, first_role, url, f"{first} — {second}"))
            index += 2
            continue
        index += 1
    return found


def _from_prose(text: str, url: str, company_name: str, locality: str) -> list[PersonMention]:
    """"...run by our practice manager Jane Smith" and the reverse order."""
    found: list[PersonMention] = []
    for pattern in (ROLE_THEN_NAME, NAME_THEN_ROLE):
        for match in pattern.finditer(text):
            role = match_role(match.group("role"))
            if not role:
                continue
            name = looks_like_person_name(
                match.group("name"), company_name=company_name, locality=locality
            )
            if name:
                found.append(_mention(name, role, url, match.group(0)))
    return found


def _from_structured_data(
    html: str, url: str, company_name: str, locality: str
) -> list[PersonMention]:
    """schema.org ``Person`` entries - the site stating this outright."""
    found: list[PersonMention] = []
    for block in JSON_LD_BLOCK.findall(html or ""):
        try:
            payload = json.loads(block)
        except (TypeError, ValueError):
            continue
        for node in _walk_json(payload):
            if not isinstance(node, dict):
                continue
            node_type = node.get("@type")
            types = node_type if isinstance(node_type, list) else [node_type]
            if not any(str(t).lower() == "person" for t in types if t):
                continue
            raw_name = node.get("name")
            raw_role = node.get("jobTitle") or node.get("hasOccupation")
            if isinstance(raw_role, dict):
                raw_role = raw_role.get("name")
            if not isinstance(raw_name, str) or not isinstance(raw_role, str):
                continue
            role = match_role(raw_role)
            name = looks_like_person_name(raw_name, company_name=company_name, locality=locality)
            if role and name:
                found.append(_mention(name, role, url, f"{raw_name} — {raw_role}"))
    return found


def _walk_json(node: object) -> Iterable[object]:
    yield node
    if isinstance(node, dict):
        for value in node.values():
            yield from _walk_json(value)
    elif isinstance(node, list):
        for value in node:
            yield from _walk_json(value)


def extract_people(
    document: "ParsedDocument", *, company_name: str = "", locality: str = ""
) -> list[PersonMention]:
    """Find published decision-makers on one page.

    Four independent readings, strongest evidence first. A page that names
    nobody in a business role yields an empty list, which is the honest answer.
    """
    url = document.url
    mentions: list[PersonMention] = []
    mentions.extend(_from_structured_data(document.html, url, company_name, locality))

    blocks = [b for b in document.blocks if b and len(b) <= MAX_BLOCK_CHARS]
    for block in blocks:
        mention = _from_single_block(block, url, company_name, locality)
        if mention:
            mentions.append(mention)
    mentions.extend(_from_adjacent_blocks(blocks, url, company_name, locality))
    mentions.extend(_from_prose(document.text, url, company_name, locality))

    return dedupe_people(mentions)


def dedupe_people(mentions: Iterable[PersonMention]) -> list[PersonMention]:
    """One entry per person, keeping their most senior stated role."""
    best: dict[str, PersonMention] = {}
    for mention in mentions:
        key = mention.name.lower()
        current = best.get(key)
        if current is None or mention.role_seniority < current.role_seniority:
            best[key] = mention
    return sorted(best.values(), key=lambda m: (m.role_seniority, m.name))


def best_contact(mentions: Iterable[PersonMention]) -> PersonMention | None:
    """The most senior published contact, or ``None`` when nobody was named."""
    ranked = sorted(mentions, key=lambda m: (m.role_seniority, m.name))
    return ranked[0] if ranked else None
