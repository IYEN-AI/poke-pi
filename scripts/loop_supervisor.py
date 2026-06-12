#!/usr/bin/env python3
"""Supervise poke-pi runs: watch latest state, maintain current-map memory, restart radically on loops."""
from __future__ import annotations
import json, glob, os, signal, subprocess, time, fcntl
from pathlib import Path
from collections import deque, Counter

ROOT = Path(__file__).resolve().parents[1]
RUNS = ROOT / "runs"
SUP = RUNS / ".loop-supervisor"
SUP.mkdir(parents=True, exist_ok=True)
EVENTS = SUP / "events.jsonl"
LOCK = SUP / "loop_supervisor.lock"
CURRENT = SUP / "current-map.json"
SUMMARY = SUP / "map-memory-summary.md"
CHECK_SEC = float(os.environ.get("POKE_SUPERVISOR_POLL", "8"))
WINDOW = int(os.environ.get("POKE_SUPERVISOR_WINDOW", "10"))
STUCK_COORD_THRESHOLD = int(os.environ.get("POKE_SUPERVISOR_STUCK", "8"))

MAP_NAMES = {
    0: "Pallet Town", 1: "Viridian City", 2: "Pewter City", 12: "Route 2", 13: "Route 3",
    37: "Player house 1F", 38: "Player house 2F", 40: "Oak Lab", 43: "Viridian Trainer School",
    44: "Viridian Mart",
}
TRAINER_SCHOOL_PHRASES = ("memorize", "notes", "Whew! I trying")
recent = deque(maxlen=WINDOW)
last_seen_file = None
restarts = 0


def event(kind: str, **data):
    rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "kind": kind, **data}
    with EVENTS.open("a") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    print(json.dumps(rec, ensure_ascii=False), flush=True)


def state_files():
    return sorted(RUNS.glob("*/states/*.json"), key=lambda p: p.stat().st_mtime)


def load_state(path: Path):
    d = json.load(path.open())
    s = d.get("state", d)
    def first(*keys):
        for k in keys:
            if s.get(k) is not None: return s.get(k)
        return None
    return {
        "file": str(path.relative_to(ROOT)),
        "run": path.parts[-3],
        "map": first("map", "mapId", "wCurMap"),
        "y": first("y", "yCoord", "wYCoord"),
        "x": first("x", "xCoord", "wXCoord"),
        "facing": first("facing", "playerFacingDirection"),
        "text": (first("screenText", "text") or "")[:160],
        "textKind": first("screenTextKind", "textKind"),
        "hp": first("playerHp", "hp"),
        "rawMtime": path.stat().st_mtime,
    }


def write_memory(st):
    m = st.get("map")
    loc = f"map {m} ({MAP_NAMES.get(int(m), 'unknown') if isinstance(m, int) else 'unknown'}) y={st.get('y')} x={st.get('x')} facing={st.get('facing')}"
    data = {"updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "location": loc, "latest": st, "recent": list(recent)}
    CURRENT.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    counts = Counter((r.get("map"), r.get("y"), r.get("x")) for r in recent)
    lines = ["# Current map memory", "", f"- Latest: `{loc}`", f"- Latest text: `{st.get('text','')}`", "", "## Recent coordinate frequency"]
    for (m,y,x), c in counts.most_common(8):
        lines.append(f"- map {m} {MAP_NAMES.get(int(m), 'unknown') if isinstance(m, int) else 'unknown'} y={y} x={x}: {c}/{len(recent)}")
    lines += ["", "## Supervisor rule", "- If same coord/text repeats too much, kill stale run and restart strategy-loop with anti-loop objective."]
    SUMMARY.write_text("\n".join(lines) + "\n")


def active_loop_pids():
    try:
        out = subprocess.check_output(["pgrep", "-f", r"(src/index.ts|npm run harness).*(run --policy|strategy-loop|play-policy|llm|play)"], text=True)
        return sorted({int(x) for x in out.split() if x.strip().isdigit() and int(x) != os.getpid()})
    except subprocess.CalledProcessError:
        return []


def kill_loops(reason):
    pids = active_loop_pids()
    event("kill_loops", reason=reason, pids=pids)
    for pid in pids:
        try:
            os.killpg(os.getpgid(pid), signal.SIGTERM)
        except ProcessLookupError:
            pass
        except Exception:
            try: os.kill(pid, signal.SIGTERM)
            except ProcessLookupError: pass
    time.sleep(2)
    for pid in active_loop_pids():
        try:
            os.killpg(os.getpgid(pid), signal.SIGKILL)
        except ProcessLookupError: pass
        except Exception:
            try: os.kill(pid, signal.SIGKILL)
            except ProcessLookupError: pass


def restart_strategy(st, reason):
    global restarts
    restarts += 1
    prefix = f"supervised-map-memory-r{restarts}"
    map44_hint = ""
    if st.get("map") == 44:
        map44_hint = " Viridian Mart: if facing/talking to nickname NPC/counter with no story progress, stop A/up; exit south/down via bottom mat, then return to Oak if Parcel obtained."
    objective = (
        "LLM 감독 재시작: current-map/critic/schema를 보고 이전 판단 폐기. "
        f"최근 map={st.get('map')} y={st.get('y')} x={st.get('x')} text={st.get('text')[:32]!r}."
        f"{map44_hint} 반복 좌표/대사면 A·왕복 금지, 새 경로. "
        "목표: Parcel→Oak/Pokedex→Forest→Brock."
    )[:500]
    cmd = ["npm", "run", "harness", "--", "strategy-loop", "--iterations", "1000000000", "--max-steps", "60", "--poll-ms", "1000", "--llm-every", "1", "--run-id-prefix", prefix, "--port", "3030", "--objective", objective]
    log = SUP / f"restart-{restarts}.log"
    event("restart_strategy", reason=reason, prefix=prefix, objective=objective, log=str(log.relative_to(ROOT)))
    with log.open("ab") as f:
        subprocess.Popen(cmd, cwd=ROOT, stdout=f, stderr=subprocess.STDOUT, start_new_session=True)


def state_index(st):
    try:
        return int(Path(st.get("file", "")).stem)
    except Exception:
        return 0


def is_stuck(st):
    if len(recent) < min(5, WINDOW):
        return False, ""
    coords = [(r.get("map"), r.get("y"), r.get("x")) for r in recent]
    top_coord, top_count = Counter(coords).most_common(1)[0]
    texts = [r.get("text") or "" for r in recent]
    repeated_text = Counter(texts).most_common(1)[0][1] >= 4 and Counter(texts).most_common(1)[0][0] != ""
    trainer_school_text = st.get("map") == 43 and any(p in " ".join(texts) for p in TRAINER_SCHOOL_PHRASES)
    trainer_school_map_loop = bool(recent) and all(r.get("map") == 43 for r in recent) and state_index(st) >= 25
    active = bool(active_loop_pids())
    if active and top_count >= STUCK_COORD_THRESHOLD and (repeated_text or trainer_school_text):
        return True, f"same_coord={top_coord} count={top_count}/{len(recent)} repeated_text={repeated_text} trainer_school_text={trainer_school_text}; force LLM reroute"
    if active and top_count >= STUCK_COORD_THRESHOLD and state_index(st) >= 30:
        return True, f"same_coord={top_coord} count={top_count}/{len(recent)} text_empty_ok=true index={state_index(st)}; allow scout evidence first, then force LLM reroute"
    if active and trainer_school_map_loop:
        return True, f"trainer_school_map_loop index={state_index(st)} recentWindowAllMap43=true; force exit south/down, avoid A/NPC/blackboard"
    return False, ""


def seed_recent_from_disk():
    global last_seen_file
    files_all = state_files()
    if not files_all:
        return
    latest_run = files_all[-1].parts[-3]
    files = [p for p in files_all if p.parts[-3] == latest_run][-WINDOW:]
    for path in files:
        try:
            st = load_state(path)
        except Exception:
            continue
        recent.append(st)
        last_seen_file = str(path)
    if recent:
        write_memory(recent[-1])
        event("seed_recent", count=len(recent), latest=recent[-1].get("file"), map=recent[-1].get("map"), y=recent[-1].get("y"), x=recent[-1].get("x"), text=recent[-1].get("text", "")[:80])


def main():
    lock_f = LOCK.open("w")
    try:
        fcntl.flock(lock_f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        event("supervisor_exit_duplicate", pid=os.getpid())
        return
    lock_f.write(str(os.getpid()))
    lock_f.flush()
    event("supervisor_start", pollSec=CHECK_SEC, window=WINDOW, stuckThreshold=STUCK_COORD_THRESHOLD)
    global last_seen_file
    seed_recent_from_disk()
    idle = 0
    while True:
        files = state_files()
        if not files:
            idle += 1; event("idle_no_states", idle=idle); time.sleep(CHECK_SEC); continue
        latest = files[-1]
        st = load_state(latest)
        if str(latest) != last_seen_file:
            last_seen_file = str(latest); idle = 0
            # If a new run starts, discard stale coordinates from previous killed
            # runs. Otherwise old Viridian Mart coordinates can repeatedly trip
            # stuck detection and kill the current LLM while it is still moving.
            if recent and st.get("run") != recent[-1].get("run"):
                recent.clear()
            recent.append(st); write_memory(st)
            event("state", run=st["run"], file=st["file"], map=st["map"], y=st["y"], x=st["x"], facing=st["facing"], text=st["text"][:80])
            stuck, reason = is_stuck(st)
            if stuck:
                kill_loops(reason)
                restart_strategy(st, reason)
                recent.clear()
        else:
            idle += 1
            if idle in (3, 6):
                event("idle_no_new_state", idle=idle, activePids=active_loop_pids())
            if idle >= 6 and not active_loop_pids():
                restart_strategy(st, "no active loop and no new states")
                idle = 0
        time.sleep(CHECK_SEC)

if __name__ == "__main__":
    main()
