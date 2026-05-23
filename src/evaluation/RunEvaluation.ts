export interface AgentRunEvaluationInput {
  readonly runId: unknown;
  readonly summary: unknown;
  readonly lastDecision: unknown;
  readonly lastAction: unknown;
  readonly improvementLog: readonly unknown[];
}

export type AgentRunRecommendation =
  | "promote_or_reuse_policy"
  | "synthesize_or_tune_policy_to_avoid_loops"
  | "collect_more_scout_data_or_raise_llm_budget"
  | "continue_scouting_or_compare_generated_policy";

export interface AgentRunEvaluation {
  readonly schema: "pokemon-agent-run-evaluation.v1";
  readonly runId: unknown;
  readonly status: unknown;
  readonly counts: unknown;
  readonly lastDecision: unknown;
  readonly lastAction: unknown;
  readonly recentSignals: readonly string[];
  readonly signalCounts: Readonly<Record<string, number>>;
  readonly recommendation: AgentRunRecommendation;
}

export function evaluateAgentRun(input: AgentRunEvaluationInput): AgentRunEvaluation {
  const summary = objectRecord(input.summary);
  const recentSignals = input.improvementLog
    .slice(-20)
    .flatMap((entry) => {
      const signals = objectField(entry, "improvementSignals");
      return Array.isArray(signals) ? signals : [];
    })
    .filter((signal): signal is string => typeof signal === "string");

  return {
    schema: "pokemon-agent-run-evaluation.v1",
    runId: input.runId,
    status: summary.status,
    counts: summary.counts,
    lastDecision: unwrapPayload(input.lastDecision),
    lastAction: unwrapPayload(input.lastAction),
    recentSignals,
    signalCounts: countStrings(recentSignals),
    recommendation: recommendAgentAdjustment(summary.status, recentSignals)
  };
}

export function recommendAgentAdjustment(status: unknown, signals: readonly string[]): AgentRunRecommendation {
  if (status === "completed") {
    return "promote_or_reuse_policy";
  }
  if (signals.some((signal) => signal.includes("repeated"))) {
    return "synthesize_or_tune_policy_to_avoid_loops";
  }
  if (signals.includes("low_confidence_decision") || signals.includes("llm_fallback_used")) {
    return "collect_more_scout_data_or_raise_llm_budget";
  }
  return "continue_scouting_or_compare_generated_policy";
}

function unwrapPayload(value: unknown): unknown {
  return objectField(value, "payload") ?? value;
}

function countStrings(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function objectField(value: unknown, field: string): unknown {
  return objectRecord(value)[field];
}
