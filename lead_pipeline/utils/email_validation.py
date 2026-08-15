"""Business email discovery hygiene.

Policy encoded here (see README "Compliance"):

* only syntactically valid addresses survive;
* generic / role-based business inboxes are the accepted outreach targets;
* addresses that look like a named individual are captured but marked
  ``accept_for_outreach = False`` unless the operator explicitly opts in via
  ``ALLOW_NAMED_CONTACT_EMAILS`` **and** the address was published as the
  business contact on the company's own domain;
* nothing is ever guessed - an address must have been observed verbatim.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .normalization import normalize_email, root_domain

# Deliberately pragmatic rather than full RFC 5322.
EMAIL_SYNTAX_RE = re.compile(
    r"^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@"
    r"(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$"
)

GENERIC_LOCAL_PARTS = {
    "info",
    "hello",
    "hi",
    "enquiries",
    "enquiry",
    "enquire",
    "inquiries",
    "sales",
    "bookings",
    "booking",
    "book",
    "office",
    "contact",
    "contactus",
    "mail",
    "email",
    "reception",
    "team",
    "admin",
    "ask",
    "appointments",
    "appointment",
    "reservations",
    "quotes",
    "quote",
    "estimating",
    "newpatients",
    "newbusiness",
    "clinic",
    "practice",
    "studio",
    "shop",
    "orders",
    "help",
    "support",
    "service",
    "customerservice",
    "care",
    "general",
}

ROLE_LOCAL_PARTS = {
    "sales",
    "support",
    "admin",
    "accounts",
    "accounting",
    "billing",
    "finance",
    "marketing",
    "hr",
    "recruitment",
    "careers",
    "jobs",
    "press",
    "media",
    "legal",
    "compliance",
    "webmaster",
    "postmaster",
    "hostmaster",
    "abuse",
    "security",
    "noreply",
    "no-reply",
    "donotreply",
    "manager",
    "director",
    "reception",
    "service",
    "help",
    "customerservice",
    "orders",
    "purchasing",
    "estimating",
}

FREE_PROVIDERS = {
    "gmail.com",
    "googlemail.com",
    "yahoo.com",
    "yahoo.co.uk",
    "ymail.com",
    "hotmail.com",
    "hotmail.co.uk",
    "outlook.com",
    "live.com",
    "live.co.uk",
    "msn.com",
    "aol.com",
    "icloud.com",
    "me.com",
    "mac.com",
    "btinternet.com",
    "sky.com",
    "virginmedia.com",
    "talktalk.net",
    "protonmail.com",
    "proton.me",
    "gmx.com",
    "mail.com",
    "zoho.com",
}

# Addresses that belong to tooling / examples rather than the business.
BLOCKED_DOMAINS = {
    "example.com",
    "example.org",
    "example.net",
    "domain.com",
    "yourdomain.com",
    "email.com",
    "sentry.io",
    "sentry-next.wixpress.com",
    "wixpress.com",
    "wordpress.com",
    "wordpress.org",
    "squarespace.com",
    "godaddy.com",
    "cloudflare.com",
    "schema.org",
    "w3.org",
    "jquery.com",
    "googleapis.com",
    "gstatic.com",
    "sentry.wixpress.com",
}

BLOCKED_LOCAL_PATTERNS = (
    re.compile(r"^[0-9a-f]{16,}$"),  # hashed / tracking pseudo-addresses
    re.compile(r"\.(png|jpe?g|gif|webp|svg|css|js|woff2?)$", re.IGNORECASE),
    re.compile(r"^(user|username|your|youremail|name|test|sample|placeholder)$", re.IGNORECASE),
    re.compile(r"@\d+x$", re.IGNORECASE),
    re.compile(r"^sentry", re.IGNORECASE),
    re.compile(r"^wordpress", re.IGNORECASE),
)

# Very common UK/EN first names - used only to flag *likely personal* addresses
# so we can exclude them by default. Never used to construct an address.
COMMON_FIRST_NAMES = {
    "adam", "alan", "alex", "alexandra", "alice", "amanda", "amy", "andrea", "andrew", "andy",
    "anna", "anne", "anthony", "ben", "benjamin", "beth", "bill", "bob", "brian", "carl",
    "carol", "caroline", "catherine", "charlie", "charlotte", "chris", "christine", "christopher",
    "claire", "colin", "craig", "dan", "daniel", "danielle", "darren", "dave", "david", "dean",
    "debbie", "diane", "dominic", "donna", "ed", "eddie", "edward", "elaine", "eleanor", "ellie",
    "emily", "emma", "eric", "fiona", "frank", "gareth", "gary", "gavin", "gemma", "george",
    "gerry", "gillian", "gordon", "graham", "grace", "hannah", "harry", "hayley", "heather",
    "helen", "holly", "ian", "jack", "jackie", "jake", "james", "jamie", "jane", "janet",
    "jason", "jay", "jean", "jeff", "jenny", "jess", "jessica", "jill", "jim", "jo", "joanne",
    "joe", "john", "jon", "jonathan", "jordan", "joseph", "josh", "joshua", "julia", "julie",
    "justin", "karen", "kate", "katie", "keith", "kelly", "ken", "kevin", "kim", "kirsty",
    "laura", "lauren", "lee", "leigh", "lewis", "linda", "lisa", "liz", "louise", "lucy",
    "luke", "maria", "mark", "martin", "mary", "matt", "matthew", "megan", "mel", "melissa",
    "michael", "michelle", "mike", "nathan", "neil", "nicola", "nick", "nicole", "nigel",
    "oliver", "olivia", "owen", "patrick", "paul", "paula", "pete", "peter", "philip", "phil",
    "rachel", "rebecca", "rich", "richard", "rob", "robert", "robin", "roger", "ross", "roy",
    "russell", "ruth", "ryan", "sally", "sam", "samantha", "sandra", "sara", "sarah", "scott",
    "sean", "shane", "sharon", "shaun", "simon", "sophie", "stephen", "steve", "steven",
    "stuart", "sue", "susan", "tanya", "terry", "tim", "tina", "tom", "tony", "tracey",
    "tracy", "vicky", "victoria", "vincent", "wayne", "will", "william", "zoe",
}

_NAME_PATTERN_RE = re.compile(r"^[a-z]{2,}[._-][a-z]{2,}$")


@dataclass
class EmailAssessment:
    """The verdict on one discovered address."""

    email: str
    local_part: str = ""
    domain: str = ""
    valid_syntax: bool = False
    is_generic: bool = False
    is_role_based: bool = False
    is_free_provider: bool = False
    matches_company_domain: bool = False
    is_likely_personal: bool = False
    is_blocked: bool = False
    category: str = "invalid"
    accept_for_outreach: bool = False
    reason: str = ""
    source: str | None = None
    source_url: str | None = None
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, object]:
        return {
            "email": self.email,
            "local_part": self.local_part,
            "domain": self.domain,
            "valid_syntax": self.valid_syntax,
            "is_generic": self.is_generic,
            "is_role_based": self.is_role_based,
            "is_free_provider": self.is_free_provider,
            "matches_company_domain": self.matches_company_domain,
            "is_likely_personal": self.is_likely_personal,
            "category": self.category,
            "accept_for_outreach": self.accept_for_outreach,
            "reason": self.reason,
            "source": self.source,
            "source_url": self.source_url,
        }


def validate_email_syntax(email: str | None) -> bool:
    normalized = normalize_email(email)
    if not normalized:
        return False
    if len(normalized) > 254:
        return False
    local, _, domain = normalized.rpartition("@")
    if local.startswith(".") or local.endswith(".") or ".." in local:
        return False
    if domain.startswith("-") or domain.endswith("-"):
        return False
    return bool(EMAIL_SYNTAX_RE.match(normalized))


def classify_email(
    email: str | None,
    *,
    company_domain: str | None = None,
    allow_named_contacts: bool = False,
    source: str | None = None,
    source_url: str | None = None,
) -> EmailAssessment:
    """Normalize, validate and categorise a discovered email address."""
    normalized = normalize_email(email)
    if not normalized:
        return EmailAssessment(
            email=str(email or ""), category="invalid", reason="Not a parseable email address", source=source
        )

    assessment = EmailAssessment(email=normalized, source=source, source_url=source_url)
    local, _, domain = normalized.rpartition("@")
    assessment.local_part = local.lower()
    assessment.domain = domain.lower()
    assessment.valid_syntax = validate_email_syntax(normalized)

    if not assessment.valid_syntax:
        assessment.category = "invalid"
        assessment.reason = "Failed syntax validation"
        return assessment

    if assessment.domain in BLOCKED_DOMAINS or any(
        p.search(assessment.local_part) for p in BLOCKED_LOCAL_PATTERNS
    ):
        assessment.is_blocked = True
        assessment.category = "blocked"
        assessment.reason = "Address belongs to tooling/placeholder content, not the business"
        return assessment

    base_local = re.sub(r"[0-9]+$", "", assessment.local_part)
    assessment.is_generic = base_local in GENERIC_LOCAL_PARTS
    assessment.is_role_based = base_local in ROLE_LOCAL_PARTS
    assessment.is_free_provider = assessment.domain in FREE_PROVIDERS

    company_root = root_domain(company_domain) if company_domain else None
    email_root = root_domain(assessment.domain)
    assessment.matches_company_domain = bool(company_root and email_root and company_root == email_root)

    assessment.is_likely_personal = _looks_personal(base_local) and not (
        assessment.is_generic or assessment.is_role_based
    )

    if assessment.is_generic:
        assessment.category = "generic_business"
        assessment.accept_for_outreach = True
        assessment.reason = "Generic business inbox published for enquiries"
    elif assessment.is_role_based:
        assessment.category = "role_based"
        assessment.accept_for_outreach = True
        assessment.reason = "Role-based business inbox"
    elif assessment.is_likely_personal:
        assessment.category = "named_individual"
        assessment.accept_for_outreach = bool(allow_named_contacts and assessment.matches_company_domain)
        assessment.reason = (
            "Named individual on the company domain; included because ALLOW_NAMED_CONTACT_EMAILS is on"
            if assessment.accept_for_outreach
            else "Looks like a named individual - excluded from outreach by policy"
        )
    elif assessment.matches_company_domain:
        assessment.category = "company_domain"
        assessment.accept_for_outreach = True
        assessment.reason = "Business address on the company's own domain"
    elif assessment.is_free_provider:
        assessment.category = "free_provider_business"
        assessment.accept_for_outreach = True
        assessment.reason = "Free-provider address published as the business contact"
    else:
        assessment.category = "other_business"
        assessment.accept_for_outreach = True
        assessment.reason = "Publicly published business address"

    return assessment


def _looks_personal(local_part: str) -> bool:
    if _NAME_PATTERN_RE.match(local_part):
        first = re.split(r"[._-]", local_part)[0]
        return first in COMMON_FIRST_NAMES or len(local_part) >= 7
    if local_part in COMMON_FIRST_NAMES:
        return True
    for name in COMMON_FIRST_NAMES:
        if len(name) >= 4 and local_part.startswith(name) and len(local_part) - len(name) <= 12:
            remainder = local_part[len(name) :]
            if remainder and remainder.isalpha():
                return True
    return False


def pick_primary_email(assessments: list[EmailAssessment]) -> EmailAssessment | None:
    """Choose the best outreach address from a set of discovered ones."""
    acceptable = [a for a in assessments if a.accept_for_outreach]
    if not acceptable:
        return None
    priority = {
        "generic_business": 0,
        "company_domain": 1,
        "role_based": 2,
        "other_business": 3,
        "free_provider_business": 4,
        "named_individual": 5,
    }
    return sorted(
        acceptable,
        key=lambda a: (priority.get(a.category, 9), 0 if a.matches_company_domain else 1, len(a.email)),
    )[0]


EMAIL_IN_TEXT_RE = re.compile(
    r"[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}"
)


def extract_emails(text: str | None) -> list[str]:
    """Pull candidate addresses out of a blob of page text/HTML."""
    if not text:
        return []
    found: dict[str, None] = {}
    for match in EMAIL_IN_TEXT_RE.findall(text):
        normalized = normalize_email(match)
        if normalized:
            found.setdefault(normalized, None)
    return list(found)
