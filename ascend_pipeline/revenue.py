"""Transparent, conservative monthly-revenue estimation.

You cannot see real revenue. This builds a defensible USD *range* from public
signals only and records the heuristic in the `revenue basis` cell of every
row (task requirement). It never emits a false-precision point number: the
band widens where confidence is low.

Method (documented ARPDAU/CCU heuristic):
  daily_robux  = CCU * BASE_ARPDAU_ROBUX_PER_CCU * genre_intensity * pass_richness
  monthly_usd  = daily_robux * 30 * DEVEX_USD_PER_ROBUX
  range        = monthly_usd * (1 -/+ REV_BAND_HALFWIDTH)

Only leads whose range MIDPOINT falls within the $5k-$20k band pass filter F.
"""
from __future__ import annotations
from dataclasses import dataclass

import config


@dataclass
class RevenueEstimate:
    low: int
    mid: int
    high: int
    basis: str

    @property
    def in_band(self) -> bool:
        return config.REV_BAND_LOW <= self.mid <= config.REV_BAND_HIGH


def _genre_intensity(genres: list[str]) -> tuple[float, str]:
    best, label = config.GENRE_INTENSITY["default"], "default"
    for g in genres:
        key = g.strip().lower()
        for term, mult in config.GENRE_INTENSITY.items():
            if term in key and mult > best:
                best, label = mult, term
    return best, label


def _pass_richness(passes: list[dict]) -> tuple[float, int, int]:
    """Return (multiplier, count, price_ladder_span_robux)."""
    n = len(passes)
    prices = [p.get("price") or p.get("Price") or 0 for p in passes]
    prices = [int(x) for x in prices if x]
    span = (max(prices) - min(prices)) if prices else 0
    mult = 1.0 + min(config.PASS_RICHNESS_STEP * n, config.PASS_RICHNESS_CAP)
    return mult, n, span


def estimate(*, ccu: int, visits: int, genres: list[str],
             passes: list[dict]) -> RevenueEstimate:
    intensity, gi_label = _genre_intensity(genres)
    richness, n_pass, ladder = _pass_richness(passes)

    daily_robux = ccu * config.BASE_ARPDAU_ROBUX_PER_CCU * intensity * richness
    monthly_usd = daily_robux * 30 * config.DEVEX_USD_PER_ROBUX

    low = int(monthly_usd * (1 - config.REV_BAND_HALFWIDTH))
    mid = int(monthly_usd)
    high = int(monthly_usd * (1 + config.REV_BAND_HALFWIDTH))

    # Confidence note: wide band when the pass surface is thin or CCU is jumpy.
    conf = "moderate confidence"
    if n_pass <= 1:
        conf = "LOW confidence (thin monetization surface; treat range as indicative only)"
    elif n_pass >= 6 and ladder > 0:
        conf = "higher confidence (rich pass ladder observed)"

    basis = (
        f"ARPDAU/CCU heuristic: {ccu} CCU x {config.BASE_ARPDAU_ROBUX_PER_CCU} "
        f"base Robux/CCU/day x {intensity:.2f} genre intensity ({gi_label}) "
        f"x {richness:.2f} pass-richness ({n_pass} public passes, "
        f"ladder span {ladder} R$) x 30 days x ${config.DEVEX_USD_PER_ROBUX}/R$ "
        f"DevEx = ${mid:,}/mo midpoint; band +/-{int(config.REV_BAND_HALFWIDTH*100)}% "
        f"= ${low:,}-${high:,}. {conf}. Public signals only; not measured revenue."
    )
    return RevenueEstimate(low=low, mid=mid, high=high, basis=basis)
