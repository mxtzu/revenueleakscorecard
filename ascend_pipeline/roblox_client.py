"""Thin async client over Roblox's PUBLIC, unauthenticated JSON endpoints.

Only the endpoints named in the workbook's Source Notes are used. No cookies,
no session tokens, no auth-gated paths. Every call backs off exponentially on
429/5xx (task Rule 4). If your egress policy blocks *.roblox.com you will get
connection errors here — that is a network-policy problem, not a code problem;
run this where the hosts are reachable.
"""
from __future__ import annotations
import asyncio
import logging

import httpx
from tenacity import (retry, stop_after_attempt, wait_exponential,
                      retry_if_exception_type)

import config

log = logging.getLogger("roblox")

_RETRYABLE = (httpx.TransportError, httpx.HTTPStatusError)


class RobloxClient:
    def __init__(self):
        self._client = httpx.AsyncClient(
            timeout=config.REQUEST_TIMEOUT,
            headers={"User-Agent": config.USER_AGENT, "Accept": "application/json"},
            follow_redirects=True,
        )
        self._sem = asyncio.Semaphore(config.CONCURRENCY)

    async def close(self):
        await self._client.aclose()

    @retry(reraise=True, stop=stop_after_attempt(config.MAX_RETRIES),
           wait=wait_exponential(multiplier=config.BACKOFF_BASE, max=32),
           retry=retry_if_exception_type(_RETRYABLE))
    async def _get(self, url: str, **params):
        async with self._sem:
            r = await self._client.get(url, params=params or None)
            if r.status_code in (429, 500, 502, 503, 504):
                r.raise_for_status()   # triggers retry/backoff
            r.raise_for_status()
            return r.json()

    # ---- Discovery -------------------------------------------------------
    async def explore_sort(self, sort_id: str, session_id: str, page_token: str | None = None):
        """https://apis.roblox.com/explore-api/v1/get-sort-content"""
        params = {"sessionId": session_id, "sortId": sort_id}
        if page_token:
            params["pageToken"] = page_token
        return await self._get(
            "https://apis.roblox.com/explore-api/v1/get-sort-content", **params)

    async def omni_search(self, keyword: str, session_id: str, page_token: str | None = None):
        """https://apis.roblox.com/search-api/omni-search"""
        params = {"searchQuery": keyword, "sessionId": session_id, "pageType": "all"}
        if page_token:
            params["pageToken"] = page_token
        return await self._get(
            "https://apis.roblox.com/search-api/omni-search", **params)

    # ---- Game details ----------------------------------------------------
    async def games(self, universe_ids: list[int]):
        """https://games.roblox.com/v1/games?universeIds=..."""
        ids = ",".join(str(u) for u in universe_ids)
        data = await self._get("https://games.roblox.com/v1/games", universeIds=ids)
        return data.get("data", [])

    async def votes(self, universe_ids: list[int]):
        ids = ",".join(str(u) for u in universe_ids)
        data = await self._get("https://games.roblox.com/v1/games/votes", universeIds=ids)
        return {v["id"]: v for v in data.get("data", [])}

    async def universe_id_for_place(self, place_id: int) -> int | None:
        data = await self._get(
            f"https://apis.roblox.com/universes/v1/places/{place_id}/universe")
        return data.get("universeId")

    async def game_passes(self, universe_id: int):
        """https://apis.roblox.com/game-passes/v1/universes/{id}/game-passes"""
        out, cursor = [], None
        for _ in range(10):  # page through, bounded
            params = {"count": 100}
            if cursor:
                params["cursor"] = cursor
            data = await self._get(
                f"https://apis.roblox.com/game-passes/v1/universes/{universe_id}/game-passes",
                **params)
            out.extend(data.get("gamePasses", data.get("data", [])))
            cursor = data.get("nextPageCursor")
            if not cursor:
                break
        return out

    # ---- Recommendations / adjacency ------------------------------------
    async def recommendations(self, universe_id: int, session_id: str):
        try:
            data = await self._get(
                "https://apis.roblox.com/explore-api/v1/get-sort-content-for-treatment",
                treatmentType="Recommended", contextUniverseId=universe_id,
                sessionId=session_id)
            return data
        except _RETRYABLE:
            return {}

    # ---- Groups / users --------------------------------------------------
    async def group(self, group_id: int):
        return await self._get(f"https://groups.roblox.com/v1/groups/{group_id}")

    async def group_roles(self, group_id: int):
        data = await self._get(f"https://groups.roblox.com/v1/groups/{group_id}/roles")
        return data.get("roles", [])

    async def group_games(self, group_id: int):
        """Enumerate a group's OTHER public experiences (adjacency)."""
        data = await self._get(
            f"https://games.roblox.com/v2/groups/{group_id}/games",
            accessFilter="Public", limit=50, sortOrder="Desc")
        return data.get("data", [])

    async def user(self, user_id: int):
        return await self._get(f"https://users.roblox.com/v1/users/{user_id}")

    async def user_games(self, user_id: int):
        data = await self._get(
            f"https://games.roblox.com/v2/users/{user_id}/games",
            accessFilter="Public", limit=50, sortOrder="Desc")
        return data.get("data", [])
