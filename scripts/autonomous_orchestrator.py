#!/usr/bin/env python3
"""Autonomous poke-pi orchestration watchdog.

Layering model requested by Victor:
  1) heuristic strategy-loop is always the actor that keeps moving;
  2) critic/movement-monitor always watches heuristic output and writes feedback;
  3) loop_supervisor maintains memory-map files and detects hard loops;
  4) this Python orchestrator sits above them: reads RAM/state files, map memory,
     critic feedback, progress journal, and web strategy cache; then kills/restarts
     the actor only when the top-level judgment says the current loop is bad.

Cron should only keep this daemon alive. The daemon itself runs every ~50s.
"""
from __future__ import annotations

import glob
import json
import os
import re
import signal
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
SUP = ROOT / "runs" / ".loop-supervisor"
SUP.mkdir(parents=True, exist_ok=True)
LOG = SUP / "autonomous-orchestrator.log"
STATUS_URL = "http://127.0.0.1:3030/api/control/status"

GAMEPLAY_RE = re.compile(r"src/index\.ts (strategy-loop|progress|run --policy|play-policy|llm|play)")
STRATEGY_RE = re.compile(r"src/index\.ts (strategy-loop|progress)")
RUN_RE = re.compile(r"src/index\.ts run --policy")
CRITIC_RE = re.compile(r"src/index\.ts (critic|movement-monitor)|scripts/critic_forever\.sh")
LOOP_SUP_RE = re.compile(r"scripts/loop_supervisor\.py")

MAP_MEMORY_JSON = SUP / "current-map.json"
MAP_MEMORY_MD = SUP / "map-memory-summary.md"
WEB_CACHE_JSON = SUP / "web-strategy-cache.json"
WEB_CACHE_MD = SUP / "web-strategy-summary.md"
DECRYPTED_MAP_JSON = SUP / "decrypted-memory-map.json"
DECRYPTED_MAP_MD = SUP / "decrypted-memory-map-summary.md"
STRATEGY_SCHEMA_JSON = SUP / "game-strategy-schema.json"
STRATEGY_SCHEMA_MD = SUP / "game-strategy-schema.md"
PROGRESS_MD = ROOT / "runs" / ".progress-journal" / "summary.md"


def sh(cmd: list[str] | str, timeout: int = 20) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout, shell=isinstance(cmd, str))


def log(msg: str) -> None:
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} {msg}"
    with LOG.open("a") as f:
        f.write(line + "\n")
    print(line)


def get_status() -> dict[str, Any]:
    try:
        with urlopen(STATUS_URL, timeout=5) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        return {"error": str(e), "running": False}


def ps_lines() -> list[str]:
    out = sh("ps aux | grep -E 'src/index.ts (strategy-loop|progress|run --policy|llm|play-policy|critic|movement-monitor|ui)|loop_supervisor.py' | grep -v grep || true").stdout
    return [ln for ln in out.splitlines() if ln.strip()]


def pids_matching(pattern: re.Pattern[str]) -> list[int]:
    pids: list[int] = []
    for ln in ps_lines():
        if pattern.search(ln):
            parts = ln.split()
            if len(parts) > 1 and parts[1].isdigit():
                pids.append(int(parts[1]))
    return pids


def kill_pids(pids: list[int], grace: float = 1.0) -> None:
    me = os.getpid()
    for pid in pids:
        if pid == me:
            continue
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    time.sleep(grace)


def kill_gameplay() -> list[int]:
    pids = pids_matching(GAMEPLAY_RE)
    kill_pids(pids, 1.5)
    return pids


def latest_states(n: int = 24) -> list[dict[str, Any]]:
    files = sorted([Path(p) for p in glob.glob(str(ROOT / "runs" / "*" / "states" / "*.json"))], key=lambda p: p.stat().st_mtime)[-n:]
    states: list[dict[str, Any]] = []
    for p in files:
        try:
            d = json.loads(p.read_text()); s = d.get("state", d); c = s.get("coordinates") or {}; m = s.get("menuText") or {}; b = s.get("battle") or {}
            states.append({
                "runId": p.parts[-3], "file": str(p.relative_to(ROOT)), "mtime": p.stat().st_mtime, "step": d.get("step"),
                "map": c.get("mapId", s.get("wCurMap", s.get("mapId"))), "y": c.get("y", s.get("wYCoord", s.get("y"))), "x": c.get("x", s.get("wXCoord", s.get("x"))),
                "facing": (s.get("playerFacing") or {}).get("direction", s.get("playerFacingDirection")),
                "text": m.get("screenText", s.get("screenText", s.get("text", ""))) or "",
                "battle": b.get("kind") or s.get("wIsInBattle"),
                "party": (s.get("party") or {}).get("count", s.get("wPartyCount")),
                "hp": ((s.get("party") or {}).get("firstPokemonHp") or {}).get("current", s.get("wPartyMon1HP")),
            })
        except Exception:
            continue
    return states


def read_text_file(path: Path, max_chars: int = 1800) -> str:
    try:
        return path.read_text(errors="ignore")[-max_chars:]
    except Exception:
        return ""


def read_json_file(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text())
    except Exception:
        return {}


def latest_feedback() -> dict[str, Any]:
    files = sorted(glob.glob(str(ROOT / "runs" / ".movement-feedback" / "*.json")), key=os.path.getmtime)
    if not files:
        return {}
    try:
        return json.loads(Path(files[-1]).read_text())
    except Exception:
        return {"file": files[-1], "error": "failed_to_parse"}


def coord_loop(states: list[dict[str, Any]]) -> tuple[bool, str]:
    """Detect real loops in the currently active/fresh run only.

    Earlier versions mixed states from old killed runs, so a previously stuck
    coordinate (notably Viridian Mart map 44/5/3) kept triggering restarts even
    while the newest LLM run was moving. That made the on-screen player appear
    idle because each LLM child got killed before it could complete enough steps.
    """
    if not states:
        return False, "no_states"
    latest_run = states[-1].get("runId")
    now = time.time()
    same_run_recent = [
        s for s in states
        if s.get("runId") == latest_run and now - float(s.get("mtime") or 0) < 180
    ][-12:]
    if len(same_run_recent) < 8:
        return False, f"insufficient_fresh_same_run_states run={latest_run} n={len(same_run_recent)}"
    coords = [(s.get("map"), s.get("y"), s.get("x")) for s in same_run_recent]
    counts = Counter(coords)
    top, cnt = counts.most_common(1)[0] if counts else ((None, None, None), 0)
    text_any = any((s.get("text") or "").strip() for s in same_run_recent)
    battle_any = any(s.get("battle") not in (None, 0, "none") for s in same_run_recent)
    top2 = counts.most_common(2)
    pingpong = len(top2) == 2 and sum(c for _, c in top2) >= 10 and len({c[0] for c, _ in top2}) == 1
    stuck = (cnt >= 8 or pingpong) and not battle_any
    reason = f"run={latest_run} top={top} count={cnt}/{len(same_run_recent)} pingpong={pingpong} text={text_any} battle={battle_any}"
    return stuck, reason


def ensure_progress_journal() -> None:
    sh([sys.executable, "scripts/progress_journal.py"], timeout=20)


def ensure_web_strategy_cache(force: bool = False) -> bool:
    stale = True
    if WEB_CACHE_JSON.exists():
        stale = (time.time() - WEB_CACHE_JSON.stat().st_mtime) > 30 * 60
    if not force and not stale:
        return False
    res = sh([sys.executable, "scripts/pokemon_strategy_research.py"], timeout=25)
    if res.returncode != 0:
        log(f"web_strategy_refresh_failed rc={res.returncode} out={res.stdout[-300:]}")
    return res.returncode == 0


def ensure_decrypted_memory_map() -> bool:
    """Decode live WRAM wOverworldMap into tactical direction candidates."""
    res = sh([sys.executable, "scripts/decrypt_memory_map.py"], timeout=35)
    if res.returncode != 0:
        log(f"decrypted_memory_map_failed rc={res.returncode} out={res.stdout[-300:]}")
    return res.returncode == 0


def ensure_loop_supervisor() -> bool:
    if pids_matching(LOOP_SUP_RE):
        return False
    cmd = "POKE_SUPERVISOR_POLL=5 POKE_SUPERVISOR_WINDOW=12 POKE_SUPERVISOR_STUCK=7 nohup python3 scripts/loop_supervisor.py >> runs/.loop-supervisor/cron-supervisor.log 2>&1 &"
    sh(cmd, timeout=5)
    return True


def ensure_critic() -> bool:
    if pids_matching(CRITIC_RE):
        return False
    cmd = "nohup bash scripts/critic_forever.sh >> runs/.loop-supervisor/critic.log 2>&1 &"
    sh(cmd, timeout=5)
    return True


def context_bundle(states: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "latestState": states[-1] if states else {},
        "mapMemory": read_text_file(MAP_MEMORY_MD, 1200),
        "mapMemoryJson": read_json_file(MAP_MEMORY_JSON),
        "decryptedMemoryMap": read_text_file(DECRYPTED_MAP_MD, 1200),
        "decryptedMemoryMapJson": read_json_file(DECRYPTED_MAP_JSON),
        "criticFeedback": latest_feedback(),
        "webStrategy": read_text_file(WEB_CACHE_MD, 1200),
        "strategySchema": read_json_file(STRATEGY_SCHEMA_JSON),
        "strategySchemaText": read_text_file(STRATEGY_SCHEMA_MD, 1200),
        "progress": read_text_file(PROGRESS_MD, 1200),
    }


def compact_context_text(ctx: dict[str, Any]) -> str:
    """Make a <=260-char strategy brief so all layers survive the 500-char CLI objective cap."""
    latest = ctx.get("latestState") or {}
    map_json = ctx.get("mapMemoryJson") or {}
    location = map_json.get("location") or f"map={latest.get('map')} y={latest.get('y')} x={latest.get('x')}"
    recent = map_json.get("recent") or []
    coords = Counter((r.get("map"), r.get("y"), r.get("x")) for r in recent if isinstance(r, dict)).most_common(2)
    coord_hint = ",".join(f"{m}/{y}/{x}x{c}" for (m, y, x), c in coords)[:45]
    feedback_obj = ctx.get("criticFeedback") or {}
    feedback = json.dumps(feedback_obj, ensure_ascii=False)
    # Prefer semantic fields if the monitor has them; otherwise keep a tiny raw tail.
    critic_hint = str(feedback_obj.get("summary") or feedback_obj.get("kind") or feedback_obj.get("status") or feedback)[:70]
    web_lines = [ln[2:] for ln in str(ctx.get("webStrategy") or "").splitlines() if ln.startswith("- ") and "Updated:" not in ln and "Place/query:" not in ln]
    web_hint = "; ".join(web_lines[-3:])[:110]
    dec = ctx.get("decryptedMemoryMapJson") or {}
    dec_loc = dec.get("location") or {}
    dec_dirs = dec.get("directionCandidates") or []
    dir_hint = ",".join(f"{d.get('direction')}:{(d.get('semantic') or {}).get('kind')}" for d in dec_dirs if isinstance(d, dict))[:70]
    schema = ctx.get("strategySchema") or {}
    map_id = str(latest.get("map"))
    map_rule = ((schema.get("knownMaps") or {}).get(map_id) or {}) if isinstance(schema, dict) else {}
    restart_template = str(schema.get("actorRestartObjectiveTemplate") or "") if isinstance(schema, dict) else ""
    schema_hint = ""
    if restart_template:
        schema_hint = f"schemaObjective {restart_template}"[:170]
    if map_rule:
        avoid = ";".join(str(x) for x in (map_rule.get("policy") or map_rule.get("avoid") or [])[-2:])
        rule_hint = f"schema {map_rule.get('label') or map_id}: {avoid or map_rule.get('antiLoopRule') or ''}"[:125]
        schema_hint = (schema_hint + "; " + rule_hint)[:220] if schema_hint else rule_hint
    progress_hint = re.sub(r"\s+", " ", str(ctx.get("progress") or ""))[:70]
    return (
        f"RAM {latest.get('map')}/{latest.get('y')}/{latest.get('x')} face={latest.get('facing')} text={str(latest.get('text') or '')[:28]!r}; "
        f"mapMem {location} freq={coord_hint}; decrypt {dec_loc.get('mapId')}/{dec_loc.get('y')}/{dec_loc.get('x')} dirs={dir_hint}; critic {critic_hint}; {schema_hint}; web {web_hint}; prog {progress_hint}"
    )[:280]


def start_strategy(mode: str, reason: str, states: list[dict[str, Any]]) -> None:
    """Start the always-on heuristic actor.

    mode changes only how often LLM synthesis/overrides occur inside strategy-loop.
    The underlying actor remains strategy-loop(policy=heuristic), while critic + this
    orchestrator supervise above it.
    """
    ctx = context_bundle(states)
    ctext = compact_context_text(ctx)
    if mode == "fast-hybrid":
        llm_every = "4"; max_steps = "90"; prefix = "heuristic-always-fast"
        directive = "휴리스틱 상시주행. critic/map-memory/web전략을 반영하되 속도 우선. 막히면 큰 우회, 대화/전투/회복만 LLM 판단."
    elif mode == "llm-critic":
        llm_every = "1"; max_steps = "45"; prefix = "heuristic-critic-llm"
        directive = "휴리스틱은 계속 actor, 매 반복 LLM이 critic처럼 판단해 휴리스틱 결정을 고쳐라. Stage1/wait/좌우왕복 금지."
    else:
        llm_every = "1"; max_steps = "70"; prefix = "heuristic-always"
        directive = "휴리스틱 상시 actor + critic 감시 + 매 반복 LLM 판단. current-map/RAM/web전략을 합쳐 진행."
    objective = (
        f"{directive} 이유={reason}. {ctext}. "
        "장기목표: Oak Parcel→Pokedex→Route2/Forest→Pewter→Brock. "
        "Mart44 4/5 nickname NPC면 A/up 금지, south exit. "
        "Viridian Trainer School/표지판/NPC 대화 루프면 A 금지, 남쪽 출구 후 좌우로 비켜라. "
        "전투/대화/회복 우선, 같은 좌표·텍스트 반복 시 즉시 새 경로."
    )[:500]
    killed = kill_gameplay()
    cmd = ["npm", "run", "harness", "--", "strategy-loop", "--iterations", "1000000000", "--max-steps", max_steps, "--poll-ms", "1000", "--llm-every", llm_every, "--run-id-prefix", prefix, "--port", "3030", "--objective", objective]
    with (SUP / f"{prefix}.log").open("ab") as f:
        subprocess.Popen(cmd, cwd=ROOT, stdout=f, stderr=subprocess.STDOUT, start_new_session=True)
    log(f"restart actor=heuristic strategy-loop mode={mode} killed={killed} reason={reason} objective={objective}")


def main() -> int:
    ensure_progress_journal()
    decrypted = ensure_decrypted_memory_map()
    web_refreshed = ensure_web_strategy_cache()
    sup_started = ensure_loop_supervisor()
    critic_started = ensure_critic()

    status = get_status()
    active = status.get("activeRun") or {}
    telem = active.get("latestTelemetry") or {}
    progress = telem.get("progress") or {}
    last = active.get("lastAction") or active.get("lastDecision") or {}
    rationale = json.dumps(last, ensure_ascii=False)
    states = latest_states(24)
    stuck, stuck_reason = coord_loop(states)
    strategies = pids_matching(STRATEGY_RE)
    runs = pids_matching(RUN_RE)
    critics = pids_matching(CRITIC_RE)

    running = bool(status.get("running"))
    run_id = active.get("runId")
    kind = active.get("kind")
    latest = states[-1] if states else {}
    state_age = time.time() - float(latest.get("mtime") or 0) if latest else 999999
    loc = telem.get("location") or (latest.get("map"), latest.get("y"), latest.get("x"))

    intervene_reason = ""
    mode = "normal"

    # Required invariant: heuristic actor + critic + map loop supervisor exist.
    # Do not require raw `run --policy`; strategy-loop controls that internally and may not show as a separate process.
    if not strategies:
        intervene_reason = f"heuristic_actor_missing runId={run_id} running={running} strategies={strategies}"
        mode = "llm-critic"
    elif not critics:
        intervene_reason = "critic_missing_restart_actor_after_starting_critic"
        mode = "normal"
    elif (not running or not run_id or state_age > 300) and not strategies:
        intervene_reason = f"no_fresh_control_run runId={run_id} running={running} stateAge={int(state_age)}"
        mode = "llm-critic"
    elif "Stage 1" in rationale or "avoid unnecessary movement" in rationale or re.search(r"\bwait\b", rationale, re.I):
        intervene_reason = "idle_or_stage1_wait"
        mode = "llm-critic"
    elif (
        latest.get("map") == 12
        and latest.get("y") == 28
        and latest.get("x") in (10, 11, 12, 13, 14, 15, 16, 17, 18)
        and latest.get("battle") in (None, 0, "none")
    ):
        intervene_reason = f"premature_route2_blocked_pocket {latest.get('runId')} {latest.get('map')}/{latest.get('y')}/{latest.get('x')}"
        mode = "llm-critic"
    elif stuck:
        intervene_reason = f"coord_or_text_loop {stuck_reason}"
        mode = "llm-critic"
    # A single npm strategy-loop commonly appears as two matching node/tsx
    # processes. Treat only >3 as duplicate effective actors; >2 caused false
    # duplicate restarts that killed a healthy LLM-direct run.
    elif len(strategies) > 3:
        intervene_reason = f"duplicate_strategy_pids={strategies}"
        mode = "llm-critic"

    # Keep Victor's requested invariant strict: the stack should continue exercising
    # heuristic actor + critic + LLM critic. Do not auto-downgrade to fast-hybrid;
    # that made LLM health look false between periodic LLM phases and caused the
    # watchdog to fight the orchestrator.

    if intervene_reason:
        start_strategy(mode, intervene_reason, states)
        return 0

    notices = []
    if sup_started:
        notices.append("started loop_supervisor")
    if critic_started:
        notices.append("started critic")
    if web_refreshed:
        notices.append("refreshed web_strategy")
    if decrypted:
        notices.append("decoded/decrypted memory_map")
    if notices:
        log(f"{'; '.join(notices)}; actor=heuristic run={run_id} kind={kind} loc={loc} critics={critics}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
