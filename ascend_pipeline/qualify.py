"""Qualification filters + 0-100 fit score, faithful to the workbook's
Scoring Rubric sheet, plus the hard revenue-band ceiling (filter F).

Rubric weights (from the source workbook `Scoring Rubric`):
  Size fit 0-20 | Current activity 0-18 | Update recency 0-14 |
  Monetization surface 0-13 | Genre fit 0-10 | Contact path 0-10 |
  Audience reception 0-8 | Hiring/live-ops 0-7 | Deprioritizers negative.
Total caps at 100.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from datetime import datetime, timezone

import config
import revenue as revmod


@dataclass
class Screen:
    passed: bool
    reject_reason: str | None = None       # one of the Shortfall categories
    fit_score: int = 0
    estimated_tier: str = ""               # Ideal / Minimum
    priority_tier: str = ""                # P1 / P2 / P3
    rev: revmod.RevenueEstimate | None = None
    parts: dict = field(default_factory=dict)


def _age_days(last_updated: str | None) -> float | None:
    if not last_updated:
        return None
    s = str(last_updated).replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        try:
            dt = datetime.strptime(str(last_updated)[:10], "%Y-%m-%d")
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - dt).total_seconds() / 86400


def _size_points(visits: int) -> int:
    if 20_000_000 <= visits <= 300_000_000:
        return 20
    if 10_000_000 <= visits <= 500_000_000:
        return 16
    if visits >= config.MIN_VISITS:
        return 11
    return 0


def _activity_points(ccu: int) -> int:
    if 500 <= ccu <= 5_000:
        return 18
    if 250 <= ccu <= 10_000:
        return 14
    if ccu >= config.MIN_CCU:
        return 9
    return 0


def _recency_points(age: float | None) -> int:
    if age is None:
        return 0
    if age <= config.BEST_UPDATE_AGE_DAYS:
        return 14
    if age <= 120:
        return 10
    if age <= config.MAX_UPDATE_AGE_DAYS:
        return 6
    return 0


def _monetization_points(n_pass: int) -> int:
    if n_pass >= 8:
        return 13
    if n_pass >= 4:
        return 10
    if n_pass >= 1:
        return 6
    return 0


def _genre_points(genres: list[str]) -> int:
    joined = " ".join(genres).lower()
    return 10 if any(g in joined for g in config.FIT_GENRES) else 3


def _reception_points(votes: dict | None) -> int:
    if not votes:
        return 0
    up, down = votes.get("upVotes", 0), votes.get("downVotes", 0)
    total = up + down
    if total == 0:
        return 0
    ratio = up / total
    if ratio >= 0.90:
        return 8
    if ratio >= 0.80:
        return 6
    if ratio >= 0.70:
        return 4
    return 2


def _liveops_points(roles: list, desc: str) -> int:
    pts = 0
    if roles and len(roles) > 3:
        pts += 4
    if any(t in desc.lower() for t in config.LIVEOPS_TERMS):
        pts += 3
    return min(pts, 7)


def screen(*, visits: int, ccu: int, last_updated: str | None,
           genres: list[str], passes: list[dict], votes: dict | None,
           has_contact_path: bool, roles: list, description: str) -> Screen:
    """Apply hard filters A-F then compute the fit score. Discord (G) is
    resolved separately and gates inclusion after this returns passed=True."""

    # ---- Hard exclusions (mega scale) -----------------------------------
    if visits > config.MEGA_VISITS or ccu > config.MEGA_CCU:
        return Screen(False, "size")   # mega-scale, above band

    # ---- A. size ---------------------------------------------------------
    if visits < config.MIN_VISITS:
        return Screen(False, "size")
    # ---- B. activity -----------------------------------------------------
    if ccu < config.MIN_CCU:
        return Screen(False, "size")
    # ---- C. recency ------------------------------------------------------
    age = _age_days(last_updated)
    if age is None or age > config.MAX_UPDATE_AGE_DAYS:
        return Screen(False, "recency")
    # ---- D. monetization surface ----------------------------------------
    if len(passes) < config.MIN_PUBLIC_PASSES:
        return Screen(False, "monetization")

    # ---- F. revenue band (HARD) -----------------------------------------
    rev = revmod.estimate(ccu=ccu, visits=visits, genres=genres, passes=passes)
    if not rev.in_band:
        return Screen(False, "revenue_band", rev=rev)

    # ---- Fit score (rubric) ---------------------------------------------
    parts = {
        "size": _size_points(visits),
        "activity": _activity_points(ccu),
        "recency": _recency_points(age),
        "monetization": _monetization_points(len(passes)),
        "genre": _genre_points(genres),
        "contact": 10 if has_contact_path else 0,
        "reception": _reception_points(votes),
        "liveops": _liveops_points(roles, description),
    }
    score = min(sum(parts.values()), 100)

    estimated_tier = "Ideal" if score >= 85 else "Minimum"
    priority = "P1" if score >= 85 else ("P2" if score >= 70 else "P3")

    return Screen(True, None, score, estimated_tier, priority, rev, parts)
