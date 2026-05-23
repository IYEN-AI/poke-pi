import { describe, expect, it } from "vitest";
import { runStrategyLoop, type StrategyLoopControlRequest } from "../src/agent/StrategyLoop.js";

describe("strategy loop", () => {
  it("alternates scout, generated policy, and LLM-guided runs while synthesizing policies", async () => {
    const calls: Array<{ path: string; body: unknown; method?: string }> = [];
    const request: StrategyLoopControlRequest = async (_baseUrl, path, body, method) => {
      calls.push({ path, body, method });
      if (path === "/api/control/status") {
        return { status: 200, body: { running: false } };
      }
      if (path.startsWith("/api/agent/evaluate/")) {
        return { status: 200, body: { recommendation: "synthesize_or_tune_policy_to_avoid_loops" } };
      }
      if (path === "/api/agent/synthesize-policy") {
        return { status: 200, body: { policy: { id: objectField(body, "policyId") }, outputFile: objectField(body, "policyFile") } };
      }
      if (path === "/api/agent/run") {
        return { status: 202, body: { started: true } };
      }
      return { status: 404, body: { error: "unexpected" } };
    };

    const result = await runStrategyLoop({
      baseUrl: "http://127.0.0.1:3030",
      maxIterations: 4,
      maxSteps: 9,
      pollMs: 0,
      llmEvery: 4,
      runIdPrefix: "unit-strategy",
      policyIdPrefix: "unit-policy",
      request,
      sleep: async () => undefined
    });

    const runBodies = calls.filter((call) => call.path === "/api/agent/run").map((call) => call.body);
    expect(runBodies).toMatchObject([
      { policy: "heuristic", runId: "unit-strategy-scout-1", maxSteps: 9 },
      { policy: "generated", runId: "unit-strategy-generated-2", policyFile: "policies/generated/unit-policy-1.json" },
      { policy: "generated", runId: "unit-strategy-generated-3", policyFile: "policies/generated/unit-policy-2.json" },
      { policy: "openai", runId: "unit-strategy-llm-4", policyFile: "policies/generated/unit-policy-3.json" }
    ]);
    expect(calls.filter((call) => call.path === "/api/agent/synthesize-policy")).toHaveLength(3);
    expect(result.currentPolicyFile).toBe("policies/generated/unit-policy-3.json");
    expect(result.lastRunId).toBe("unit-strategy-llm-4");
  });
});

function objectField(value: unknown, field: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[field] : undefined;
}
