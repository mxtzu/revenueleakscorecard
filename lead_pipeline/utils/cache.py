"""SQLite-backed HTTP response cache.

Caching is what keeps the pipeline from hammering the same sites across runs:
a repeated run inside the TTL performs zero network requests.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

SCHEMA = """
CREATE TABLE IF NOT EXISTS http_cache (
    key           TEXT PRIMARY KEY,
    url           TEXT NOT NULL,
    method        TEXT NOT NULL,
    status        INTEGER,
    headers_json  TEXT,
    body          TEXT,
    final_url     TEXT,
    stored_at     REAL NOT NULL,
    expires_at    REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_http_cache_expires ON http_cache(expires_at);
"""


@dataclass
class CacheEntry:
    key: str
    url: str
    method: str
    status: int
    headers: dict[str, str]
    body: str
    final_url: str
    stored_at: float
    expires_at: float


def cache_key(method: str, url: str, *, params: Mapping[str, Any] | None = None, body: Any = None) -> str:
    payload = json.dumps(
        {
            "method": method.upper(),
            "url": url,
            "params": _sorted(params),
            "body": _sorted(body) if isinstance(body, Mapping) else body,
        },
        sort_keys=True,
        default=str,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _sorted(value: Mapping[str, Any] | None) -> dict[str, Any] | None:
    if not value:
        return None
    return {str(k): value[k] for k in sorted(value, key=str)}


class HttpCache:
    """Thread-safe (and asyncio-safe: operations are short and synchronous)."""

    def __init__(self, path: str | Path, default_ttl: int = 7 * 24 * 3600) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.default_ttl = int(default_ttl)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(SCHEMA)
            self._conn.commit()
        self.hits = 0
        self.misses = 0
        self.writes = 0

    def get(self, key: str, *, now: float | None = None) -> CacheEntry | None:
        now = now if now is not None else time.time()
        with self._lock:
            row = self._conn.execute("SELECT * FROM http_cache WHERE key = ?", (key,)).fetchone()
        if row is None:
            self.misses += 1
            return None
        if row["expires_at"] < now:
            self.misses += 1
            self.delete(key)
            return None
        self.hits += 1
        return CacheEntry(
            key=row["key"],
            url=row["url"],
            method=row["method"],
            status=row["status"],
            headers=json.loads(row["headers_json"] or "{}"),
            body=row["body"] or "",
            final_url=row["final_url"] or row["url"],
            stored_at=row["stored_at"],
            expires_at=row["expires_at"],
        )

    def set(
        self,
        key: str,
        *,
        url: str,
        method: str,
        status: int,
        headers: Mapping[str, str] | None,
        body: str,
        final_url: str | None = None,
        ttl: int | None = None,
        now: float | None = None,
    ) -> None:
        now = now if now is not None else time.time()
        ttl = int(ttl if ttl is not None else self.default_ttl)
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO http_cache (key, url, method, status, headers_json, body, final_url, stored_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    status=excluded.status,
                    headers_json=excluded.headers_json,
                    body=excluded.body,
                    final_url=excluded.final_url,
                    stored_at=excluded.stored_at,
                    expires_at=excluded.expires_at
                """,
                (
                    key,
                    url,
                    method.upper(),
                    int(status),
                    json.dumps(dict(headers or {})),
                    body,
                    final_url or url,
                    now,
                    now + ttl,
                ),
            )
            self._conn.commit()
        self.writes += 1

    def delete(self, key: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM http_cache WHERE key = ?", (key,))
            self._conn.commit()

    def purge_expired(self, now: float | None = None) -> int:
        now = now if now is not None else time.time()
        with self._lock:
            cur = self._conn.execute("DELETE FROM http_cache WHERE expires_at < ?", (now,))
            self._conn.commit()
            return cur.rowcount

    def clear(self) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM http_cache")
            self._conn.commit()

    def stats(self) -> dict[str, int]:
        return {"hits": self.hits, "misses": self.misses, "writes": self.writes}

    def close(self) -> None:
        with self._lock:
            self._conn.close()


class NullCache:
    """Drop-in no-op cache used when ``--no-cache`` is set."""

    default_ttl = 0

    def get(self, key: str, *, now: float | None = None) -> CacheEntry | None:  # noqa: ARG002
        return None

    def set(self, key: str, **kwargs: Any) -> None:  # noqa: D102, ARG002
        return None

    def delete(self, key: str) -> None:  # noqa: D102, ARG002
        return None

    def purge_expired(self, now: float | None = None) -> int:  # noqa: ARG002
        return 0

    def clear(self) -> None:
        return None

    def stats(self) -> dict[str, int]:
        return {"hits": 0, "misses": 0, "writes": 0}

    def close(self) -> None:
        return None
