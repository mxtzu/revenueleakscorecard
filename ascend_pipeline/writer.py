"""Writes the deliverable .xlsx, schema-identical to the source workbook.

Sheet 1 `Qualified Leads`: the 18 source columns IN ORDER, then two appended
columns: `estimated monthly revenue (USD)` and `revenue basis`.
Sheet 2 `Scoring Rubric` (updated to document the revenue-band filter).
Sheet 3 `Source Notes`.
Sheet 4 `Exclusions`.
Sheet 5 `Shortfall Report` (only if < TARGET_LEADS).
"""
from __future__ import annotations
from datetime import date

import openpyxl
from openpyxl.styles import Font, Alignment

import config

LEAD_COLUMNS = [
    "Game name", "studio/group", "Roblox URL", "genre", "visits",
    "current players", "last updated", "monetization signal", "contact path",
    "operator/founder if found", "hiring signal", "suspected revenue leak",
    "estimated tier", "fit score", "priority tier",
    "recommended first outreach angle", "source URL", "verification status",
    # appended (do not reorder/rename the 18 above):
    "estimated monthly revenue (USD)", "revenue basis",
]

EXCLUSION_COLUMNS = [
    "Game name", "studio/group", "Roblox URL", "visits", "current players",
    "last updated", "exclusion reason", "source",
]


def _style_header(ws, ncols):
    for c in range(1, ncols + 1):
        cell = ws.cell(row=1, column=c)
        cell.font = Font(bold=True)
        cell.alignment = Alignment(vertical="top", wrap_text=True)


def write(path, leads, exclusions, shortfall=None):
    wb = openpyxl.Workbook()

    # Sheet 1: Qualified Leads
    ws = wb.active
    ws.title = "Qualified Leads"
    ws.append(LEAD_COLUMNS)
    for L in leads:
        ws.append([L.get(c, "") for c in LEAD_COLUMNS])
    _style_header(ws, len(LEAD_COLUMNS))

    # Sheet 2: Scoring Rubric (documents the revenue-band filter + weighting)
    ws = wb.create_sheet("Scoring Rubric")
    ws.append(["Category", "Points", "Rule"])
    for row in [
        ["Size fit", "0-20", "20M-300M visits scores best; 10M-500M strong; 5M+ minimum."],
        ["Current activity", "0-18", "500-5,000 CCU best; 250-10,000 preferred; 100+ minimum."],
        ["Update recency", "0-14", "Updated in 45 days best; older than 365 days excluded."],
        ["Monetization surface", "0-13", "Public game passes required; richer catalogue scores higher."],
        ["Genre fit", "0-10", "Simulator, tycoon, RPG, anime, fighting, horror, survival, RP, sports, strategy, trading."],
        ["Contact path", "0-10", "Requires VERIFIED public Discord invite (this deliverable); Roblox group/profile as secondary."],
        ["Audience reception", "0-8", "Public up/down vote ratio improves score when available."],
        ["Hiring/live-ops signal", "0-7", "Public roles + update/codes/events text add priority."],
        ["Deprioritizers", "negative", "CCU>20K and visits>1B reduce rank; >1B visits/50K CCU excluded as mega."],
        ["REVENUE BAND (HARD FILTER F)", "gate", (
            f"Estimated monthly-revenue MIDPOINT must fall in "
            f"${config.REV_BAND_LOW:,}-${config.REV_BAND_HIGH:,}. Binding constraint: "
            "most threshold-passing candidates are rejected here. Estimate is a "
            "documented ARPDAU/CCU heuristic converted at the Roblox DevEx rate; "
            "see the `revenue basis` column per row.")],
        ["DISCORD (HARD FILTER G)", "gate", (
            "A live-verified Discord invite is mandatory. Invite resolved from a "
            "public source then confirmed via the public Discord invite endpoint. "
            "No Discord = lead dropped. Invites are never fabricated or guessed.")],
    ]:
        ws.append(row)
    _style_header(ws, 3)

    # Sheet 3: Source Notes
    ws = wb.create_sheet("Source Notes")
    ws.append(["Source", "URL or endpoint", "Use", "Terms/robots note"])
    for row in [
        ["Roblox discovery/search",
         "https://apis.roblox.com/explore-api/v1/get-sort-content and https://apis.roblox.com/search-api/omni-search",
         "Candidate discovery by public sort and keyword search.",
         "Unauthenticated public Roblox endpoint; no cookies/account data."],
        ["Roblox game details", "https://games.roblox.com/v1/games?universeIds=...",
         "Visits, current players, update date, creator, genre, canonical URL.",
         "Public metadata endpoint; rate limited with retries/backoff."],
        ["Roblox game passes",
         "https://apis.roblox.com/game-passes/v1/universes/{universeId}/game-passes",
         "Visible monetization surface; only public game-pass catalogue.",
         "No private revenue or internal game data used."],
        ["Roblox groups/users",
         "https://groups.roblox.com/v1/groups/{id} + /roles; https://users.roblox.com/v1/users/{id}",
         "Contact path, owner/operator, public role taxonomy, descriptions.",
         "Public metadata only. Auth-gated social endpoints not bypassed."],
        ["Discord invite verification", "https://discord.com/api/v10/invites/{code}?with_counts=true",
         "Confirm each invite is live; capture guild name + approx members.",
         "Public invite endpoint; dead/expired invite => lead dropped."],
        ["Public socials (rung 5)", "x.com / youtube.com / tiktok.com / linktr.ee (as linked)",
         "Route to a publicly posted Discord invite only; never a revenue source.",
         "Public pages only; robots respected; no auth."],
        ["Roblox web robots", "https://www.roblox.com/robots.txt",
         "Robots check for the Roblox web host.",
         "Pipeline avoids disallowed paths; uses public JSON endpoints."],
    ]:
        ws.append(row)
    _style_header(ws, 4)

    # Sheet 4: Exclusions
    ws = wb.create_sheet("Exclusions")
    ws.append(EXCLUSION_COLUMNS)
    for e in exclusions:
        ws.append([e.get(c, "") for c in EXCLUSION_COLUMNS])
    _style_header(ws, len(EXCLUSION_COLUMNS))

    # Sheet 5: Shortfall Report (only if under target)
    if shortfall is not None:
        ws = wb.create_sheet("Shortfall Report")
        ws.append(["Metric", "Value"])
        for k, v in shortfall.items():
            ws.append([k, v])
        _style_header(ws, 2)

    wb.save(path)
    return path
