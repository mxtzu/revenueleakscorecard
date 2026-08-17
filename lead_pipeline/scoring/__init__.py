"""Lead scoring: niche rules, the 0-100 model and opportunity detection."""

from .lead_score import LeadScorer, qualify
from .niche_rules import NicheAssessment, assess_niche, detect_sub_niche
from .opportunities import (
    AuditRecord,
    build_audit_record,
    build_lead_reason,
    detect_opportunities,
    detect_strengths,
    recommend_service,
)

__all__ = [
    "LeadScorer",
    "qualify",
    "assess_niche",
    "detect_sub_niche",
    "NicheAssessment",
    "detect_opportunities",
    "detect_strengths",
    "build_lead_reason",
    "recommend_service",
    "build_audit_record",
    "AuditRecord",
]
