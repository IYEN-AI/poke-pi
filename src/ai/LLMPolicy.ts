import OpenAI from "openai";
import type { HarnessConfig, HarnessMode } from "../config.js";
import type { PolicyDecision } from "../control/ActionTypes.js";
import { PolicyDecisionSchema, createPolicyDecisionJsonSchema } from "../control/ActionSchema.js";
import { HarnessError } from "../errors.js";
import type { Policy, PolicyInput } from "./Policy.js";

interface ChatMessage {
  content: string | null;
}

interface ChatChoice {
  message?: ChatMessage;
}

interface ChatCompletionResult {
  choices: ChatChoice[];
}

export interface ChatCompletionsClient {
  chat: {
    completions: {
      create(request: ChatCompletionRequest): Promise<ChatCompletionResult>;
    };
  };
}

export interface ChatCompletionRequest {
  model: string;
  temperature?: number;
  messages: Array<{ role: "system" | "user"; content: string }>;
}

export interface OpenAIClientOptions {
  apiKey: string;
  baseURL: string;
  timeout: number;
  maxRetries: number;
}

export interface LLMPolicyOptions {
  apiKey: string;
  baseURL: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  temperature: number;
  maxLlmCalls: number;
  harnessMode?: HarnessMode;
  fallbackPolicy: Policy;
  guidePolicy?: Policy;
  guideDescription?: unknown;
  client?: ChatCompletionsClient;
  createClient?: (options: OpenAIClientOptions) => ChatCompletionsClient;
  onFallback?: (error: HarnessError) => void;
}

export class LLMPolicy implements Policy {
  private readonly client: ChatCompletionsClient;
  private readonly model: string;
  private readonly temperature: number;
  private readonly maxLlmCalls: number;
  private readonly harnessMode: HarnessMode;
  private readonly fallbackPolicy: Policy;
  private readonly guidePolicy?: Policy;
  private readonly guideDescription?: unknown;
  private readonly onFallback?: (error: HarnessError) => void;
  private calls = 0;

  constructor(options: LLMPolicyOptions) {
    this.client = options.client ?? (options.createClient ?? createOpenAIClient)({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      timeout: options.timeoutMs,
      maxRetries: options.maxRetries
    });
    this.model = options.model;
    this.temperature = options.temperature;
    this.maxLlmCalls = options.maxLlmCalls;
    this.harnessMode = options.harnessMode ?? "stage1";
    this.fallbackPolicy = options.fallbackPolicy;
    this.guidePolicy = options.guidePolicy;
    this.guideDescription = options.guideDescription;
    this.onFallback = options.onFallback;
  }

  static fromConfig(
    config: HarnessConfig,
    fallbackPolicy: Policy,
    overrides: Partial<Pick<LLMPolicyOptions, "client" | "createClient" | "onFallback" | "guidePolicy" | "guideDescription">> = {}
  ): LLMPolicy {
    const providerOptions = getProviderOptions(config);

    return new LLMPolicy({
      apiKey: providerOptions.apiKey,
      baseURL: providerOptions.baseURL,
      model: providerOptions.model,
      timeoutMs: config.llmTimeoutMs,
      maxRetries: config.llmMaxRetries,
      temperature: config.openaiTemperature,
      maxLlmCalls: config.maxLlmCalls,
      harnessMode: config.harnessMode,
      fallbackPolicy,
      ...overrides
    });
  }

  getCallCount(): number {
    return this.calls;
  }

  async chooseAction(input: PolicyInput): Promise<PolicyDecision> {
    if (this.calls >= this.maxLlmCalls) {
      return this.fallback(input, new HarnessError("BUDGET_EXCEEDED", "Maximum LLM call budget reached", {
        context: { maxLlmCalls: this.maxLlmCalls }
      }));
    }

    this.calls += 1;

    try {
      const guide = await this.buildGuide(input);
      const completion = await this.client.chat.completions.create(buildChatCompletionRequest({
        model: this.model,
        temperature: this.temperature,
        messages: buildMessages(input, this.harnessMode, guide)
      }));
      const content = completion.choices[0]?.message?.content;

      if (typeof content !== "string" || content.trim().length === 0) {
        return this.fallback(input, new HarnessError("LLM_INVALID_OUTPUT", "LLM response did not include message content"));
      }

      return parseDecision(content);
    } catch (error) {
      if (error instanceof HarnessError) {
        return this.fallback(input, error);
      }

      return this.fallback(input, new HarnessError("LLM_UNAVAILABLE", "OpenAI-compatible chat completion failed", {
        cause: error,
        context: { provider: "openai-chat-completions" }
      }));
    }
  }

  private async fallback(input: PolicyInput, error: HarnessError): Promise<PolicyDecision> {
    this.onFallback?.(error);
    const decision = await this.fallbackPolicy.chooseAction(input);
    return markFallbackDecision(decision, error.code);
  }

  private async buildGuide(input: PolicyInput): Promise<LLMGuideContext | undefined> {
    if (this.guidePolicy === undefined) {
      return undefined;
    }

    try {
      return {
        description: this.guideDescription,
        decision: await this.guidePolicy.chooseAction(input)
      };
    } catch (error) {
      return {
        description: this.guideDescription,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

interface LLMGuideContext {
  readonly description?: unknown;
  readonly decision?: PolicyDecision;
  readonly error?: string;
}

function buildChatCompletionRequest(request: Required<Pick<ChatCompletionRequest, "model" | "messages">> & { temperature: number }): ChatCompletionRequest {
  if (!supportsTemperature(request.model)) {
    return { model: request.model, messages: request.messages };
  }

  return request;
}

function supportsTemperature(model: string): boolean {
  return !/^gpt-5(?:[\w.-]*)?$/i.test(model);
}

function getProviderOptions(config: HarnessConfig): Pick<LLMPolicyOptions, "apiKey" | "baseURL" | "model"> {
  if (config.openaiApiKey === undefined) {
    throw new HarnessError("LLM_UNAVAILABLE", "OPENAI_API_KEY is required when AI_PROVIDER=openai");
  }

  return {
    apiKey: config.openaiApiKey,
    baseURL: config.openaiBaseUrl,
    model: config.openaiModel
  };
}

function markFallbackDecision(decision: PolicyDecision, code: string): PolicyDecision {
  const marker = `LLM fallback after ${code}`;
  const markedDecision: PolicyDecision = {
    ...decision,
    rationale: `${marker}: ${decision.rationale}`.slice(0, 500),
    observedStateCitations: [marker, ...decision.observedStateCitations].slice(0, 5)
  };

  return PolicyDecisionSchema.parse(markedDecision);
}

function createOpenAIClient(options: OpenAIClientOptions): ChatCompletionsClient {
  return new OpenAI(options);
}

function buildMessages(input: PolicyInput, harnessMode: HarnessMode, guide?: LLMGuideContext): ChatCompletionRequest["messages"] {
  if (harnessMode === "full-game") {
    return buildFullGameMessages(input, guide);
  }

  return [
    {
      role: "system",
      content: "You are a bounded Pokemon Red/Blue controller. Choose only safe Game Boy actions from the supplied schema. Never invent buttons, memory writes, shell commands, code execution, or a hardcoded global input timeline."
    },
    {
      role: "user",
      content: [
        "Role: Pokemon Red/Blue controller for an mGBA harness.",
        "Stage 1 objective: progress from the Pallet start through Oak/starter flow, starter acquisition, Rival battle entry, and Rival battle exit using only current observed state.",
        `Current RAM-derived state JSON: ${stableJson(input.currentState ?? input.state)}`,
        `Recent actions summary: ${stableJson(input.recentActions ?? input.recentStates ?? [])}`,
        stage1RouteFacts(),
        guidePromptSection(guide),
        `Allowed action schema: ${stableJson(createPolicyDecisionJsonSchema())}`,
        "Anti-hardcoding rule: base each decision on the current state and recent action results only; do not follow or emit a precomputed global input timeline.",
        "Generated-policy guide rule: when a generated policy guide is supplied, treat it as Hermes' current bounded heuristic recommendation. Follow it when it fits the current observation; if you override it, explain the observed-state reason in rationale.",
        "Output only one JSON object matching the allowed policy decision schema. Do not include markdown, comments, or extra text."
      ].join("\n")
    }
  ];
}

function buildFullGameMessages(input: PolicyInput, guide?: LLMGuideContext): ChatCompletionRequest["messages"] {
  return [
    {
      role: "system",
      content: "You are a Pokemon Red/Blue full-game controller for an mGBA harness. Choose only safe Game Boy actions from the supplied schema. Never invent buttons, memory writes, emulator RAM mutation, shell commands, code execution, ROM assets, walkthrough text, or a hardcoded global input timeline."
    },
    {
      role: "user",
      content: [
        "Role: Pokemon Red/Blue controller for an mGBA harness.",
        "Full-game objective: progress through the game using only current observed state and safe controller inputs.",
        "Final detector goal: completion can be claimed only when the current observed map is Hall of Fame (map id 0x76) or hallOfFameComplete is true.",
        "Badges are read-only progress signals only; wObtainedBadges, badgeCount, and badgesObtained are not completion by themselves.",
        "Do not request or imply memory writes, emulator RAM mutation APIs, ROM-derived assets, map graphics, walkthrough text, or precomputed global input timelines.",
        "Do not claim route facts alone, Rival battle exit, or all badges as full-game completion without Hall of Fame observation.",
        `Current RAM-derived state JSON: ${stableJson(input.currentState ?? input.state)}`,
        `Recent actions summary: ${stableJson(input.recentActions ?? input.recentStates ?? [])}`,
        guidePromptSection(guide),
        `Allowed action schema: ${stableJson(createPolicyDecisionJsonSchema())}`,
        "Anti-hardcoding rule: base each decision on the current state and recent action results only; do not follow or emit a precomputed global input timeline.",
        "Generated-policy guide rule: when a generated policy guide is supplied, treat it as Hermes' current bounded heuristic recommendation. Follow it when it fits the current observation; if you override it, explain the observed-state reason in rationale.",
        "Output only one JSON object matching the allowed policy decision schema. Do not include markdown, comments, or extra text."
      ].join("\n")
    }
  ];
}

function guidePromptSection(guide: LLMGuideContext | undefined): string {
  if (guide === undefined) {
    return "Generated policy guide: none supplied.";
  }

  return [
    "Generated policy guide supplied by Hermes:",
    `Policy metadata JSON: ${stableJson(guide.description ?? {})}`,
    guide.decision !== undefined ? `Recommended policy decision JSON: ${stableJson(guide.decision)}` : undefined,
    guide.error !== undefined ? `Guide policy error: ${guide.error}` : undefined,
    "This is a bounded heuristic recommendation, not a direct button command from a human."
  ].filter((line): line is string => line !== undefined).join("\n");
}

function stage1RouteFacts(): string {
  return [
    "Stage 1 route facts:",
    "Use these as compact map geometry facts for the current wCurMap/wYCoord/wXCoord/screenTextKind/wPartyCount/wIsInBattle/playerFacingDirection/recentActions state, not as a step-numbered global timeline.",
    "If boot/title state has all-zero RAM or title/menu-like text, choose current-state menu/title actions such as Start or A until gameplay state appears.",
    "Oak/name flow is text/menu driven: when screenTextKind or recentActions show naming, dialog, or menu prompts, choose the current prompt action rather than walking randomly.",
    "Red House 2F is wCurMap=38: from the bedroom, route toward the stair by getting to x=5 and moving Up onto the stair tile when aligned.",
    "Red House 1F is wCurMap=37: route to the front door exit by moving from the stairs/living room toward the south doorway using current coordinates.",
    "Pallet Town is wCurMap=0: before Oak stops you, target the north grass trigger at wYCoord=1,wXCoord=10 using current coordinates.",
    "Oak Lab is wCurMap=40: starter ball is at wYCoord=3,wXCoord=5; stand on that tile, face right with playerFacingDirection, then press A to select it.",
    "After receiving the starter, if wCurMap=40 and wPartyCount>0, move toward wYCoord=6 to trigger Rival when current coordinates are not already there.",
    "If wIsInBattle is nonzero and screenText shows the main battle menu FIGHT ITEM RUN, selecting FIGHT with A is appropriate.",
    "If wIsInBattle is nonzero and move-list screenText shows SCRATCH GROWL and TYPE NORMAL, prefer pressing A directly to confirm SCRATCH; do not send Up/Down before A unless current observed screen text clearly shows SCRATCH is not selected, because live evidence shows cursor movement can choose GROWL. SCRATCH is the damaging move to prefer for ending the Rival battle.",
    "Avoid choosing GROWL when the goal is ending battle because GROWL does not reduce enemy HP.",
    "Battle text such as used SCRATCH, enemy move text, level/XP text, or defeated text should be advanced with A.",
    "If screenTextKind or recentActions show stale/repeated text, press A or B to clear the current text before pathing; do not keep walking against uncleared dialog."
  ].join("\n");
}

function parseDecision(content: string): PolicyDecision {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new HarnessError("LLM_INVALID_OUTPUT", "LLM response was not valid JSON", { cause: error });
  }

  const result = PolicyDecisionSchema.safeParse(parsed);
  if (!result.success) {
    throw new HarnessError("LLM_INVALID_OUTPUT", "LLM response failed policy decision schema validation", {
      context: { issues: result.error.issues.map((issue) => issue.message) }
    });
  }

  return result.data;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (typeof entry === "bigint") {
      return entry.toString();
    }

    return entry;
  });
}
