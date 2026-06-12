import { readFile } from "node:fs/promises";
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

export type ChatMessageContent = string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;

export interface ChatCompletionRequest {
  model: string;
  temperature?: number;
  messages: Array<{ role: "system" | "user"; content: any }>;
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
      const messages = await buildMessages(input, this.harnessMode, guide);
      const completion = await this.client.chat.completions.create(buildChatCompletionRequest({
        model: this.model,
        temperature: this.temperature,
        messages
      }));
      const content = completion.choices[0]?.message?.content;

      if (typeof content !== "string" || content.trim().length === 0) {
        return this.fallback(input, new HarnessError("LLM_INVALID_OUTPUT", "LLM response did not include message content"));
      }

      const guideSearchQuery = parseGuideSearchQuery(content);
      if (guideSearchQuery !== undefined) {
        if (this.calls >= this.maxLlmCalls) {
          return this.fallback(input, new HarnessError("BUDGET_EXCEEDED", "Maximum LLM call budget reached before guide-search follow-up", {
            context: { maxLlmCalls: this.maxLlmCalls, guideSearchQuery }
          }));
        }
        this.calls += 1;
        const guideSearchResult = await searchWalkthroughGuide(guideSearchQuery);
        const followUpMessages = appendGuideSearchResult(messages, guideSearchQuery, guideSearchResult);
        const followUpCompletion = await this.client.chat.completions.create(buildChatCompletionRequest({
          model: this.model,
          temperature: this.temperature,
          messages: followUpMessages
        }));
        const followUpContent = followUpCompletion.choices[0]?.message?.content;
        if (typeof followUpContent !== "string" || followUpContent.trim().length === 0) {
          return this.fallback(input, new HarnessError("LLM_INVALID_OUTPUT", "LLM guide-search follow-up did not include message content"));
        }
        return parseDecision(followUpContent);
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
  return new OpenAI(options) as unknown as ChatCompletionsClient;
}

async function buildMessages(input: PolicyInput, harnessMode: HarnessMode, guide?: LLMGuideContext): Promise<ChatCompletionRequest["messages"]> {
  if (harnessMode === "full-game") {
    return buildFullGameMessages(input, guide);
  }

  const messages: ChatCompletionRequest["messages"] = [
    {
      role: "system",
      content: "You are a bounded Pokemon Red/Blue controller. Choose only safe Game Boy actions from the supplied schema. Usually output a policy decision. If, and only if, missing walkthrough knowledge materially blocks the next decision, output exactly {\"guideSearchQuery\":\"short query\"}; Hermes will search a local trusted guide corpus once, then you must output the final policy decision. Never invent buttons, memory writes, shell commands, code execution, or a hardcoded global input timeline."
    },
    {
      role: "user",
      content: [
        "Role: Pokemon Red/Blue controller for an mGBA harness.",
        "Stage 1 objective: progress autonomously from Pallet/Oak/starter flow onward through Viridian City, Parcel/Pokedex, Route 2/Viridian Forest, and Brock using only current observed state.",
        "Stage 1 is not a stopping condition. If starter/Oak/Rival flow is already satisfied, continue routing toward Viridian/Forest/Brock; do not wait merely because Stage 1 appears complete.",
        "Wait is allowed only for unavoidable short transition/loading stabilization. On stable overworld with no text/battle/menu, choose bounded movement/exploration instead of wait.",
        macroRouteGuidance(),
        `Current RAM-derived state JSON: ${stableJson(stateWithMapKnowledge(input))}`,
        `Recent actions summary: ${stableJson(input.recentActions ?? input.recentStates ?? [])}`,
        stage1RouteFacts(),
        guidePromptSection(guide),
        `Allowed action schema: ${stableJson(createPolicyDecisionJsonSchema())}`,
        "Optional guide lookup escape hatch: Do NOT use this every turn. Only if route/story knowledge is genuinely missing after reading RAM, screenshot, recent actions, and generated guide, output exactly {\"guideSearchQuery\":\"brief Pokemon Red/Blue walkthrough query\"} instead of a policy decision. Hermes will provide trusted local guide snippets, then you must output a normal policy decision.",
        sequenceGuidance(),
        "Anti-hardcoding rule: base each decision on the current state and recent action results only; do not follow or emit a precomputed global input timeline.",
        "Generated-policy guide rule: when a generated policy guide is supplied, treat it as Hermes' current bounded heuristic recommendation. Follow it when it fits the current observation; if you override it, explain the observed-state reason in rationale.",
        "Output only one JSON object matching the allowed policy decision schema. Do not include markdown, comments, or extra text."
      ].join("\n")
    }
  ];

  return withVisualObservation(messages, input);
}

async function buildFullGameMessages(input: PolicyInput, guide?: LLMGuideContext): Promise<ChatCompletionRequest["messages"]> {
  const messages: ChatCompletionRequest["messages"] = [
    {
      role: "system",
      content: "You are a Pokemon Red/Blue full-game controller for an mGBA harness. Choose only safe Game Boy actions from the supplied schema. Usually output a policy decision. If, and only if, missing walkthrough knowledge materially blocks the next decision, output exactly {\"guideSearchQuery\":\"short query\"}; Hermes will search a local trusted guide corpus once, then you must output the final policy decision. Never invent buttons, memory writes, emulator RAM mutation, shell commands, code execution, ROM assets, walkthrough text, or a hardcoded global input timeline."
    },
    {
      role: "user",
      content: [
        "Role: Pokemon Red/Blue controller for an mGBA harness.",
        "Full-game objective: progress through the game using only current observed state and safe controller inputs.",
        macroRouteGuidance(),
        "Final detector goal: completion can be claimed only when the current observed map is Hall of Fame (map id 0x76) or hallOfFameComplete is true.",
        "Badges are read-only progress signals only; wObtainedBadges, badgeCount, and badgesObtained are not completion by themselves.",
        "Do not request or imply memory writes, emulator RAM mutation APIs, ROM-derived assets, map graphics, walkthrough text, or precomputed global input timelines.",
        "Do not claim route facts alone, Rival battle exit, or all badges as full-game completion without Hall of Fame observation.",
        `Current RAM-derived state JSON: ${stableJson(stateWithMapKnowledge(input))}`,
        `Recent actions summary: ${stableJson(input.recentActions ?? input.recentStates ?? [])}`,
        guidePromptSection(guide),
        `Allowed action schema: ${stableJson(createPolicyDecisionJsonSchema())}`,
        "Optional guide lookup escape hatch: Do NOT use this every turn. Only if route/story knowledge is genuinely missing after reading RAM, screenshot, recent actions, and generated guide, output exactly {\"guideSearchQuery\":\"brief Pokemon Red/Blue walkthrough query\"} instead of a policy decision. Hermes will provide trusted local guide snippets, then you must output a normal policy decision.",
        sequenceGuidance(),
        "Anti-hardcoding rule: base each decision on the current state and recent action results only; do not follow or emit a precomputed global input timeline.",
        "Generated-policy guide rule: when a generated policy guide is supplied, treat it as Hermes' current bounded heuristic recommendation. Follow it when it fits the current observation; if you override it, explain the observed-state reason in rationale.",
        "Output only one JSON object matching the allowed policy decision schema. Do not include markdown, comments, or extra text."
      ].join("\n")
    }
  ];

  return withVisualObservation(messages, input);
}

async function withVisualObservation(messages: ChatCompletionRequest["messages"], input: PolicyInput): Promise<ChatCompletionRequest["messages"]> {
  const screenshotPath = input.visualObservation?.screenshot?.path;
  if (screenshotPath === undefined) {
    return messages;
  }

  const dataUrl = await screenshotDataUrl(screenshotPath);
  if (dataUrl === undefined) {
    return messages;
  }

  const [system, user] = messages;
  if (system === undefined || user === undefined || typeof user.content !== "string") {
    return messages;
  }

  return [
    system,
    {
      role: "user",
      content: [
        { type: "text", text: `${user.content}\nCurrent screenshot is attached. Use it as a visual local-map prior, but trust RAM/action probes for verified movement facts.` },
        { type: "image_url", image_url: { url: dataUrl } }
      ]
    }
  ];
}

async function screenshotDataUrl(path: string): Promise<string | undefined> {
  try {
    const data = await readFile(path);
    return `data:image/png;base64,${data.toString("base64")}`;
  } catch {
    return undefined;
  }
}

function macroRouteGuidance(): string {
  return "Macro-route preference: when the current state is stable overworld movement, use the screenshot plus RAM/probe evidence to output a bounded sequence of 4-16 local movement actions rather than a single button. Use shorter/single actions for battle, text, menus, uncertain transitions, or low confidence.";
}

function sequenceGuidance(): string {
  return "Sequence guidance: a sequence may contain up to 24 child actions. Prefer holds for walking steps. Keep each macro local and reversible; do not emit a global walkthrough timeline.";
}

function stateWithMapKnowledge(input: PolicyInput): unknown {
  const state = input.currentState ?? input.state;
  if (state === undefined || state === null || typeof state !== "object") {
    return state;
  }

  return {
    ...(state as Record<string, unknown>),
    mapKnowledge: input.mapKnowledge,
    recentPostActionObservations: input.recentPostActionObservations
  };
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
    "Map knowledge facts are learned from live movement: blocked/walkable edges are verified by coordinate changes; mapTransitions record real mapId changes and should not be merged unless a later semantic alias layer says they are the same place.",
    "Recent post-action observations are short-cycle probes captured between normal decision-loop iterations; use change.kind plus delta fields to distinguish walk_step, turn_only, blocked_with_visual_change, map_transition, non_adjacent_position_jump, and no_change before choosing the next action.",
    "If boot/title state has all-zero RAM or title/menu-like text, choose current-state menu/title actions such as Start or A until gameplay state appears.",
    "Oak/name flow is text/menu driven: when screenTextKind or recentActions show naming, dialog, or menu prompts, choose the current prompt action rather than walking randomly.",
    "Red House 2F is wCurMap=38: from the bedroom, route toward the stair by getting to x=5 and moving Up onto the stair tile when aligned.",
    "Red House 1F is wCurMap=37: route to the front door exit by moving from the stairs/living room toward the south doorway using current coordinates.",
    "Pallet Town is wCurMap=0: before Oak stops you, target the north grass trigger at wYCoord=1,wXCoord=10 using current coordinates.",
    "Oak Lab is wCurMap=40: starter ball is at wYCoord=3,wXCoord=5; stand on that tile, face right with playerFacingDirection, then press A to select it.",
    "After receiving the starter, if wCurMap=40 and wPartyCount>0, move toward wYCoord=6 to trigger Rival when current coordinates are not already there.",
    "Viridian Mart is wCurMap=44: this is an indoor shop, not Route 1/outdoors. The north/top edge around y=1 and the far right side are walls/shelves/NPC space; do not keep probing Up/Right there as a route. After parcel/dialog or if no useful text is open, route south/down to the bottom exit/door, then leave the building and later return to Oak.",
    "Viridian Mart nickname NPC trap: at/near map 44 y=4 x=5 facing up, pressing A/up opens non-story nickname text. Once cleared, avoid A/up there and force a south-exit path.",
    "If wIsInBattle is nonzero and screenText shows the main battle menu FIGHT ITEM RUN, selecting FIGHT with A is appropriate.",
    "If wIsInBattle is nonzero and move-list screenText shows SCRATCH GROWL and TYPE NORMAL, prefer pressing A directly to confirm SCRATCH; do not send Up/Down before A unless current observed screen text clearly shows SCRATCH is not selected, because live evidence shows cursor movement can choose GROWL. SCRATCH is the damaging move to prefer for ending the Rival battle.",
    "Avoid choosing GROWL when the goal is ending battle because GROWL does not reduce enemy HP.",
    "Battle text such as used SCRATCH, enemy move text, level/XP text, or defeated text should be advanced with A.",
    "If screenTextKind or recentActions show stale/repeated text, press A or B to clear the current text before pathing; do not keep walking against uncleared dialog."
  ].join("\n");
}

function parseGuideSearchQuery(content: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") {
    return undefined;
  }
  const query = (parsed as Record<string, unknown>).guideSearchQuery;
  if (typeof query !== "string") {
    return undefined;
  }
  const trimmed = query.trim();
  return trimmed.length > 0 && trimmed.length <= 160 ? trimmed : undefined;
}

function appendGuideSearchResult(messages: ChatCompletionRequest["messages"], query: string, result: string): ChatCompletionRequest["messages"] {
  return [
    ...messages,
    {
      role: "user",
      content: [
        `Trusted local guide lookup for query: ${query}`,
        result,
        "Now output exactly one JSON object matching the allowed policy decision schema. Use guide facts only for route/story context; choose short bounded actions from the current observed state."
      ].join("\n")
    }
  ];
}

async function searchWalkthroughGuide(query: string): Promise<string> {
  const guidePath = new URL("../../docs/pokemon-red-blue-guide-corpus.md", import.meta.url);
  let corpus = "";
  try {
    corpus = await readFile(guidePath, "utf8");
  } catch {
    return "Guide corpus unavailable. Fall back to current RAM/screenshot evidence and avoid random/global timelines.";
  }

  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 3);
  const sections = corpus.split(/\n(?=##+\s)/g);
  const scored = sections.map((section) => {
    const lower = section.toLowerCase();
    const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
    return { section, score };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score).slice(0, 4);

  const selected = scored.length > 0 ? scored.map((entry) => entry.section) : sections.slice(0, 3);
  return selected.join("\n\n---\n\n").slice(0, 5000);
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
