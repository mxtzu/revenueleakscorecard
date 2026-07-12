# ASCEND lead pipeline

Builds a prospecting dataset of Discord-contactable Roblox studio leads, output
as an `.xlsx` that is **schema-identical** to `ASCEND_Leads__IMPORTANT_.xlsx`
(same 18 columns in order, plus two appended revenue columns), across the same
sheet set: `Qualified Leads`, `Scoring Rubric`, `Source Notes`, `Exclusions`,
and `Shortfall Report` (only if under target).

## Why this is code and not a finished workbook

The deliverable requires hitting live public Roblox APIs and verifying live
Discord invites. **In the environment where this was authored, egress policy
blocks every required host** — `apis.roblox.com`, `games.roblox.com`,
`groups.roblox.com`, `users.roblox.com`, `thumbnails.roblox.com`,
`www.roblox.com`, and `discord.com` all return `403` connect-rejected at the
proxy. The pipeline therefore could not be *run* here, only built and unit-
tested offline.

Nothing is ever fabricated. A lead with no live-verified Discord invite is
**dropped**, and any shortfall is reported honestly in the `Shortfall Report`
sheet. There is no synthetic data path.

## Run it where the hosts are reachable

```bash
pip install -r requirements.txt
# put the source workbook next to run.py so dedup reads the live file too:
cp /path/to/ASCEND_Leads__IMPORTANT_.xlsx .
python run.py --target 1000
# -> writes ASCEND_Leads__NEW_1000.xlsx and checkpoints/ as it goes
```

Roblox and Discord actively rate-limit and often `403` datacenter IPs even when
policy allows them. Run from an environment with residential-grade egress, keep
`CONCURRENCY` low, and let the exponential backoff do its job.

## Pipeline stages

| Module | Responsibility |
| --- | --- |
| `config.py` | All thresholds, the revenue heuristic constants, and the keyword matrix. Tune here. |
| `roblox_client.py` | Async client over the **public, unauthenticated** Roblox JSON endpoints only. Backoff on 429/5xx. |
| `discovery` (in `run.py`) | Explore sorts paged deep + a large omni-search keyword matrix (genre × live-ops × audience + intl variants) + group/creator adjacency. |
| `dedup.py` | Dedupes against **all five sheets** of the source workbook (baked `exclusions.json` + live re-read) and against the growing new list. Order: placeId → normalized name → group id. |
| `qualify.py` | Hard filters A–F + the 0–100 fit score, faithful to the `Scoring Rubric` sheet. |
| `revenue.py` | Transparent ARPDAU/CCU → DevEx-USD estimate as a **range**, with the heuristic written into every `revenue basis` cell. Filter F keeps only rows whose midpoint is $5k–$20k/mo. |
| `discord_resolver.py` | The resolution ladder (rungs 1–6) + **live verification** via `discord.com/api/v10/invites/{code}`. Only ever returns a code that was extracted from a fetched public source *and* confirmed live. |
| `diagnostics.py` | Non-generic `suspected revenue leak` (ASCEND's five categories) and lowercase, mechanism-first `outreach angle`, both derived from that game's observable signals. |
| `writer.py` | Emits the schema-identical 5-sheet `.xlsx`. |
| `run.py` | Orchestrates, checkpoints continuously, reports progress every 100 qualified leads (count, rejection breakdown, Discord hit-rate by rung). |

## The two binding constraints

Per the task's own warning: the size thresholds surface many studios whose
estimated revenue is **well above** $20k/mo. Filter **F (revenue band)** and
filter **G (verified Discord)** are the binding constraints — expect to reject a
large majority of threshold-passing candidates. If discovery is exhausted before
1,000 survivors, the run does **not** pad, relax F, or fabricate: it writes a
`Shortfall Report` (counts screened, rejection breakdown, and the threshold
change that would be required) and stops.

## Anti-fabrication guarantees (enforced in code)

- `discord_resolver.extract_invite_codes` only pulls literal `discord.gg/…` /
  `discord.com/invite/…` strings out of text we fetched. It never constructs
  `discord.gg/<studioname>`, never guesses codes.
- Every code is re-resolved against the public Discord invite endpoint before a
  lead is kept; `404`/expired ⇒ dropped.
- `verification status` records which ladder rung produced the hit and the live-
  verification date, mirroring the source workbook's honesty (its own
  `Manual Review Queue` is stamped "Queued, not fabricated").
