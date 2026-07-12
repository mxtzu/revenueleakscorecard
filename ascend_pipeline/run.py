"""ASCEND lead pipeline orchestrator.

Discovery -> qualification (filters A-F + rubric) -> Discord resolution ladder
+ live verification (filter G) -> dedup -> checkpoint -> xlsx.

RUN WHERE THE HOSTS ARE REACHABLE. If *.roblox.com or discord.com are blocked
by egress policy every network call fails; that is an environment constraint,
not a bug. Nothing is ever fabricated: a lead with no live-verified Discord
invite is dropped, and a shortfall is reported honestly.

Usage:
  python run.py --target 1000
"""
from __future__ import annotations
import argparse
import asyncio
import json
import logging
import os
import uuid
from collections import Counter
from datetime import date

import config
import dedup as dedupmod
import qualify
import diagnostics
import writer
from roblox_client import RobloxClient
from discord_resolver import DiscordResolver

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("run")

TODAY = date.today().isoformat()


def _genres(game: dict) -> list[str]:
    g = game.get("genre_l1") or game.get("genre") or ""
    subs = game.get("subgenres") or []
    parts = [g] + [s for s in subs if s]
    return [p for p in parts if p]


def _monetization_signal(passes: list[dict]) -> str:
    n = len(passes)
    prices = sorted(int(p.get("price") or p.get("Price") or 0) for p in passes)
    prices = [p for p in prices if p]
    ladder = f"; price ladder {prices[0]}-{prices[-1]} R$" if prices else ""
    return f"{n} public game passes for sale{ladder}"


class Pipeline:
    def __init__(self, target: int):
        self.target = target
        self.rbx = RobloxClient()
        self.discord = DiscordResolver(self.rbx)
        self.dd = dedupmod.Deduper(config.EXCLUSIONS_JSON, config.SOURCE_WORKBOOK)
        self.leads: list[dict] = []
        self.exclusions: list[dict] = []
        self.reject = Counter()          # size/recency/monetization/revenue_band/no_discord/duplicate
        self.rung_hits = Counter()       # discord hit rate by ladder rung
        self.screened = 0
        os.makedirs(config.CHECKPOINT_DIR, exist_ok=True)

    # ---- checkpointing ---------------------------------------------------
    def checkpoint(self):
        with open(os.path.join(config.CHECKPOINT_DIR, "leads.json"), "w") as f:
            json.dump(self.leads, f)
        with open(os.path.join(config.CHECKPOINT_DIR, "state.json"), "w") as f:
            json.dump({"screened": self.screened, "reject": dict(self.reject),
                       "rung_hits": dict(self.rung_hits),
                       "qualified": len(self.leads)}, f)

    def progress(self):
        rate = (sum(self.rung_hits.values()) / max(self.screened, 1)) * 100
        log.info("PROGRESS qualified=%d screened=%d discord_hit_rate=%.1f%% rejects=%s rungs=%s",
                 len(self.leads), self.screened, rate,
                 dict(self.reject), dict(self.rung_hits))

    # ---- per-candidate processing ---------------------------------------
    async def process_universe(self, universe_id: int, source_tag: str):
        self.screened += 1
        games = await self.rbx.games([universe_id])
        if not games:
            return
        game = games[0]
        place_id = game.get("rootPlaceId")
        name = game.get("name", "")

        dup = self.dd.is_duplicate(place_id=place_id, name=name,
                                   group_id=(game.get("creator") or {}).get("id")
                                   if (game.get("creator") or {}).get("type") == "Group" else None)
        if dup:
            self.reject["duplicate"] += 1
            self._exclude(game, dup, source_tag)
            return

        visits = game.get("visits", 0)
        ccu = game.get("playing", 0)
        passes = []
        try:
            passes = await self.rbx.game_passes(universe_id)
        except Exception as e:  # noqa: BLE001 - network hiccup shouldn't kill the run
            log.warning("game_passes failed for %s: %s", universe_id, e)

        votes = None
        try:
            votes = (await self.rbx.votes([universe_id])).get(universe_id)
        except Exception:  # noqa: BLE001
            pass

        creator = game.get("creator") or {}
        group = owner = None
        group_url = owner_url = None
        roles = []
        if creator.get("type") == "Group":
            try:
                group = await self.rbx.group(creator["id"])
                group_url = f"https://www.roblox.com/groups/{creator['id']}"
                roles = await self.rbx.group_roles(creator["id"])
                owner_id = (group.get("owner") or {}).get("userId")
                if owner_id:
                    owner = await self.rbx.user(owner_id)
                    owner_url = f"https://www.roblox.com/users/{owner_id}/profile"
            except Exception as e:  # noqa: BLE001
                log.warning("group/owner lookup failed: %s", e)
        elif creator.get("type") == "User":
            try:
                owner = await self.rbx.user(creator["id"])
                owner_url = f"https://www.roblox.com/users/{creator['id']}/profile"
            except Exception:  # noqa: BLE001
                pass

        screen = qualify.screen(
            visits=visits, ccu=ccu, last_updated=game.get("updated"),
            genres=_genres(game), passes=passes, votes=votes,
            has_contact_path=bool(group_url or owner_url),
            roles=roles, description=game.get("description", ""))

        if not screen.passed:
            self.reject[screen.reject_reason] += 1
            self._exclude(game, self._reject_text(screen.reject_reason, screen), source_tag)
            return

        # ---- Filter G: Discord (hard) -----------------------------------
        game_url = f"https://www.roblox.com/games/{place_id}/{name.replace(' ', '-')}"
        invite = await self.discord.resolve(
            game_desc=game.get("description", ""), game_url=game_url,
            group=group, group_url=group_url, owner=owner, owner_url=owner_url)
        if not invite:
            self.reject["no_discord"] += 1
            self._exclude(game, "No live-verified Discord invite found on any public rung", source_tag)
            return

        self.rung_hits[invite["rung"].split(":")[0]] += 1

        leak = diagnostics.suspected_leak(
            visits=visits, ccu=ccu, passes=passes,
            age_days=qualify._age_days(game.get("updated")), genres=_genres(game))
        angle = diagnostics.outreach_angle(
            name=name, passes=passes,
            age_days=qualify._age_days(game.get("updated")), ccu=ccu,
            genres=_genres(game), leak=leak)

        contact = invite["url"]
        if group_url:
            contact += f" | {group_url}"

        owner_name = (owner or {}).get("name") or (group or {}).get("owner", {}).get("username", "")
        row = {
            "Game name": name,
            "studio/group": (creator.get("name") or ""),
            "Roblox URL": game_url,
            "genre": ", ".join(_genres(game)),
            "visits": visits,
            "current players": ccu,
            "last updated": str(game.get("updated", ""))[:10],
            "monetization signal": _monetization_signal(passes),
            "contact path": contact,
            "operator/founder if found": owner_name,
            "hiring signal": self._hiring(roles, game.get("description", "")),
            "suspected revenue leak": leak,
            "estimated tier": screen.estimated_tier,
            "fit score": screen.fit_score,
            "priority tier": screen.priority_tier,
            "recommended first outreach angle": angle,
            "source URL": invite["source_url"],
            "verification status": (
                f"{invite['rung']}; invite verified live via public Discord invite "
                f"endpoint on {TODAY}"
                + (f" (guild '{invite['guild_name']}', ~{invite['approx_members']} members)"
                   if invite.get("guild_name") else "")),
            "estimated monthly revenue (USD)": f"${screen.rev.low:,}-${screen.rev.high:,}",
            "revenue basis": screen.rev.basis,
        }
        self.leads.append(row)
        self.dd.accept(place_id=place_id, name=name,
                       group_id=creator.get("id") if creator.get("type") == "Group" else None)

        if len(self.leads) % 100 == 0:
            self.progress()
            self.checkpoint()

    def _hiring(self, roles, desc):
        role_txt = ", ".join(f"{r.get('name')} ({r.get('memberCount', 0)})"
                             for r in roles[:8]) if roles else ""
        terms = [t for t in config.LIVEOPS_TERMS if t in (desc or "").lower()]
        parts = []
        if role_txt:
            parts.append(f"Public group roles: {role_txt}")
        if terms:
            parts.append("Live-ops text: " + ", ".join(terms))
        return " | ".join(parts)

    def _reject_text(self, reason, screen):
        m = {
            "size": "Below size/activity floor or mega-scale (above band)",
            "recency": "Stale: no update within 365 days",
            "monetization": "No public game-pass catalogue",
            "revenue_band": (f"Revenue band: estimated midpoint "
                             f"${screen.rev.mid:,}/mo outside ${config.REV_BAND_LOW:,}-"
                             f"${config.REV_BAND_HIGH:,}" if screen.rev else "Outside revenue band"),
        }
        return m.get(reason, reason)

    def _exclude(self, game, reason, source_tag):
        place_id = game.get("rootPlaceId")
        self.exclusions.append({
            "Game name": game.get("name", ""),
            "studio/group": (game.get("creator") or {}).get("name", ""),
            "Roblox URL": f"https://www.roblox.com/games/{place_id}",
            "visits": game.get("visits", 0),
            "current players": game.get("playing", 0),
            "last updated": str(game.get("updated", "")),
            "exclusion reason": reason,
            "source": source_tag,
        })

    # ---- shortfall -------------------------------------------------------
    def shortfall_report(self):
        if len(self.leads) >= self.target:
            return None
        needed = self.target - len(self.leads)
        return {
            "target": self.target,
            "qualified": len(self.leads),
            "shortfall": needed,
            "candidates screened": self.screened,
            "rejected - size/activity/mega": self.reject.get("size", 0),
            "rejected - stale (recency)": self.reject.get("recency", 0),
            "rejected - no monetization surface": self.reject.get("monetization", 0),
            "rejected - outside revenue band (F)": self.reject.get("revenue_band", 0),
            "rejected - no verified Discord (G)": self.reject.get("no_discord", 0),
            "rejected - duplicate of source workbook": self.reject.get("duplicate", 0),
            "discord hit rate": f"{(sum(self.rung_hits.values())/max(self.screened,1))*100:.1f}%",
            "binding constraint": (
                "Revenue band (F) and verified-Discord (G) are the two binding "
                "constraints. To reach target without relaxing F, widen discovery "
                "(more keyword matrix + adjacency crawl). Relaxing F would raise "
                "the revenue ceiling above $20k/mo, changing who ASCEND targets — "
                "do not do this silently."),
        }

    async def run(self):
        try:
            await self._discover_and_process()
        finally:
            await self.rbx.close()
            await self.discord.close()
        shortfall = self.shortfall_report()
        writer.write(config.OUTPUT_XLSX, self.leads, self.exclusions, shortfall)
        self.progress()
        log.info("DONE qualified=%d output=%s shortfall=%s",
                 len(self.leads), config.OUTPUT_XLSX, bool(shortfall))

    async def _discover_and_process(self):
        """Discovery driver: explore sorts + keyword matrix + adjacency.
        Feeds universe IDs into process_universe until target met or exhausted."""
        session_id = str(uuid.uuid4())
        seen_universes: set[int] = set()

        async def handle(uid: int, tag: str):
            if uid in seen_universes or len(self.leads) >= self.target:
                return
            seen_universes.add(uid)
            try:
                await self.process_universe(uid, tag)
            except Exception as e:  # noqa: BLE001
                log.warning("process_universe(%s) failed: %s", uid, e)

        # 1) explore sorts, paged deep
        for sort_id in config.EXPLORE_SORTS:
            token = None
            for _page in range(25):
                if len(self.leads) >= self.target:
                    return
                try:
                    data = await self.rbx.explore_sort(sort_id, session_id, token)
                except Exception as e:  # noqa: BLE001
                    log.warning("explore %s failed: %s", sort_id, e)
                    break
                for item in _iter_universes(data):
                    await handle(item, f"explore:{sort_id}")
                token = data.get("nextPageToken")
                if not token:
                    break

        # 2) keyword matrix over omni-search
        matrix = _keyword_matrix()
        for kw in matrix:
            if len(self.leads) >= self.target:
                return
            token = None
            for _page in range(10):
                try:
                    data = await self.rbx.omni_search(kw, session_id, token)
                except Exception as e:  # noqa: BLE001
                    log.warning("omni-search %r failed: %s", kw, e)
                    break
                for uid in _iter_search_universes(data):
                    await handle(uid, f"search:{kw}")
                token = data.get("nextPageToken")
                if not token:
                    break


def _keyword_matrix() -> list[str]:
    terms = list(config.GENRE_TERMS)
    for g in config.GENRE_TERMS[:12]:
        for m in config.LIVEOPS_TERMS[:6]:
            terms.append(f"{g} {m}")
    for a in config.AUDIENCE_TERMS:
        terms.append(a)
    terms.extend(config.INTL_TERMS)
    # dedupe, preserve order
    seen, out = set(), []
    for t in terms:
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out


def _iter_universes(explore_data):
    for sort in explore_data.get("sorts", []) or []:
        for g in sort.get("games", []) or []:
            uid = g.get("universeId") or g.get("universeID")
            if uid:
                yield int(uid)
    for g in explore_data.get("games", []) or []:
        uid = g.get("universeId")
        if uid:
            yield int(uid)


def _iter_search_universes(search_data):
    for grp in search_data.get("searchResults", []) or []:
        for c in grp.get("contents", []) or []:
            uid = c.get("universeId")
            if uid:
                yield int(uid)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", type=int, default=config.TARGET_LEADS)
    args = ap.parse_args()
    asyncio.run(Pipeline(args.target).run())


if __name__ == "__main__":
    main()
