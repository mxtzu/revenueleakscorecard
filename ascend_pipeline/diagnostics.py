"""Non-generic, observation-driven text for the two hardest columns:
  - suspected revenue leak  (ASCEND's five categories)
  - recommended first outreach angle (operator-native, lowercase, mechanism-first)

Both are derived from THIS game's observable signals (pass ladder shape,
CCU/visit ratio, recency, genre), never a template string.
"""
from __future__ import annotations

CATEGORIES = ("Acquisition", "Activation", "Monetization", "Measurement", "Compounding")


def _pass_prices(passes):
    out = []
    for p in passes:
        price = p.get("price") or p.get("Price")
        if price:
            out.append(int(price))
    return sorted(out)


def suspected_leak(*, visits, ccu, passes, age_days, genres) -> str:
    prices = _pass_prices(passes)
    n = len(passes)
    v2c = visits / max(ccu, 1)

    # Monetization: thin or flat pass ladder.
    if n <= 3:
        return ("Monetization: shallow pass catalogue ({} public passes) — likely "
                "leaving ARPPU on the table with no mid/high price tier or bundle."
                .format(n))
    if prices and (max(prices) - min(prices)) < 200:
        return ("Monetization: flat price ladder (all passes within {} R$) — no "
                "whale tier or anchor pass; segmentation leak.".format(
                    max(prices) - min(prices)))
    # Compounding: high visits but modest CCU -> retention/return-loop leak.
    if v2c > 40_000:
        return ("Compounding: {:.0f}:1 lifetime-visit-to-CCU ratio suggests weak "
                "return-loop — churned players aren't monetized on re-entry."
                .format(v2c))
    # Activation: healthy CCU, rich catalogue, but recent big update -> first-session convert.
    if age_days is not None and age_days <= 45 and n >= 6:
        return ("Activation: fresh update + {} passes, but first-session "
                "purchase-conversion is the likely gap — new cohort not routed to "
                "the store early.".format(n))
    # Default to a specific Monetization hypothesis rather than filler.
    return ("Monetization: {} passes live; audit sink balance, limited-time "
            "bundles, and price-anchor placement for ARPPU lift.".format(n))


def outreach_angle(*, name, passes, age_days, ccu, genres, leak: str) -> str:
    prices = _pass_prices(passes)
    n = len(passes)
    cat = leak.split(":")[0].lower()
    if cat == "monetization" and n <= 3:
        return ("noticed only {} public passes on your store — want a read on the "
                "mid-tier pass + bundle you're missing?".format(n))
    if cat == "monetization" and prices:
        return ("your pass ladder tops out at {} r$ — there's likely an anchor/whale "
                "tier gap worth testing.".format(max(prices)))
    if cat == "compounding":
        return ("your visit-to-ccu spread says returning players aren't being "
                "re-monetized — quick idea on the re-entry offer loop?")
    if cat == "activation":
        return ("fresh update landed but new players probably aren't hitting the "
                "store in session one — want the first-session routing fix?")
    return ("saw {} live passes and no obvious sink — happy to map where the "
            "spend is leaking.".format(n))
