import importlib.util
import sys
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "ensure_pokemon_layers.py"
spec = importlib.util.spec_from_file_location("ensure_pokemon_layers", MODULE_PATH)
assert spec is not None
assert spec.loader is not None
ensure = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = ensure
spec.loader.exec_module(ensure)


def test_evaluate_layers_requires_all_three_layers_and_orchestrator():
    status = {"running": True, "activeRun": {"kind": "llm", "runId": "llm-1", "latestTelemetry": {"progress": {"llmCalls": 3}}}}
    live = {"map": 38, "y": 1, "x": 5, "text": ""}
    feedback = {"runId": "llm-1", "updatedAt": "2026-06-06T07:00:00Z", "movementQuality": "moving"}
    processes = ensure.ProcessSnapshot(
        orchestrator=True,
        loop_supervisor=True,
        strategy=True,
        critic=True,
        gameplay_count=2,
        raw="",
    )

    result = ensure.evaluate_layers(status=status, live=live, feedback=feedback, processes=processes, now_epoch=ensure.parse_time("2026-06-06T07:00:10Z"), disable_sentinel_exists=False)

    assert result.ok is True
    assert result.required_actions == []
    assert result.layers["heuristic"].ok is True
    assert result.layers["critic"].ok is True
    assert result.layers["llm"].ok is True


def test_evaluate_layers_repairs_missing_critic_and_orchestrator_without_killing_strategy():
    status = {"running": True, "activeRun": {"kind": "play", "runId": "heuristic-1", "latestTelemetry": {"progress": {"llmCalls": 0}}}}
    live = {"map": 38, "y": 5, "x": 2, "text": ""}
    processes = ensure.ProcessSnapshot(
        orchestrator=False,
        loop_supervisor=False,
        strategy=True,
        critic=False,
        gameplay_count=1,
        raw="strategy-loop only",
    )

    result = ensure.evaluate_layers(status=status, live=live, feedback={}, processes=processes, now_epoch=ensure.parse_time("2026-06-06T07:00:10Z"), disable_sentinel_exists=True)

    assert result.ok is False
    assert "remove_disable_sentinel" in result.required_actions
    assert "start_orchestrator_daemon" in result.required_actions
    assert "start_critic" in result.required_actions
    assert "start_loop_supervisor" in result.required_actions
    assert "restart_actor_llm_critic" in result.required_actions
    assert "kill_strategy" not in result.required_actions


def test_evaluate_layers_restarts_actor_when_llm_is_stale_even_if_strategy_exists():
    status = {"running": True, "activeRun": {"kind": "play", "runId": "heuristic-1", "latestTelemetry": {"progress": {"llmCalls": 0}}}}
    live = {"map": 38, "y": 5, "x": 2, "text": ""}
    old_feedback = {"runId": "heuristic-1", "updatedAt": "2026-06-06T06:50:00Z", "movementQuality": "unknown"}
    processes = ensure.ProcessSnapshot(
        orchestrator=True,
        loop_supervisor=True,
        strategy=True,
        critic=True,
        gameplay_count=1,
        raw="strategy-loop --llm-every 4",
    )

    result = ensure.evaluate_layers(status=status, live=live, feedback=old_feedback, processes=processes, now_epoch=ensure.parse_time("2026-06-06T07:00:10Z"), disable_sentinel_exists=False)

    assert result.layers["llm"].ok is False
    assert result.layers["critic"].ok is False
    assert "restart_actor_llm_critic" in result.required_actions
    assert "start_critic" not in result.required_actions
