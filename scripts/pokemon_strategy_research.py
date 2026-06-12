#!/usr/bin/env python3
"""Refresh a small web-strategy cache for autonomous poke-pi supervision.

This is intentionally best-effort and quiet: it uses public web search / pages only,
keeps a local cache, and never blocks gameplay if the network fails.
"""
from __future__ import annotations

import html
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import quote_plus, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
SUP = ROOT / "runs" / ".loop-supervisor"
SUP.mkdir(parents=True, exist_ok=True)
CACHE_JSON = SUP / "web-strategy-cache.json"
CACHE_MD = SUP / "web-strategy-summary.md"
CURRENT = SUP / "current-map.json"

MAP_NAMES = {
    0: "Pallet Town",
    1: "Viridian City",
    2: "Pewter City",
    12: "Route 2",
    13: "Route 3",
    37: "Player house",
    38: "Player house",
    40: "Oak Lab",
    43: "Viridian Trainer School",
}

CURATED = {
    "Pallet Town": [
        "If starting out, go north to Route 1; after receiving Oak's Parcel from Viridian Mart, return to Oak's Lab.",
    ],
    "Viridian City": [
        "Early story: enter Viridian Mart to receive Oak's Parcel, then return south to Pallet/Oak's Lab.",
        "Avoid wasting time in Trainer School/sign dialogs; if inside, exit south/down and sidestep after doorway.",
    ],
    "Route 1": [
        "Route 1 connects Pallet (south) and Viridian (north); use ledge-aware routing and avoid two-tile ping-pong.",
    ],
    "Route 2": [
        "Route 2 leads toward Viridian Forest/Pewter; proceed north after Pokedex/Parcel objective is complete.",
    ],
    "Pewter City": [
        "Brock uses Rock/Ground line; Water/Grass attacks are strong. Heal before gym.",
    ],
}


def load_current_place() -> str:
    try:
        data = json.loads(CURRENT.read_text())
        latest = data.get("latest") or {}
        m = latest.get("map")
        if isinstance(m, int) and m in MAP_NAMES:
            return MAP_NAMES[m]
        if isinstance(m, str) and m.isdigit() and int(m) in MAP_NAMES:
            return MAP_NAMES[int(m)]
    except Exception:
        pass
    return "Pokemon Red early game Viridian City Route 1 Brock"


def fetch(url: str, timeout: int = 10) -> str:
    req = Request(url, headers={"User-Agent": "Mozilla/5.0 poke-pi-strategy-cache"})
    with urlopen(req, timeout=timeout) as r:
        return r.read(300_000).decode("utf-8", "ignore")


def search_web(query: str) -> list[dict[str, str]]:
    # DuckDuckGo Lite has a stable simple HTML surface. If it changes or is blocked,
    # callers still get curated fallback notes.
    url = f"https://lite.duckduckgo.com/lite/?q={quote_plus(query)}"
    try:
        page = fetch(url)
    except Exception as e:
        return [{"title": "web-search-error", "url": "", "snippet": str(e)[:180]}]
    rows: list[dict[str, str]] = []
    for m in re.finditer(r'<a rel="nofollow" href="(?P<url>[^"]+)"[^>]*>(?P<title>.*?)</a>', page, re.I | re.S):
        title = re.sub(r"<.*?>", "", m.group("title"))
        title = html.unescape(re.sub(r"\s+", " ", title)).strip()
        link = html.unescape(m.group("url"))
        if not title or not link:
            continue
        domain = urlparse(link).netloc
        rows.append({"title": title[:140], "url": link, "snippet": domain})
        if len(rows) >= 5:
            break
    return rows


def main() -> int:
    place = load_current_place()
    query = f"Pokemon Red walkthrough {place} next objective strategy"
    results = search_web(query)
    notes = []
    for key, vals in CURATED.items():
        if key.lower() in place.lower() or key in ("Route 1", "Viridian City", "Pewter City"):
            notes.extend(vals)
    if not notes:
        notes = ["Follow story progression: Parcel → Oak/Pokedex → Route 2/Forest → Pewter/Brock; heal before risky fights."]

    record = {
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "place": place,
        "query": query,
        "results": results,
        "notes": notes[:8],
    }
    CACHE_JSON.write_text(json.dumps(record, ensure_ascii=False, indent=2))
    lines = ["# Web strategy cache", "", f"- Updated: {record['updatedAt']}", f"- Place/query: `{query}`", "", "## Search results"]
    for r in results[:5]:
        lines.append(f"- {r.get('title','')} — {r.get('url','')} ({r.get('snippet','')})")
    lines += ["", "## Actionable notes"]
    for n in notes[:8]:
        lines.append(f"- {n}")
    CACHE_MD.write_text("\n".join(lines) + "\n")
    print(json.dumps({"ok": True, "place": place, "results": len(results), "cache": str(CACHE_MD.relative_to(ROOT))}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
