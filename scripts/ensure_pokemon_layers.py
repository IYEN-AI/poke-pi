#!/usr/bin/env python3
"""Ensure poke-pi's heuristic actor, critic, and LLM layer are all healthy.

This is intentionally stronger than a passive status report:
- verifies mGBA/control liveness when available;
- verifies the full orchestration stack is allowed and alive;
- verifies the actor is running with an LLM-capable strategy loop;
- verifies the critic process and its feedback freshness;
- repairs missing/stale layers without killing healthy layers unnecessarily.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SUP = ROOT / "runs" / ".loop-supervisor"
DISABLE_ORCH = SUP / "disable-autonomous-orchestrator"
DEFAULT_OBJECTIVE = (
    "Full stack guarantee: heuristic actor + critic + LLM critic must all function. "
    "Progress intro→starter→rival→Route1→Viridian Mart Parcel→Oak/Pokedex→Route2/Forest→Pewter/Brock. "
    "If stuck in room/map38, route to stairs/exit; avoid A-spam/stale dialogs."
)[:500]


@dataclass(frozen=True)
class ProcessSnapshot:
    orchestrator: bool
    loop_supervisor: bool
    strategy: bool
    critic: bool
    gameplay_count: int
    raw: str


@dataclass(frozen=True)
class LayerStatus:
    ok: bool
    reason: str


@dataclass(frozen=True)
class EnsureResult:
    ok: bool
    layers: dict[str, LayerStatus]
    required_actions: list[str]
    summary: dict[str, Any]


def sh(cmd: str | list[str], timeout: int = 30) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=ROOT, shell=isinstance(cmd, str), text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)


def get_json(url: str, timeout: float = 8.0) -> dict[str, Any]:
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode())


def parse_time(value: str | None) -> float:
    if not value:
        return 0.0
    text = value.strip().replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text).timestamp()
    except ValueError:
        return 0.0


def node_tsx_process(command: str) -> bool:
    first = command.split(None, 1)[0] if command.strip() else ""
    return first == "node" or first.endswith("/node")


def process_snapshot() -> ProcessSnapshot:
    out = sh("ps aux", timeout=10).stdout
    lines: list[str] = []
    for line in out.splitlines()[1:]:
        parts = line.split(None, 10)
        if len(parts) < 11:
            continue
        command = parts[10]
        if "ensure_pokemon_layers.py" in command or "__hermes" in command:
            continue
        if (
            (node_tsx_process(command) and re.search(r"src/index\.ts (strategy-loop|progress|run --policy|critic|movement-monitor)", command))
            or "scripts/autonomous_orchestrator_daemon.sh" in command
            or "scripts/autonomous_orchestrator.py" in command
            or "scripts/loop_supervisor.py" in command
            or "scripts/critic_forever.sh" in command
        ):
            lines.append(line)
    raw = "\n".join(lines)
    return ProcessSnapshot(
        orchestrator=any("scripts/autonomous_orchestrator_daemon.sh" in ln or "scripts/autonomous_orchestrator.py" in ln for ln in lines),
        loop_supervisor=any("scripts/loop_supervisor.py" in ln for ln in lines),
        strategy=any(re.search(r"src/index\.ts (strategy-loop|progress)", ln) for ln in lines),
        critic=any(re.search(r"src/index\.ts (critic|movement-monitor)", ln) or "scripts/critic_forever.sh" in ln for ln in lines),
        gameplay_count=sum(1 for ln in lines if re.search(r"src/index\.ts (strategy-loop|progress|run --policy)", ln)),
        raw=raw,
    )


def control_status(port: int = 3030) -> dict[str, Any]:
    try:
        return get_json(f"http://127.0.0.1:{port}/api/control/status")
    except Exception as e:
        return {"running": False, "activeRun": None, "error": f"{type(e).__name__}: {e}"}


def live_state(port: int = 3030) -> dict[str, Any]:
    try:
        d = get_json(f"http://127.0.0.1:{port}/api/live")
        s = d.get("state", d)
        c = s.get("coordinates") or {}
        return {
            "map": c.get("mapId", s.get("wCurMap", s.get("mapId"))),
            "y": c.get("y", s.get("wYCoord", s.get("y"))),
            "x": c.get("x", s.get("wXCoord", s.get("x"))),
            "text": (s.get("screenText") or (s.get("menuText") or {}).get("screenText") or "")[:100],
            "frame": d.get("frame"),
        }
    except Exception as e:
        return {"map": None, "y": None, "x": None, "text": f"live_error:{type(e).__name__}", "frame": None}


def latest_feedback() -> dict[str, Any]:
    files = sorted((ROOT / "runs" / ".movement-feedback").glob("*.json"), key=lambda p: p.stat().st_mtime) if (ROOT / "runs" / ".movement-feedback").exists() else []
    if not files:
        return {}
    try:
        return json.loads(files[-1].read_text())
    except Exception:
        return {"error": "failed_to_parse_feedback", "file": str(files[-1])}


def active_summary(status: dict[str, Any]) -> tuple[str | None, str | None, int]:
    active = status.get("activeRun") if isinstance(status, dict) else None
    if not isinstance(active, dict):
        return None, None, 0
    raw_telem = active.get("latestTelemetry")
    telem = raw_telem if isinstance(raw_telem, dict) else {}
    raw_progress = telem.get("progress")
    progress = raw_progress if isinstance(raw_progress, dict) else {}
    llm_calls = progress.get("llmCalls")
    return active.get("runId"), active.get("kind"), llm_calls if isinstance(llm_calls, int) else 0


def evaluate_layers(*, status: dict[str, Any], live: dict[str, Any], feedback: dict[str, Any], processes: ProcessSnapshot, now_epoch: float, disable_sentinel_exists: bool) -> EnsureResult:
    run_id, kind, llm_calls = active_summary(status)
    active = status.get("activeRun") if isinstance(status, dict) else None
    started_at = active.get("startedAt") if isinstance(active, dict) and isinstance(active.get("startedAt"), str) else None
    run_age = now_epoch - parse_time(started_at)
    feedback_age = now_epoch - parse_time(str(feedback.get("updatedAt"))) if feedback.get("updatedAt") else 999999.0
    live_text = str(live.get("text") or "")

    actions: list[str] = []
    layers: dict[str, LayerStatus] = {}

    if disable_sentinel_exists:
        actions.append("remove_disable_sentinel")

    orchestrator_ok = processes.orchestrator
    layers["orchestrator"] = LayerStatus(orchestrator_ok, "daemon/process alive" if orchestrator_ok else "missing autonomous orchestrator")
    if not orchestrator_ok:
        actions.append("start_orchestrator_daemon")

    supervisor_ok = processes.loop_supervisor
    layers["loop_supervisor"] = LayerStatus(supervisor_ok, "loop supervisor alive" if supervisor_ok else "missing loop supervisor")
    if not supervisor_ok:
        actions.append("start_loop_supervisor")

    heuristic_ok = processes.strategy and bool(run_id)
    layers["heuristic"] = LayerStatus(heuristic_ok, f"strategy loop present run={run_id}" if heuristic_ok else "missing strategy-loop actor or active run")

    critic_process_ok = processes.critic
    critic_feedback_ok = feedback_age <= 180
    critic_ok = critic_process_ok and critic_feedback_ok
    critic_reason = f"process={critic_process_ok} feedback_age={int(feedback_age)}s run={feedback.get('runId')}"
    layers["critic"] = LayerStatus(critic_ok, critic_reason)
    if not critic_process_ok:
        actions.append("start_critic")

    # LLM is healthy if the active controlled run is LLM and calls are increasing/nonzero.
    # If not, require a restart into llm-critic mode. A non-empty dialog text is not a
    # failure by itself; the LLM may need to advance it.
    llm_ok = kind == "llm" and (llm_calls > 0 or (run_id is not None and run_age <= 180))
    llm_reason = f"kind={kind} llmCalls={llm_calls} age={int(run_age)}s text={live_text[:40]!r}"
    layers["llm"] = LayerStatus(llm_ok, llm_reason)

    needs_actor_restart = not heuristic_ok or not llm_ok
    # If critic feedback is stale but the process exists, restart actor so the next
    # run produces fresh state/action data for the critic to observe.
    if critic_process_ok and not critic_feedback_ok:
        needs_actor_restart = True
    if needs_actor_restart:
        actions.append("restart_actor_llm_critic")

    # Too many gameplay controllers can fight inputs. Let the orchestrator do the
    # actual cleanup, but flag it as unhealthy.
    duplicate_ok = processes.gameplay_count <= 4
    layers["dedupe"] = LayerStatus(duplicate_ok, f"gameplay_processes={processes.gameplay_count}")
    if not duplicate_ok:
        actions.append("run_orchestrator_once")

    # Preserve order and uniqueness.
    deduped_actions: list[str] = []
    for action in actions:
        if action not in deduped_actions:
            deduped_actions.append(action)

    ok = all(layer.ok for layer in layers.values()) and not deduped_actions
    return EnsureResult(
        ok=ok,
        layers=layers,
        required_actions=deduped_actions,
        summary={"runId": run_id, "kind": kind, "llmCalls": llm_calls, "live": live, "feedbackAgeSeconds": int(feedback_age)},
    )


def pids_matching(pattern: str) -> list[int]:
    out = sh(f"pgrep -f {pattern!r} || true", timeout=10).stdout
    return [int(x) for x in out.split() if x.isdigit() and int(x) != os.getpid()]


def pids_from_ps(regex: re.Pattern[str]) -> list[int]:
    out = sh("ps aux", timeout=10).stdout
    pids: list[int] = []
    for line in out.splitlines()[1:]:
        parts = line.split(None, 10)
        if len(parts) < 11:
            continue
        try:
            pid = int(parts[1])
        except ValueError:
            continue
        if pid == os.getpid():
            continue
        command = parts[10]
        if not node_tsx_process(command):
            continue
        if regex.search(command):
            pids.append(pid)
    return pids


def kill_gameplay() -> list[int]:
    regex = re.compile(r"src/index\.ts (strategy-loop|progress|run --policy|play-policy|llm|play)")
    pids = sorted(set(pids_from_ps(regex) + pids_matching(r"src/index\.ts (strategy-loop|progress|run --policy|play-policy|llm|play)")))
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    if pids:
        time.sleep(3)
    survivors = [pid for pid in pids if Path(f"/proc/{pid}").exists()]
    # macOS has no /proc; fall back to ps for remaining matching commands.
    survivors = sorted(set(survivors + pids_from_ps(regex)))
    for pid in survivors:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if survivors:
        time.sleep(1)
    return sorted(set(pids + survivors))


def start_orchestrator() -> None:
    SUP.mkdir(parents=True, exist_ok=True)
    sh(["bash", "scripts/ensure_autonomous_orchestrator_daemon.sh"], timeout=20)


def start_loop_supervisor() -> None:
    SUP.mkdir(parents=True, exist_ok=True)
    subprocess.Popen([sys.executable, "scripts/loop_supervisor.py"], cwd=ROOT, stdout=open(SUP / "ensure-loop-supervisor.log", "ab"), stderr=subprocess.STDOUT, start_new_session=True)


def start_critic(port: int) -> None:
    SUP.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "PORT": str(port)}
    subprocess.Popen(["bash", "scripts/critic_forever.sh"], cwd=ROOT, env=env, stdout=open(SUP / "ensure-critic-forever.log", "ab"), stderr=subprocess.STDOUT, start_new_session=True)


def restart_actor_llm_critic(port: int, objective: str) -> None:
    killed = kill_gameplay()
    SUP.mkdir(parents=True, exist_ok=True)
    cmd = [
        "npm", "run", "harness", "--", "strategy-loop",
        "--iterations", "1000000000",
        "--max-steps", "45",
        "--poll-ms", "1000",
        "--llm-every", "1",
        "--run-id-prefix", "guaranteed-llm-critic",
        "--port", str(port),
        "--objective", objective[:500],
    ]
    with (SUP / "ensure-actor.log").open("ab") as f:
        f.write((f"\n# restart_actor_llm_critic killed={killed} at {datetime.now().isoformat()}\n").encode())
        subprocess.Popen(cmd, cwd=ROOT, stdout=f, stderr=subprocess.STDOUT, start_new_session=True)


def apply_repairs(actions: list[str], *, port: int, objective: str) -> list[str]:
    applied: list[str] = []
    if "remove_disable_sentinel" in actions and DISABLE_ORCH.exists():
        DISABLE_ORCH.unlink()
        applied.append("remove_disable_sentinel")
    if "start_orchestrator_daemon" in actions:
        start_orchestrator()
        applied.append("start_orchestrator_daemon")
    if "start_loop_supervisor" in actions:
        start_loop_supervisor()
        applied.append("start_loop_supervisor")
    if "start_critic" in actions:
        start_critic(port)
        applied.append("start_critic")
    if "run_orchestrator_once" in actions:
        sh([sys.executable, "scripts/autonomous_orchestrator.py"], timeout=80)
        applied.append("run_orchestrator_once")
    if "restart_actor_llm_critic" in actions:
        restart_actor_llm_critic(port, objective)
        applied.append("restart_actor_llm_critic")
    return applied


def run_once(*, port: int, repair: bool, objective: str) -> dict[str, Any]:
    status = control_status(port)
    live = live_state(port)
    feedback = latest_feedback()
    processes = process_snapshot()
    result = evaluate_layers(
        status=status,
        live=live,
        feedback=feedback,
        processes=processes,
        now_epoch=time.time(),
        disable_sentinel_exists=DISABLE_ORCH.exists(),
    )
    applied: list[str] = []
    if repair and result.required_actions:
        applied = apply_repairs(result.required_actions, port=port, objective=objective)
        time.sleep(5)
        status = control_status(port)
        live = live_state(port)
        feedback = latest_feedback()
        processes = process_snapshot()
        result = evaluate_layers(
            status=status,
            live=live,
            feedback=feedback,
            processes=processes,
            now_epoch=time.time(),
            disable_sentinel_exists=DISABLE_ORCH.exists(),
        )
    return {"schema": "poke-pi-layer-ensure.v1", "ok": result.ok, "layers": {k: asdict(v) for k, v in result.layers.items()}, "requiredActions": result.required_actions, "appliedActions": applied, "summary": result.summary, "processes": asdict(processes)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Ensure poke-pi heuristic/critic/LLM layers are healthy")
    parser.add_argument("--port", type=int, default=3030)
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--objective", default=DEFAULT_OBJECTIVE)
    args = parser.parse_args(argv)
    result = run_once(port=args.port, repair=not args.check_only, objective=args.objective)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["ok"] or not args.check_only else 1


if __name__ == "__main__":
    raise SystemExit(main())
