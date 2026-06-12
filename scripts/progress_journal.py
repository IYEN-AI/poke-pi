#!/usr/bin/env python3
"""Append long-horizon Pokemon progress notes from poke-pi telemetry.

Outputs under runs/.progress-journal/:
- events.jsonl: durable structured timeline
- summary.md: human-readable current state / milestones / recent movement
- last_snapshot.json: dedupe state
"""
from __future__ import annotations

import glob
import json
import os
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "runs" / ".progress-journal"
OUT.mkdir(parents=True, exist_ok=True)
EVENTS = OUT / "events.jsonl"
SUMMARY = OUT / "summary.md"
LAST = OUT / "last_snapshot.json"
STATUS_URL = os.environ.get("POKE_STATUS_URL", "http://127.0.0.1:3030/api/control/status")

MAP_NAMES = {
    0: "Pallet Town",
    1: "Viridian City",
    2: "Pewter City",
    12: "Route 2/Route 1 area",
    13: "Route 3",
    37: "Player house 1F",
    38: "Player house 2F",
    40: "Oak Lab",
    43: "Viridian Trainer School",
}


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def write_json(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def get_status() -> dict[str, Any]:
    try:
        with urlopen(STATUS_URL, timeout=5) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:
        return {"error": f"status_unreachable: {e}"}


def latest_state_files(limit: int = 40) -> list[Path]:
    files = [Path(p) for p in glob.glob(str(ROOT / "runs" / "*" / "states" / "*.json"))]
    files = [p for p in files if ".progress-journal" not in str(p)]
    return sorted(files, key=lambda p: p.stat().st_mtime)[-limit:]


def flatten_state_file(path: Path) -> dict[str, Any] | None:
    try:
        d = json.loads(path.read_text())
    except Exception:
        return None
    s = d.get("state", d)
    coords = s.get("coordinates") or {}
    party = s.get("party") or {}
    menu = s.get("menuText") or {}
    battle_state = s.get("battleState") or {}
    battle = s.get("battle") or {}
    loc = {
        "mapId": coords.get("mapId", s.get("mapId", s.get("wCurMap"))),
        "y": coords.get("y", s.get("y", s.get("wYCoord"))),
        "x": coords.get("x", s.get("x", s.get("wXCoord"))),
        "facing": (s.get("playerFacing") or {}).get("direction", s.get("playerFacingDirection")),
    }
    text = menu.get("screenText", s.get("screenText", "")) or ""
    return {
        "file": str(path.relative_to(ROOT)),
        "runId": path.parts[-3],
        "mtime": path.stat().st_mtime,
        "step": d.get("step"),
        "frame": d.get("frame"),
        "loc": loc,
        "text": text[:200],
        "textKind": menu.get("screenTextKind", s.get("screenTextKind")),
        "battleKind": battle.get("kind"),
        "wIsInBattle": s.get("wIsInBattle"),
        "partyCount": party.get("count", s.get("wPartyCount")),
        "hp": (party.get("firstPokemonHp") or {}).get("current", s.get("wPartyMon1HP")),
        "maxHp": (party.get("firstPokemonHp") or {}).get("max", s.get("wPartyMon1MaxHP")),
        "enemyHp": battle_state.get("enemyMonHp", s.get("wEnemyMonHP")),
        "badges": s.get("badgeCount"),
    }


def append_event(kind: str, **data: Any) -> None:
    rec = {"ts": now(), "kind": kind, **data}
    with EVENTS.open("a") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    print(json.dumps(rec, ensure_ascii=False))


def infer_milestones(status: dict[str, Any], latest: dict[str, Any] | None, recent: list[dict[str, Any]]) -> list[str]:
    milestones: list[str] = []
    loc = (latest or {}).get("loc") or {}
    map_id = loc.get("mapId")
    party_count = (latest or {}).get("partyCount")
    if party_count and party_count >= 1:
        milestones.append("starter_acquired")
    if any((r.get("battleKind") == "trainer" or r.get("wIsInBattle") == 2) for r in recent):
        milestones.append("trainer_battle_seen")
    if map_id not in (37, 38, 40, None):
        milestones.append("left_oak_lab")
    if map_id == 1:
        milestones.append("reached_viridian_city")
    if map_id == 43:
        milestones.append("entered_trainer_school")
    if (latest or {}).get("badges", 0):
        milestones.append(f"badges_{(latest or {}).get('badges')}")
    prog = (((status.get("activeRun") or {}).get("latestTelemetry") or {}).get("progress") or {}).get("checkpoints") or {}
    for k, v in prog.items():
        if v:
            milestones.append(k)
    return sorted(set(milestones))


def write_summary(status: dict[str, Any], latest: dict[str, Any] | None, recent: list[dict[str, Any]], milestones: list[str]) -> None:
    active = status.get("activeRun") or {}
    telem = active.get("latestTelemetry") or {}
    loc = (latest or {}).get("loc") or telem.get("location") or {}
    map_id = loc.get("mapId")
    coords = [
        ((r.get("loc") or {}).get("mapId"), (r.get("loc") or {}).get("y"), (r.get("loc") or {}).get("x"))
        for r in recent
    ]
    top = Counter(coords).most_common(5)
    lines = [
        "# Pokemon long-term progress journal",
        "",
        f"- Updated: `{now()}`",
        f"- Active run: `{active.get('runId')}` kind=`{active.get('kind')}` running=`{status.get('running')}`",
        f"- Latest location: map `{map_id}` ({MAP_NAMES.get(map_id, 'unknown')}) y=`{loc.get('y')}` x=`{loc.get('x')}` facing=`{loc.get('facing')}`",
        f"- Latest text: `{(latest or {}).get('text', '')[:120]}`",
        f"- Party: count=`{(latest or {}).get('partyCount')}` HP=`{(latest or {}).get('hp')}/{(latest or {}).get('maxHp')}`",
        f"- LLM calls in active run: `{(((telem.get('progress') or {}).get('llmCalls')) or 0)}`",
        "",
        "## Milestones inferred",
    ]
    lines += [f"- {m}" for m in milestones] or ["- none yet"]
    lines += ["", "## Recent coordinate frequency"]
    for (m, y, x), c in top:
        lines.append(f"- map {m} ({MAP_NAMES.get(m, 'unknown')}) y={y} x={x}: {c}/{len(recent)}")
    lines += ["", "## Recent states"]
    for r in recent[-10:]:
        l = r.get("loc") or {}
        lines.append(f"- `{r.get('runId')}` step={r.get('step')} map={l.get('mapId')} y={l.get('y')} x={l.get('x')} face={l.get('facing')} text=`{r.get('text','')[:60]}`")
    SUMMARY.write_text("\n".join(lines) + "\n")


def main() -> int:
    status = get_status()
    states = [s for s in (flatten_state_file(p) for p in latest_state_files()) if s]
    latest = states[-1] if states else None
    milestones = infer_milestones(status, latest, states[-20:])
    last = read_json(LAST, {}) or {}

    snapshot = {
        "ts": now(),
        "activeRunId": (status.get("activeRun") or {}).get("runId"),
        "activeKind": (status.get("activeRun") or {}).get("kind"),
        "latestFile": (latest or {}).get("file"),
        "loc": (latest or {}).get("loc"),
        "text": (latest or {}).get("text"),
        "partyCount": (latest or {}).get("partyCount"),
        "hp": (latest or {}).get("hp"),
        "maxHp": (latest or {}).get("maxHp"),
        "milestones": milestones,
    }

    # Always update current summary; append timeline only on meaningful change.
    write_summary(status, latest, states[-20:], milestones)
    changed = False
    for key in ("activeRunId", "activeKind", "latestFile", "loc", "text", "partyCount", "hp", "maxHp", "milestones"):
        if snapshot.get(key) != last.get(key):
            changed = True
            break
    if changed:
        append_event("progress_snapshot", **snapshot)
        write_json(LAST, snapshot)
    else:
        print(json.dumps({"ts": now(), "kind": "no_change", "activeRunId": snapshot.get("activeRunId"), "loc": snapshot.get("loc")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
