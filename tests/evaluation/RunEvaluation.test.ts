import { describe, expect, it } from "vitest";
import { evaluateAgentRun, recommendAgentAdjustment } from "../../src/evaluation/RunEvaluation.js";

describe("agent run evaluation", () => {
  it("summarizes recent improvement signals into a stable recommendation", () => {
    const evaluation = evaluateAgentRun({
      runId: "scout-one",
      summary: { status: "failed_timeout", counts: { decisions: 2 } },
      lastDecision: { payload: { decision: { confidence: 0.5 } } },
      lastAction: { payload: { action: { type: "press", button: "Up" } } },
      improvementLog: [
        { improvementSignals: ["walk_step"] },
        { improvementSignals: ["repeated_state_tail", "repeated_state_tail"] }
      ]
    });

    expect(evaluation).toMatchObject({
      schema: "pokemon-agent-run-evaluation.v1",
      runId: "scout-one",
      status: "failed_timeout",
      counts: { decisions: 2 },
      lastDecision: { decision: { confidence: 0.5 } },
      lastAction: { action: { type: "press", button: "Up" } },
      recentSignals: ["walk_step", "repeated_state_tail", "repeated_state_tail"],
      signalCounts: { walk_step: 1, repeated_state_tail: 2 },
      recommendation: "synthesize_or_tune_policy_to_avoid_loops"
    });
  });

  it("keeps the policy recommendation contract explicit", () => {
    expect(recommendAgentAdjustment("completed", [])).toBe("promote_or_reuse_policy");
    expect(recommendAgentAdjustment("failed_timeout", ["llm_fallback_used"])).toBe("collect_more_scout_data_or_raise_llm_budget");
    expect(recommendAgentAdjustment("failed_timeout", [])).toBe("continue_scouting_or_compare_generated_policy");
  });
});
