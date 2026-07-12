"""Deduplication against the source workbook AND the growing new list.

Dedupe order (task Rule 3): universeId/placeId first, then normalized game
name, then studio/group id. A lead is excluded if the game OR its parent
group appears anywhere in the source workbook's five sheets.

Two key sources are combined:
  1. exclusions.json — keys pre-extracted from every sheet of the source
     workbook (place ids, normalized names, group ids, user ids). Ships with
     the pipeline so dedup works even before the .xlsx is re-read.
  2. The live source workbook, re-read at runtime if present, so the baked
     keys can never drift from the file you actually deduped against.
"""
from __future__ import annotations
import json
import os
import re

_NON_ALNUM = re.compile(r"[^a-z0-9]+")
_PLACE_RE = re.compile(r"/games/(\d+)")
_GROUP_RE = re.compile(r"/groups/(\d+)")
_USER_RE = re.compile(r"/users/(\d+)")


def norm_name(s) -> str:
    if not s:
        return ""
    s = _NON_ALNUM.sub(" ", str(s).lower()).strip()
    return re.sub(r"\s+", " ", s)


class Deduper:
    def __init__(self, exclusions_json: str, source_workbook: str | None = None):
        with open(exclusions_json) as fh:
            baked = json.load(fh)
        self.place_ids: set[str] = set(baked.get("place_ids", []))
        self.names: set[str] = set(baked.get("normalized_names", []))
        self.group_ids: set[str] = set(baked.get("group_ids", []))
        self.user_ids: set[str] = set(baked.get("user_ids", []))
        # Keys accumulated from newly accepted leads this run.
        self._new_place_ids: set[str] = set()
        self._new_names: set[str] = set()
        self._new_group_ids: set[str] = set()
        if source_workbook and os.path.exists(source_workbook):
            self._merge_workbook(source_workbook)

    def _merge_workbook(self, path: str) -> None:
        import openpyxl

        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        for sheet in wb.sheetnames:
            ws = wb[sheet]
            rows = ws.iter_rows(values_only=True)
            header = next(rows, None)
            if not header:
                continue
            hdr = [str(h) for h in header]
            try:
                name_i = hdr.index("Game name")
            except ValueError:
                name_i = 0
            for r in rows:
                blob = " ".join(str(x) for x in r if x)
                if len(r) > name_i and r[name_i]:
                    self.names.add(norm_name(r[name_i]))
                self.place_ids.update(_PLACE_RE.findall(blob))
                self.group_ids.update(_GROUP_RE.findall(blob))
                self.user_ids.update(_USER_RE.findall(blob))
        wb.close()

    def is_duplicate(self, *, place_id=None, universe_id=None, name=None,
                     group_id=None) -> str | None:
        """Return the dedup reason if this lead collides, else None."""
        pid = str(place_id) if place_id is not None else None
        gid = str(group_id) if group_id is not None else None
        nm = norm_name(name) if name else None
        if pid and (pid in self.place_ids or pid in self._new_place_ids):
            return f"duplicate: placeId {pid} already present"
        if nm and (nm in self.names or nm in self._new_names):
            return f"duplicate: game name '{name}' already present"
        if gid and (gid in self.group_ids or gid in self._new_group_ids):
            return f"duplicate: group {gid} already present"
        return None

    def accept(self, *, place_id=None, name=None, group_id=None) -> None:
        """Record an accepted lead so the rest of the run dedupes against it."""
        if place_id is not None:
            self._new_place_ids.add(str(place_id))
        if name:
            self._new_names.add(norm_name(name))
        if group_id is not None:
            self._new_group_ids.add(str(group_id))
