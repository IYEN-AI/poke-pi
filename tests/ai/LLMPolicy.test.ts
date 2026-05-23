import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import type { PolicyDecision } from "../../src/control/ActionTypes.js";
import { LLMPolicy, type ChatCompletionRequest, type ChatCompletionsClient, type OpenAIClientOptions } from "../../src/ai/LLMPolicy.js";
import type { Policy, PolicyInput } from "../../src/ai/Policy.js";
import { HarnessError } from "../../src/errors.js";

const validDecision: PolicyDecision = {
  action: { type: "press", button: "A", frames: 5 },
  rationale: "Advance current dialog based on observed text state.",
  confidence: 0.8,
  observedStateCitations: ["wTextBoxID=1", "wIsInBattle=0"]
};

const fallbackDecision: PolicyDecision = {
  action: { type: "wait", frames: 1 },
  rationale: "Fallback waits safely after invalid LLM output.",
  confidence: 0.2,
  observedStateCitations: ["fallback=true"]
};

const policyInput: PolicyInput = {
  state: {
    frame: 12,
    wIsInBattle: 0,
    wTextBoxID: 1,
    wPartyCount: 0,
    coords: { x: 3, y: 6 }
  },
  recentActions: [{ action: { type: "press", button: "A", frames: 5 }, result: "advanced text" }],
  step: 7
};

describe("LLMPolicy", () => {
  it("accepts valid model JSON and sends the configured model in a Chat Completions request", async () => {
    const requests: ChatCompletionRequest[] = [];
    const client = fakeClient(async (request) => {
      requests.push(request);
      return JSON.stringify(validDecision);
    });
    const policy = createPolicy({ client });

    await expect(policy.chooseAction(policyInput)).resolves.toEqual(validDecision);

    expect(policy.getCallCount()).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: "unit-test-model", temperature: 0.1 });
    expect(requests[0]?.messages[0]?.role).toBe("system");
    expect(requests[0]?.messages[1]?.content).toContain("Current RAM-derived state JSON");
    expect(requests[0]?.messages[1]?.content).toContain("Stage 1 objective");
    expect(requests[0]?.messages[1]?.content).toContain("Macro-route preference");
    expect(requests[0]?.messages[1]?.content).toContain("sequence may contain up to 24 child actions");
    expect(requests[0]?.messages[1]?.content).toContain("Stage 1 route facts");
    expect(requests[0]?.messages[1]?.content).toContain("Anti-hardcoding rule");
    expect(requests[0]?.messages[1]?.content).toContain("Output only one JSON object");
    expect(requests[0]?.messages[1]?.content).toContain("Allowed action schema");
  });

  it("includes compact state-conditioned Stage 1 route facts without a global input timeline", async () => {
    const requests: ChatCompletionRequest[] = [];
    const client = fakeClient(async (request) => {
      requests.push(request);
      return JSON.stringify(validDecision);
    });
    const policy = createPolicy({ client });

    await expect(policy.chooseAction(policyInput)).resolves.toEqual(validDecision);

    const prompt = requests[0]?.messages[1]?.content ?? "";
    expect(prompt).toContain("Stage 1 route facts");
    expect(prompt).toContain("wCurMap/wYCoord/wXCoord/screenTextKind/wPartyCount/wIsInBattle/playerFacingDirection/recentActions");
    expect(prompt).toContain("not as a step-numbered global timeline");
    expect(prompt).toContain("wCurMap=38");
    expect(prompt).toContain("wCurMap=37");
    expect(prompt).toContain("wCurMap=40");
    expect(prompt).toContain("wYCoord=1,wXCoord=10");
    expect(prompt).toContain("wYCoord=3,wXCoord=5");
    expect(prompt).toContain("wYCoord=6");
    expect(prompt).toContain("wIsInBattle is nonzero and screenText shows the main battle menu FIGHT ITEM RUN");
    expect(prompt).toContain("SCRATCH GROWL");
    expect(prompt).toContain("TYPE NORMAL");
    expect(prompt).toContain("pressing A directly");
    expect(prompt).toContain("do not send Up/Down before A");
    expect(prompt).toContain("cursor movement can choose GROWL");
    expect(prompt).toContain("SCRATCH is the damaging move to prefer");
    expect(prompt).toContain("GROWL does not reduce enemy HP");
    expect(prompt).toContain("Battle text such as used SCRATCH");
    expect(prompt).toContain("stale/repeated text");
    expect(prompt).toContain("do not follow or emit a precomputed global input timeline");
    expect(prompt).not.toContain("step 1");
    expect(prompt).not.toContain("step 2");
    expect(prompt).not.toContain("step 3");
    expect(prompt.indexOf("Stage 1 route facts")).toBeLessThan(prompt.indexOf("Allowed action schema"));
  });

  it("uses a full-game prompt with Hall of Fame-only completion when configured", async () => {
    const requests: ChatCompletionRequest[] = [];
    const client = fakeClient(async (request) => {
      requests.push(request);
      return JSON.stringify(validDecision);
    });
    const policy = createPolicy({ client, harnessMode: "full-game" });

    await expect(policy.chooseAction(policyInput)).resolves.toEqual(validDecision);

    const prompt = requests[0]?.messages[1]?.content ?? "";
    expect(prompt).toContain("Full-game objective");
    expect(prompt).toContain("Hall of Fame (map id 0x76)");
    expect(prompt).toContain("Badges are read-only progress signals only");
    expect(prompt).toContain("Do not request or imply memory writes");
    expect(prompt).toContain("precomputed global input timelines");
    expect(prompt).toContain("Do not claim route facts alone, Rival battle exit, or all badges as full-game completion");
    expect(prompt).not.toContain("Stage 1 route facts");
  });

  it("attaches the current screenshot as a vision input when available", async () => {
    const requests: ChatCompletionRequest[] = [];
    const dir = await mkdtemp(join(tmpdir(), "poke-llm-vision-"));
    const screenshotPath = join(dir, "screen.png");
    await writeFile(screenshotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const client = fakeClient(async (request) => {
      requests.push(request);
      return JSON.stringify(validDecision);
    });
    const policy = createPolicy({ client });

    await expect(policy.chooseAction({
      ...policyInput,
      visualObservation: { screenshot: { path: screenshotPath, frame: 1, step: 1, note: "unit" } }
    })).resolves.toEqual(validDecision);

    const content = requests[0]?.messages[1]?.content;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: expect.stringContaining("Current screenshot is attached") }),
      expect.objectContaining({ type: "image_url", image_url: { url: expect.stringContaining("data:image/png;base64,") } })
    ]));
  });


  it("injects a generated-policy guide decision into the LLM prompt", async () => {
    const requests: ChatCompletionRequest[] = [];
    const guideDecision: PolicyDecision = {
      action: { type: "hold", button: "Right", frames: 18 },
      rationale: "generated policy pallet-v1/map-explore: choose a map candidate",
      confidence: 0.62,
      observedStateCitations: ["generatedPolicy=pallet-v1;rule=map-explore"]
    };
    const guidePolicy: Policy = {
      async chooseAction() {
        return guideDecision;
      }
    };
    const client = fakeClient(async (request) => {
      requests.push(request);
      return JSON.stringify(validDecision);
    });
    const policy = createPolicy({
      client,
      guidePolicy,
      guideDescription: { id: "pallet-v1", objective: "execute scout-derived map policy" }
    });

    await expect(policy.chooseAction(policyInput)).resolves.toEqual(validDecision);

    const prompt = requests[0]?.messages[1]?.content ?? "";
    expect(prompt).toContain("Generated policy guide supplied by Hermes");
    expect(prompt).toContain("pallet-v1");
    expect(prompt).toContain("Recommended policy decision JSON");
    expect(prompt).toContain("\"button\":\"Right\"");
    expect(prompt).toContain("Generated-policy guide rule");
    expect(prompt).toContain("not a direct button command from a human");
  });


  it("omits temperature for GPT-5 compatible models that reject sampling parameters", async () => {
    const requests: ChatCompletionRequest[] = [];
    const client = fakeClient(async (request) => {
      requests.push(request);
      return JSON.stringify(validDecision);
    });
    const policy = new LLMPolicy({
      apiKey: "unit-test-key",
      baseURL: "https://example.invalid/v1",
      model: "gpt-5.5",
      timeoutMs: 1000,
      maxRetries: 0,
      temperature: 0.2,
      maxLlmCalls: 10,
      fallbackPolicy: createFallbackPolicy(),
      client
    });

    await expect(policy.chooseAction(policyInput)).resolves.toEqual(validDecision);

    expect(requests[0]).toMatchObject({ model: "gpt-5.5" });
    expect(requests[0]).not.toHaveProperty("temperature");
  });

  it("passes baseURL, timeout, retry, and API key settings to the OpenAI-compatible client factory", async () => {
    const observedOptions: OpenAIClientOptions[] = [];
    const client = fakeClient(async () => JSON.stringify(validDecision));
    const config = loadConfig({
      AI_PROVIDER: "openai",
      OPENAI_API_KEY: "unit-test-key",
      OPENAI_BASE_URL: "https://example.invalid/v1",
      OPENAI_MODEL: "configured-model",
      OPENAI_TEMPERATURE: "0.3",
      LLM_TIMEOUT_MS: "1234",
      LLM_MAX_RETRIES: "2",
      MAX_LLM_CALLS: "9"
    });

    const policy = LLMPolicy.fromConfig(config, createFallbackPolicy(), {
      createClient: (options) => {
        observedOptions.push(options);
        return client;
      }
    });

    await expect(policy.chooseAction(policyInput)).resolves.toEqual(validDecision);
    expect(observedOptions).toEqual([
      {
        apiKey: "unit-test-key",
        baseURL: "https://example.invalid/v1",
        timeout: 1234,
        maxRetries: 2
      }
    ]);
  });

  it("routes custom OpenAI-compatible base URLs through OPENAI settings", async () => {
    const observedOptions: OpenAIClientOptions[] = [];
    const requests: ChatCompletionRequest[] = [];
    const client = fakeClient(async (request) => {
      requests.push(request);
      return JSON.stringify(validDecision);
    });
    const config = loadConfig({
      AI_PROVIDER: "openai",
      OPENAI_API_KEY: "provider-unit-test-key",
      OPENAI_BASE_URL: "https://codex.example.invalid/v1",
      OPENAI_MODEL: "codex-compatible-model"
    });

    const policy = LLMPolicy.fromConfig(config, createFallbackPolicy(), {
      createClient: (options) => {
        observedOptions.push(options);
        return client;
      }
    });

    await expect(policy.chooseAction(policyInput)).resolves.toEqual(validDecision);
    expect(observedOptions).toEqual([{
      apiKey: "provider-unit-test-key",
      baseURL: "https://codex.example.invalid/v1",
      timeout: 20000,
      maxRetries: 1
    }]);
    expect(requests[0]).toMatchObject({ model: "codex-compatible-model" });
  });

  it("falls back on malformed JSON and invalid model-invented buttons", async () => {
    const fallbackErrors: HarnessError[] = [];
    const malformedPolicy = createPolicy({
      client: fakeClient(async () => "not json"),
      onFallback: (error) => fallbackErrors.push(error)
    });
    const invalidButtonPolicy = createPolicy({
      client: fakeClient(async () => JSON.stringify({ ...validDecision, action: { type: "press", button: "L", frames: 5 } })),
      onFallback: (error) => fallbackErrors.push(error)
    });

    await expect(malformedPolicy.chooseAction(policyInput)).resolves.toMatchObject({
      ...fallbackDecision,
      rationale: expect.stringContaining("LLM fallback after LLM_INVALID_OUTPUT"),
      observedStateCitations: expect.arrayContaining(["LLM fallback after LLM_INVALID_OUTPUT"])
    });
    await expect(invalidButtonPolicy.chooseAction(policyInput)).resolves.toMatchObject({
      ...fallbackDecision,
      rationale: expect.stringContaining("LLM fallback after LLM_INVALID_OUTPUT"),
      observedStateCitations: expect.arrayContaining(["LLM fallback after LLM_INVALID_OUTPUT"])
    });

    expect(fallbackErrors.map((error) => error.code)).toEqual(["LLM_INVALID_OUTPUT", "LLM_INVALID_OUTPUT"]);
  });

  it("falls back on endpoint-style failures without exposing request secrets", async () => {
    const fallbackErrors: HarnessError[] = [];
    const failures = [
      new Error("timeout while reading completion"),
      new Error("401 unauthorized"),
      new Error("429 rate limited"),
      new Error("500 upstream error"),
      new TypeError("fetch failed")
    ];

    for (const failure of failures) {
      const policy = createPolicy({
        client: fakeClient(async () => {
          throw failure;
        }),
        onFallback: (error) => fallbackErrors.push(error)
      });

      await expect(policy.chooseAction(policyInput)).resolves.toMatchObject({
        ...fallbackDecision,
        rationale: expect.stringContaining("LLM fallback after LLM_UNAVAILABLE"),
        observedStateCitations: expect.arrayContaining(["LLM fallback after LLM_UNAVAILABLE"])
      });
    }

    expect(fallbackErrors.map((error) => error.code)).toEqual([
      "LLM_UNAVAILABLE",
      "LLM_UNAVAILABLE",
      "LLM_UNAVAILABLE",
      "LLM_UNAVAILABLE",
      "LLM_UNAVAILABLE"
    ]);
    expect(JSON.stringify(fallbackErrors.map((error) => error.toJSON()))).not.toContain("unit-test-key");
  });

  it("uses fallback without contacting the client after max LLM calls is reached", async () => {
    const requests: ChatCompletionRequest[] = [];
    const fallbackErrors: HarnessError[] = [];
    const policy = createPolicy({
      maxLlmCalls: 1,
      client: fakeClient(async (request) => {
        requests.push(request);
        return JSON.stringify(validDecision);
      }),
      onFallback: (error) => fallbackErrors.push(error)
    });

    await expect(policy.chooseAction(policyInput)).resolves.toEqual(validDecision);
    await expect(policy.chooseAction(policyInput)).resolves.toMatchObject({
      ...fallbackDecision,
      rationale: expect.stringContaining("LLM fallback after BUDGET_EXCEEDED"),
      observedStateCitations: expect.arrayContaining(["LLM fallback after BUDGET_EXCEEDED"])
    });

    expect(requests).toHaveLength(1);
    expect(policy.getCallCount()).toBe(1);
    expect(fallbackErrors.map((error) => error.code)).toEqual(["BUDGET_EXCEEDED"]);
  });
});

function createPolicy(overrides: {
  client: ChatCompletionsClient;
  maxLlmCalls?: number;
  harnessMode?: "stage1" | "full-game";
  onFallback?: (error: HarnessError) => void;
  guidePolicy?: Policy;
  guideDescription?: unknown;
}): LLMPolicy {
  return new LLMPolicy({
    apiKey: "unit-test-key",
    baseURL: "https://example.invalid/v1",
    model: "unit-test-model",
    timeoutMs: 1000,
    maxRetries: 0,
    temperature: 0.1,
    maxLlmCalls: overrides.maxLlmCalls ?? 10,
    harnessMode: overrides.harnessMode,
    fallbackPolicy: createFallbackPolicy(),
    guidePolicy: overrides.guidePolicy,
    guideDescription: overrides.guideDescription,
    client: overrides.client,
    onFallback: overrides.onFallback
  });
}

function createFallbackPolicy(): Policy {
  return {
    async chooseAction() {
      return fallbackDecision;
    }
  };
}

function fakeClient(respond: (request: ChatCompletionRequest) => Promise<string>): ChatCompletionsClient {
  return {
    chat: {
      completions: {
        async create(request) {
          return { choices: [{ message: { content: await respond(request) } }] };
        }
      }
    }
  };
}
