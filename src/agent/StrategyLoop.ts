export interface StrategyLoopRequest {
  readonly status: number;
  readonly body: unknown;
}

export type StrategyLoopControlRequest = (
  baseUrl: string,
  path: string,
  body?: unknown,
  method?: "GET" | "POST"
) => Promise<StrategyLoopRequest>;

export interface StrategyLoopOptions {
  readonly baseUrl: string;
  readonly maxIterations: number;
  readonly maxSteps: number;
  readonly pollMs: number;
  readonly llmEvery: number;
  readonly runIdPrefix: string;
  readonly policyIdPrefix: string;
  readonly objective?: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  readonly request?: StrategyLoopControlRequest;
  readonly movementFeedback?: () => Promise<unknown>;
  readonly log?: (event: StrategyLoopEvent) => void;
}

export interface StrategyLoopEvent {
  readonly type: string;
  readonly iteration?: number;
  readonly runId?: string;
  readonly policyFile?: string;
  readonly detail?: unknown;
}

export interface StrategyLoopResult {
  readonly iterations: number;
  readonly currentPolicyFile?: string;
  readonly lastRunId?: string;
}

type Phase = "scout" | "generated" | "llm";

const DEFAULT_SLEEP = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runStrategyLoop(options: StrategyLoopOptions): Promise<StrategyLoopResult> {
  const request = options.request ?? defaultControlRequest;
  const sleep = options.sleep ?? DEFAULT_SLEEP;
  let currentPolicyFile: string | undefined;
  let lastRunId: string | undefined;

  for (let iteration = 1; iteration <= options.maxIterations; iteration += 1) {
    await waitUntilIdle(options.baseUrl, request, sleep, options.pollMs);
    const latestMovementFeedback = await options.movementFeedback?.();
    if (latestMovementFeedback !== undefined) {
      options.log?.({ type: "movement_feedback_observed", iteration, detail: latestMovementFeedback });
    }
    const phase = choosePhase({ iteration, currentPolicyFile, llmEvery: options.llmEvery, movementFeedback: latestMovementFeedback });
    const runId = `${options.runIdPrefix}-${phase}-${iteration}`;
    const policyId = `${options.policyIdPrefix}-${iteration}`;
    const requestedPolicyFile = currentPolicyFile;

    options.log?.({ type: "phase_start", iteration, runId, policyFile: requestedPolicyFile, detail: { phase } });
    await startPhaseRun({ baseUrl: options.baseUrl, request, phase, runId, maxSteps: options.maxSteps, policyFile: requestedPolicyFile });
    await waitUntilIdle(options.baseUrl, request, sleep, options.pollMs);

    const evaluation = await evaluateRun(options.baseUrl, request, runId);
    options.log?.({ type: "phase_evaluated", iteration, runId, policyFile: requestedPolicyFile, detail: evaluation.body });

    const synthesizeFromRun = shouldSynthesizePolicy(phase, evaluation.body);
    if (synthesizeFromRun) {
      const policyFile = `policies/generated/${policyId}.json`;
      const synthesis = await request(options.baseUrl, "/api/agent/synthesize-policy", {
        fromRun: runId,
        policyId,
        policyFile,
        objective: options.objective ?? strategyObjective(phase, evaluation.body, latestMovementFeedback)
      }, "POST");
      if (synthesis.status >= 400) {
        options.log?.({ type: "policy_synthesis_failed", iteration, runId, policyFile, detail: synthesis.body });
      } else {
        currentPolicyFile = policyFile;
        options.log?.({ type: "policy_synthesized", iteration, runId, policyFile, detail: synthesis.body });
      }
    }

    lastRunId = runId;
  }

  return { iterations: options.maxIterations, currentPolicyFile, lastRunId };
}

function choosePhase(input: { readonly iteration: number; readonly currentPolicyFile?: string; readonly llmEvery: number; readonly movementFeedback?: unknown }): Phase {
  if (input.currentPolicyFile === undefined) {
    return "scout";
  }

  if (movementQuality(input.movementFeedback) === "blocked") {
    return "llm";
  }

  if (input.llmEvery > 0 && input.iteration % input.llmEvery === 0) {
    return "llm";
  }

  return "generated";
}

async function startPhaseRun(input: {
  readonly baseUrl: string;
  readonly request: StrategyLoopControlRequest;
  readonly phase: Phase;
  readonly runId: string;
  readonly maxSteps: number;
  readonly policyFile?: string;
}): Promise<void> {
  const body = {
    policy: input.phase === "llm" ? "openai" : input.phase === "generated" ? "generated" : "heuristic",
    policyFile: input.phase === "scout" ? undefined : input.policyFile,
    runId: input.runId,
    maxSteps: input.maxSteps,
    mode: "stage1"
  };
  const response = await input.request(input.baseUrl, "/api/agent/run", body, "POST");
  if (response.status >= 400) {
    throw new Error(`strategy phase ${input.phase} failed to start: ${JSON.stringify(response.body)}`);
  }
}

async function waitUntilIdle(
  baseUrl: string,
  request: StrategyLoopControlRequest,
  sleep: (ms: number) => Promise<void>,
  pollMs: number
): Promise<void> {
  while (true) {
    const status = await request(baseUrl, "/api/control/status", undefined, "GET");
    if (status.status >= 400) {
      throw new Error(`control status failed: ${JSON.stringify(status.body)}`);
    }
    if (objectField(status.body, "running") !== true) {
      return;
    }
    await sleep(pollMs);
  }
}

async function evaluateRun(baseUrl: string, request: StrategyLoopControlRequest, runId: string): Promise<StrategyLoopRequest> {
  const response = await request(baseUrl, `/api/agent/evaluate/${encodeURIComponent(runId)}`, undefined, "GET");
  if (response.status >= 400) {
    throw new Error(`strategy evaluation failed for ${runId}: ${JSON.stringify(response.body)}`);
  }
  return response;
}

function shouldSynthesizePolicy(phase: Phase, evaluation: unknown): boolean {
  if (phase === "llm") {
    return false;
  }

  const recommendation = objectField(evaluation, "recommendation");
  return recommendation !== "promote_or_reuse_policy";
}

function strategyObjective(phase: Phase, evaluation: unknown, movementFeedback?: unknown): string {
  const movementLines = movementFeedback === undefined ? [] : [
    `External movement monitor quality: ${String(objectField(movementFeedback, "movementQuality") ?? "unknown")}.`,
    `External movement monitor recommendation: ${String(objectField(movementFeedback, "recommendation") ?? "unknown")}.`,
    `External movement counts: ${JSON.stringify(objectField(movementFeedback, "counts") ?? {})}.`
  ];
  return [
    "Continuously improve Pokemon Red/Blue controller policy from recent run telemetry.",
    `Last phase: ${phase}.`,
    `Evaluator recommendation: ${String(objectField(evaluation, "recommendation") ?? "unknown")}.`,
    ...movementLines,
    "Use heuristic policies for cheap map scouting and generated policy validation; reserve LLM runs for periodic higher-cost execution checks, repeated-loop recovery, blocked movement rerouting, or low-confidence strategic choices."
  ].join(" ");
}

function movementQuality(feedback: unknown): string | undefined {
  const quality = objectField(feedback, "movementQuality");
  return typeof quality === "string" ? quality : undefined;
}

async function defaultControlRequest(baseUrl: string, path: string, body: unknown, method: "GET" | "POST" = "POST"): Promise<StrategyLoopRequest> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: method === "POST" ? { "content-type": "application/json" } : undefined,
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined
  });
  return { status: response.status, body: await response.json() };
}

function objectField(value: unknown, field: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[field] : undefined;
}
