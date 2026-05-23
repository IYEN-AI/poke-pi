import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { HarnessConfig } from "../config.js";
import type { Policy, PolicyInput, PokemonStateSnapshot, RecentStateSnapshot } from "../ai/Policy.js";
import type { PolicyDecision } from "../control/ActionTypes.js";
import type { ScreenshotMetadata } from "../evidence/EvidenceRecorder.js";
import { MapKnowledgeTracker } from "../pokemon/MapKnowledge.js";
import { analyzeVisibleMap, type VisibleMapObservation } from "../pokemon/VisualMap.js";
import { HarnessError, type SerializedHarnessError } from "../errors.js";
import type { DetectorStatus, ProgressDetector } from "../pokemon/Detector.js";
import type { FrameNumber, HarnessErrorCode, HarnessStatus, RunId } from "../types.js";

export interface RunnerClient {
  currentFrame(): Promise<FrameNumber>;
  screenshot(path?: string): Promise<string>;
}

export interface RunnerStateReader<TState = PokemonStateSnapshot> {
  readState(): Promise<TState>;
}

export interface RunnerController {
  execute(action: unknown): Promise<void>;
}

export interface RunnerEvidenceRecorder {
  readonly paths?: { readonly runId?: string };
  startRun(config: unknown): Promise<void>;
  recordState(state: unknown): Promise<string>;
  recordDecision(decision: unknown): Promise<void>;
  recordAction(action: unknown): Promise<void>;
  recordScreenshot(metadata: ScreenshotMetadata): Promise<string>;
  recordError(error: unknown): Promise<string>;
  recordTelemetry?(telemetry: unknown): Promise<void>;
  finishRun(status: HarnessStatus, result?: unknown): Promise<unknown>;
}

export interface RunnerBudgets {
  readonly maxSteps?: number;
  readonly stepDelayMs?: number;
  readonly maxLlmCalls?: number;
  readonly repeatedStateThreshold?: number;
}

export interface HarnessRunnerOptions<TState = PokemonStateSnapshot> {
  readonly config: Pick<HarnessConfig, "harnessRunId" | "harnessMode" | "loopMaxSteps" | "loopStepDelayMs" | "maxLlmCalls" | "aiProvider">;
  readonly client: RunnerClient;
  readonly stateReader: RunnerStateReader<TState>;
  readonly policy: Policy;
  readonly controller: RunnerController;
  readonly evidence: RunnerEvidenceRecorder;
  readonly detector: ProgressDetector<Record<string, unknown>, DetectorStatus>;
  readonly budgets?: RunnerBudgets;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
}

export interface HarnessSnapshot<TState = PokemonStateSnapshot> {
  readonly step: number;
  readonly frame: FrameNumber;
  readonly state: TState;
  readonly stateFile: string;
  readonly screenshot: ScreenshotMetadata;
  readonly screenshotEvidenceFile: string;
  readonly stateHash: string;
  readonly visibleMap?: VisibleMapObservation;
}

export interface RecordedActionSummary {
  readonly step: number;
  readonly frame?: FrameNumber;
  readonly action: PolicyDecision["action"];
  readonly rationale: string;
  readonly confidence: number;
}

export interface HarnessRunResult {
  readonly runId: RunId;
  readonly status: HarnessStatus;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly totalSteps: number;
  readonly finalFrame?: FrameNumber;
  readonly errorCode?: HarnessErrorCode;
  readonly error?: SerializedHarnessError;
  readonly checkpoints: DetectorStatus["checkpoints"];
  readonly detector: DetectorStatus;
  readonly last20Actions: readonly RecordedActionSummary[];
  readonly recentStateHashes: readonly string[];
}

type RunnerFailure = {
  readonly status: HarnessStatus;
  readonly error: HarnessError;
};

const DEFAULT_REPEATED_STATE_THRESHOLD = 30;
const RECENT_LIMIT = 20;
const POST_ACTION_POLL_COUNT = 4;
const POST_ACTION_POLL_INTERVAL_MS = 80;

export class HarnessRunner<TState = PokemonStateSnapshot> {
  private readonly config: HarnessRunnerOptions<TState>["config"];
  private readonly client: RunnerClient;
  private readonly stateReader: RunnerStateReader<TState>;
  private readonly policy: Policy;
  private readonly controller: RunnerController;
  private readonly evidence: RunnerEvidenceRecorder;
  private readonly detector: ProgressDetector<Record<string, unknown>, DetectorStatus>;
  private readonly maxSteps: number;
  private readonly stepDelayMs: number;
  private readonly maxLlmCalls: number;
  private readonly repeatedStateThreshold: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly recentStates: RecentStateSnapshot[] = [];
  private readonly recentStateHashes: string[] = [];
  private readonly last20Actions: RecordedActionSummary[] = [];
  private readonly recentPostActionObservations: PostActionObservation[] = [];
  private readonly mapKnowledge = new MapKnowledgeTracker();
  private startedAt: string | undefined;
  private step = 0;
  private llmCalls = 0;
  private finalFrame: FrameNumber | undefined;

  constructor(options: HarnessRunnerOptions<TState>) {
    this.config = options.config;
    this.client = options.client;
    this.stateReader = options.stateReader;
    this.policy = options.policy;
    this.controller = options.controller;
    this.evidence = options.evidence;
    this.detector = options.detector;
    this.maxSteps = options.budgets?.maxSteps ?? options.config.loopMaxSteps;
    this.stepDelayMs = options.budgets?.stepDelayMs ?? options.config.loopStepDelayMs;
    this.maxLlmCalls = options.budgets?.maxLlmCalls ?? options.config.maxLlmCalls;
    this.repeatedStateThreshold = options.budgets?.repeatedStateThreshold ?? DEFAULT_REPEATED_STATE_THRESHOLD;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => new Date());
  }

  async snapshot(step = this.step): Promise<HarnessSnapshot<TState>> {
    const frame = await this.client.currentFrame();
    const state = await this.stateReader.readState();
    const stateHash = stableHash(state);
    const stateFile = await this.evidence.recordState({ step, frame, state, stateHash });
    const screenshotPath = await this.client.screenshot();
    const screenshot = { path: screenshotPath, frame, step, note: "runner_snapshot" };
    const screenshotEvidenceFile = await this.evidence.recordScreenshot(screenshot);
    const visibleMap = await analyzeVisibleMap(screenshotPath);

    this.finalFrame = frame;
    return { step, frame, state, stateFile, screenshot, screenshotEvidenceFile, stateHash, visibleMap };
  }

  async run(): Promise<HarnessRunResult> {
    this.startedAt = this.timestamp();
    await this.evidence.startRun(this.startConfig());

    let failure: RunnerFailure | undefined;
    let status: HarnessStatus = "running";

    while (status === "running") {
      if (this.step >= this.maxSteps) {
        failure = this.timeoutFailure();
        status = failure.status;
        break;
      }

      this.step += 1;

      try {
        const snapshot = await this.snapshot(this.step);
        this.recordRecentState(snapshot);
        this.mapKnowledge.observeVisibleMap(toPolicyState(snapshot.state), snapshot.visibleMap, this.step);

        const policyInput = this.createPolicyInput(snapshot);
        const decision = await this.chooseDecision(policyInput);
        await this.evidence.recordDecision({ step: this.step, frame: snapshot.frame, decision });

        await this.controller.execute(decision.action);
        const actionSummary = this.recordAction(snapshot, decision);
        await this.evidence.recordAction(actionSummary);
        const postActionObservation = await this.pollPostActionState(snapshot, actionSummary);
        this.recordPostActionObservation(postActionObservation);

        const detectorBefore = this.detector.getStatus();
        const detectorStatus = this.detector.update(toDetectorState(snapshot.state), decision.action, snapshot.frame);
        await this.recordPokemonTelemetry(snapshot, decision, actionSummary, detectorBefore, detectorStatus, postActionObservation);
        status = detectorStatus.status;

        if (status === "completed" || status === "failed_stuck") {
          break;
        }

        failure = this.detectRepeatedStateFailure();
        if (failure !== undefined) {
          status = failure.status;
          break;
        }

        if (this.stepDelayMs > 0) {
          await this.sleep(this.stepDelayMs);
        }
      } catch (error) {
        failure = normalizeFailure(error);
        status = failure.status;
      }
    }

    if (failure !== undefined) {
      await this.evidence.recordError(failure.error);
    }

    const result = this.createResult(status, failure?.error);
    await this.evidence.finishRun(status, result);
    return result;
  }

  private async chooseDecision(input: PolicyInput): Promise<PolicyDecision> {
    if (this.config.aiProvider === "openai") {
      if (this.llmCalls >= this.maxLlmCalls) {
        throw new HarnessError("BUDGET_EXCEEDED", "Runner LLM call budget reached", {
          context: { maxLlmCalls: this.maxLlmCalls }
        });
      }
      this.llmCalls += 1;
    }

    try {
      return await this.policy.chooseAction(input);
    } catch (error) {
      throw normalizePolicyError(error);
    }
  }

  private createPolicyInput(snapshot: HarnessSnapshot<TState>): PolicyInput {
    return {
      state: toPolicyState(snapshot.state),
      currentState: snapshot.state,
      recentStates: [...this.recentStates],
      recentActions: [...this.last20Actions],
      step: this.step,
      mapKnowledge: this.mapKnowledge.summarize(toPolicyState(snapshot.state)),
      recentPostActionObservations: [...this.recentPostActionObservations],
      visualObservation: { screenshot: snapshot.screenshot, visibleMap: snapshot.visibleMap }
    };
  }

  private recordRecentState(snapshot: HarnessSnapshot<TState>): void {
    const state = toPolicyState(snapshot.state) as RecentStateSnapshot;
    this.mapKnowledge.observeTransition(this.recentStates.at(-1), this.last20Actions.at(-1), state, this.step);
    this.recentStates.push({ ...state, step: this.step });
    this.recentStateHashes.push(snapshot.stateHash);
    trimToLimit(this.recentStates, RECENT_LIMIT);
    trimToLimit(this.recentStateHashes, RECENT_LIMIT);
  }

  private async pollPostActionState(
    snapshot: HarnessSnapshot<TState>,
    actionSummary: RecordedActionSummary
  ): Promise<PostActionObservation | undefined> {
    if (!containsDirectionalAction(actionSummary.action)) {
      return undefined;
    }

    const before = toPolicyState(snapshot.state);
    const beforeScreenshotHash = await fileHash(snapshot.screenshot.path);
    const visualSamples: CapturedPostActionVisualSample[] = [];
    for (let poll = 1; poll <= POST_ACTION_POLL_COUNT; poll += 1) {
      await this.sleep(POST_ACTION_POLL_INTERVAL_MS);
      const state = toPolicyState(await this.stateReader.readState());
      const visualSample = await this.capturePostActionVisualSample(snapshot, poll, beforeScreenshotHash);
      if (visualSample !== undefined) {
        visualSamples.push(visualSample);
      }
      this.mapKnowledge.observeTransition(before, actionSummary, state, this.step);
      this.mapKnowledge.observeVisibleMap(state, visualSample?.visibleMap, this.step);
      this.mapKnowledge.refineLastDirectionalOutcome(before, actionSummary, state, visualSample?.visibleMap ?? snapshot.visibleMap, this.step);
      if (locationChanged(before, state)) {
        const observation: PostActionObservation = {
          schema: "pokemon-post-action-observation.v1",
          step: this.step,
          poll,
          action: actionSummary.action,
          before: locationSummary(before),
          after: locationSummary(state),
          change: classifyPostActionChange(before, state, visualSamples),
          mapChanged: (before.wCurMap ?? before.mapId) !== (state.wCurMap ?? state.mapId),
          pixelChanged: visualSamples.some((sample) => sample.pixelChanged),
          visualSamples: visualSamples.map(publicVisualSample),
          mapKnowledge: this.mapKnowledge.summarize(state)
        };
        await this.evidence.recordTelemetry?.({ type: "post_action_map_observation", ...observation });
        return observation;
      }
    }

    return {
      schema: "pokemon-post-action-observation.v1",
      step: this.step,
      poll: POST_ACTION_POLL_COUNT,
      action: actionSummary.action,
      before: locationSummary(before),
      after: locationSummary(before),
      change: classifyPostActionChange(before, before, visualSamples),
      mapChanged: false,
      pixelChanged: visualSamples.some((sample) => sample.pixelChanged),
      visualSamples: visualSamples.map(publicVisualSample),
      mapKnowledge: this.mapKnowledge.summarize(before)
    };
  }

  private async capturePostActionVisualSample(
    snapshot: HarnessSnapshot<TState>,
    poll: number,
    beforeScreenshotHash: string | undefined
  ): Promise<CapturedPostActionVisualSample | undefined> {
    try {
      const path = await this.client.screenshot();
      await this.evidence.recordScreenshot({ path, frame: snapshot.frame, step: this.step, note: `post_action_probe_${poll}` });
      const screenshotHash = await fileHash(path);
      const visibleMap = await analyzeVisibleMap(path);
      return {
        poll,
        screenshotPath: path,
        screenshotHash,
        pixelChanged: beforeScreenshotHash !== undefined && screenshotHash !== undefined && beforeScreenshotHash !== screenshotHash,
        visibleMapKindCounts: visibleMap?.kindCounts,
        visibleMap
      };
    } catch {
      return undefined;
    }
  }

  private recordPostActionObservation(observation: PostActionObservation | undefined): void {
    if (observation === undefined) return;
    this.recentPostActionObservations.push(observation);
    trimToLimit(this.recentPostActionObservations, RECENT_LIMIT);
  }

  private recordAction(snapshot: HarnessSnapshot<TState>, decision: PolicyDecision): RecordedActionSummary {
    const summary: RecordedActionSummary = {
      step: this.step,
      frame: snapshot.frame,
      action: decision.action,
      rationale: decision.rationale,
      confidence: decision.confidence
    };

    this.last20Actions.push(summary);
    trimToLimit(this.last20Actions, RECENT_LIMIT);
    return summary;
  }

  private async recordPokemonTelemetry(
    snapshot: HarnessSnapshot<TState>,
    decision: PolicyDecision,
    actionSummary: RecordedActionSummary,
    detectorBefore: DetectorStatus,
    detectorAfter: DetectorStatus,
    postActionObservation?: PostActionObservation
  ): Promise<void> {
    if (this.evidence.recordTelemetry === undefined) {
      return;
    }

    await this.evidence.recordTelemetry(createPokemonTelemetry({
      step: this.step,
      frame: snapshot.frame,
      state: snapshot.state,
      stateHash: snapshot.stateHash,
      decision,
      actionSummary,
      detectorBefore,
      detectorAfter,
      recentActions: this.last20Actions,
      recentStateHashes: this.recentStateHashes,
      repeatedStateThreshold: this.repeatedStateThreshold,
      llmCalls: this.llmCalls,
      maxLlmCalls: this.maxLlmCalls,
      mapKnowledge: this.mapKnowledge.summarize(toPolicyState(snapshot.state)),
      postActionObservation
    }));
  }

  private detectRepeatedStateFailure(): RunnerFailure | undefined {
    if (this.recentStateHashes.length < this.repeatedStateThreshold) {
      return undefined;
    }

    const repeated = this.recentStateHashes.slice(-this.repeatedStateThreshold);
    const first = repeated[0];
    if (first === undefined || repeated.some((hash) => hash !== first)) {
      return undefined;
    }

    return {
      status: "failed_stuck",
      error: new HarnessError("STUCK", "Runner observed repeated state hash without progress", {
        context: { repeatedStateThreshold: this.repeatedStateThreshold, stateHash: first }
      })
    };
  }

  private timeoutFailure(): RunnerFailure {
    return {
      status: "failed_timeout",
      error: new HarnessError("TIMEOUT", "Runner reached maximum step budget", {
        context: { maxSteps: this.maxSteps }
      })
    };
  }

  private createResult(status: HarnessStatus, error?: HarnessError): HarnessRunResult {
    const detector = this.detector.getStatus();
    return {
      runId: this.evidence.paths?.runId ?? this.config.harnessRunId,
      status,
      startedAt: this.startedAt ?? this.timestamp(),
      completedAt: this.timestamp(),
      totalSteps: this.step,
      finalFrame: this.finalFrame,
      errorCode: error?.code,
      error: error?.toJSON(),
      checkpoints: detector.checkpoints,
      detector,
      last20Actions: [...this.last20Actions],
      recentStateHashes: [...this.recentStateHashes]
    };
  }

  private startConfig(): unknown {
    return {
      runId: this.evidence.paths?.runId ?? this.config.harnessRunId,
      harnessMode: this.config.harnessMode,
      aiProvider: this.config.aiProvider,
      loopMaxSteps: this.maxSteps,
      loopStepDelayMs: this.stepDelayMs,
      maxLlmCalls: this.maxLlmCalls,
      repeatedStateThreshold: this.repeatedStateThreshold
    };
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

interface PokemonTelemetryInput<TState> {
  readonly step: number;
  readonly frame: FrameNumber;
  readonly state: TState;
  readonly stateHash: string;
  readonly decision: PolicyDecision;
  readonly actionSummary: RecordedActionSummary;
  readonly detectorBefore: DetectorStatus;
  readonly detectorAfter: DetectorStatus;
  readonly recentActions: readonly RecordedActionSummary[];
  readonly recentStateHashes: readonly string[];
  readonly repeatedStateThreshold: number;
  readonly llmCalls: number;
  readonly maxLlmCalls: number;
  readonly mapKnowledge?: unknown;
  readonly postActionObservation?: PostActionObservation;
}

function createPokemonTelemetry<TState>(input: PokemonTelemetryInput<TState>): unknown {
  const state = toPolicyState(input.state);
  const detectorBeforeEvidence = checkpointEvidenceLength(input.detectorBefore);
  const detectorAfterEvidence = checkpointEvidence(input.detectorAfter);
  const newCheckpoints = detectorAfterEvidence.slice(detectorBeforeEvidence).map((entry) => objectField(entry, "checkpoint")).filter((value): value is string => typeof value === "string");
  const repeatedTail = countSameTail(input.recentStateHashes);
  const action = input.actionSummary.action;
  const route = routeContext(state);
  const categories = telemetryCategories(state, input.decision, action, newCheckpoints, repeatedTail);

  return {
    schema: "pokemon-harness-telemetry.v1",
    step: input.step,
    frame: input.frame,
    stateHash: input.stateHash,
    categories,
    route,
    location: {
      mapId: state.wCurMap ?? state.mapId,
      y: state.wYCoord ?? state.y,
      x: state.wXCoord ?? state.x,
      yBlock: state.wYBlockCoord,
      xBlock: state.wXBlockCoord,
      facing: state.playerFacingDirection
    },
    battle: {
      kind: typeof state.battle === "object" && state.battle !== null ? objectField(state.battle, "kind") : undefined,
      raw: state.wIsInBattle,
      battleType: state.wBattleType,
      result: state.wBattleResult,
      playerHp: state.wBattleMonHP ?? state.wPartyMon1HP,
      playerMaxHp: state.wPartyMon1MaxHP,
      enemyHp: state.wEnemyMonHP
    },
    party: {
      count: state.wPartyCount ?? state.partyCount,
      firstHp: state.wPartyMon1HP,
      firstMaxHp: state.wPartyMon1MaxHP
    },
    badges: {
      raw: state.wObtainedBadges,
      count: state.badgeCount,
      obtained: state.badgesObtained
    },
    text: {
      kind: state.screenTextKind,
      textBoxId: state.wTextBoxID ?? state.textBoxId,
      menuItem: state.wCurrentMenuItem ?? state.menuItem,
      letterDelayFlags: state.wLetterPrintingDelayFlags ?? state.letterDelayFlags,
      preview: truncate(typeof state.screenText === "string" ? state.screenText : "", 180),
      naming: {
        nameLength: state.wNamingScreenNameLength,
        submitName: state.wNamingScreenSubmitName,
        type: state.wNamingScreenType
      }
    },
    decision: {
      action,
      confidence: input.decision.confidence,
      rationale: input.decision.rationale,
      citations: input.decision.observedStateCitations,
      lowConfidence: input.decision.confidence < 0.45,
      fallback: input.decision.rationale.includes("LLM fallback after") || input.decision.observedStateCitations.some((citation) => citation.includes("LLM fallback after"))
    },
    mapKnowledge: input.mapKnowledge,
    postActionObservation: input.postActionObservation,
    progress: {
      status: input.detectorAfter.status,
      checkpoints: input.detectorAfter.checkpoints,
      newCheckpoints,
      progressStep: numberField(input.detectorAfter, "progressStep"),
      lastProgressStep: numberField(input.detectorAfter, "lastProgressStep"),
      stuckStepCount: numberField(input.detectorAfter, "stuckStepCount"),
      repeatedStateTail: repeatedTail,
      repeatedStateThreshold: input.repeatedStateThreshold,
      llmCalls: input.llmCalls,
      maxLlmCalls: input.maxLlmCalls
    },
    improvementSignals: improvementSignals({
      state,
      decision: input.decision,
      action,
      newCheckpoints,
      repeatedTail,
      repeatedStateThreshold: input.repeatedStateThreshold,
      recentActions: input.recentActions
    })
  };
}

interface PostActionObservation {
  readonly schema: "pokemon-post-action-observation.v1";
  readonly step: number;
  readonly poll: number;
  readonly action: PolicyDecision["action"];
  readonly before: ReturnType<typeof locationSummary>;
  readonly after: ReturnType<typeof locationSummary>;
  readonly change: PostActionChange;
  readonly mapChanged: boolean;
  readonly mapKnowledge: unknown;
  readonly pixelChanged: boolean;
  readonly visualSamples: readonly PostActionVisualSample[];
}

type PostActionTransitionKind =
  | "no_change"
  | "blocked_with_visual_change"
  | "turn_only"
  | "walk_step"
  | "map_transition"
  | "non_adjacent_position_jump"
  | "visual_only_transition";

interface PostActionChange {
  readonly kind: PostActionTransitionKind;
  readonly mapIdChanged: boolean;
  readonly coordinateChanged: boolean;
  readonly adjacentStep: boolean;
  readonly facingChanged: boolean;
  readonly pixelChanged: boolean;
  readonly delta: { readonly mapId?: unknown; readonly y?: number; readonly x?: number; readonly manhattan?: number };
}

interface PostActionVisualSample {
  readonly poll: number;
  readonly screenshotPath: string;
  readonly screenshotHash?: string;
  readonly pixelChanged: boolean;
  readonly visibleMapKindCounts?: VisibleMapObservation["kindCounts"];
}

interface CapturedPostActionVisualSample extends PostActionVisualSample {
  readonly visibleMap?: VisibleMapObservation;
}

function routeContext(state: PokemonStateSnapshot): string {
  const mapId = state.wCurMap ?? state.mapId;
  if (mapId === 38) return "red_house_2f";
  if (mapId === 37) return "red_house_1f";
  if (mapId === 0) return "pallet_town";
  if (mapId === 40) return "oak_lab";
  if (mapId === 0x76) return "hall_of_fame";
  if (state.screenTextKind === "oak_intro") return "oak_intro";
  if (state.screenTextKind === "naming_screen" || state.screenTextKind === "default_name_menu") return "name_flow";
  return "unknown";
}

function telemetryCategories(state: PokemonStateSnapshot, decision: PolicyDecision, action: PolicyDecision["action"], newCheckpoints: readonly string[], repeatedTail: number): string[] {
  const categories = new Set<string>(["step"]);
  if ((state.wIsInBattle ?? 0) !== 0) categories.add("battle");
  if (state.screenTextKind !== undefined && state.screenTextKind !== "none") categories.add("text");
  if (state.menuItem !== undefined || state.wCurrentMenuItem !== undefined) categories.add("menu");
  if (newCheckpoints.length > 0) categories.add("progress");
  if (decision.confidence < 0.45) categories.add("low_confidence");
  if (repeatedTail >= 5) categories.add("possible_stuck");
  if (action.type === "sequence") categories.add("sequence");
  return [...categories];
}

function improvementSignals(input: {
  readonly state: PokemonStateSnapshot;
  readonly decision: PolicyDecision;
  readonly action: PolicyDecision["action"];
  readonly newCheckpoints: readonly string[];
  readonly repeatedTail: number;
  readonly repeatedStateThreshold: number;
  readonly recentActions: readonly RecordedActionSummary[];
}): string[] {
  const signals: string[] = [];
  if (input.decision.confidence < 0.45) signals.push("low_confidence_decision");
  if (input.decision.rationale.includes("LLM fallback after")) signals.push("llm_fallback_used");
  if (input.newCheckpoints.length > 0) signals.push(`checkpoint:${input.newCheckpoints.join(",")}`);
  if (input.repeatedTail >= Math.max(5, Math.floor(input.repeatedStateThreshold / 3))) signals.push("repeated_state_tail");
  if (sameActionTail(input.recentActions, 6)) signals.push("repeated_action_pattern");
  if ((input.state.wIsInBattle ?? 0) !== 0 && input.action.type === "press" && input.action.button !== "A") signals.push("battle_non_attack_input");
  if (input.state.screenTextKind !== undefined && input.state.screenTextKind !== "none" && input.action.type === "press" && !["A", "B", "Start"].includes(input.action.button)) signals.push("text_screen_directional_input");
  return signals;
}

function checkpointEvidence(status: DetectorStatus): unknown[] {
  const value = objectField(status, "checkpointEvidence");
  return Array.isArray(value) ? value : [];
}

function checkpointEvidenceLength(status: DetectorStatus): number {
  return checkpointEvidence(status).length;
}

function objectField(value: unknown, field: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[field] : undefined;
}

function numberField(value: unknown, field: string): number | undefined {
  const entry = objectField(value, field);
  return typeof entry === "number" ? entry : undefined;
}

function countSameTail(values: readonly string[]): number {
  const last = values.at(-1);
  if (last === undefined) return 0;
  let count = 0;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] !== last) break;
    count += 1;
  }
  return count;
}

function sameActionTail(actions: readonly RecordedActionSummary[], count: number): boolean {
  if (actions.length < count) return false;
  const tail = actions.slice(-count).map((entry) => JSON.stringify(entry.action));
  return tail.every((entry) => entry === tail[0]);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function normalizeFailure(error: unknown): RunnerFailure {
  const harnessError = error instanceof HarnessError
    ? error
    : new HarnessError("MGBA_UNAVAILABLE", "Runner dependency failed", { cause: error });

  return { status: statusForErrorCode(harnessError.code), error: harnessError };
}

function normalizePolicyError(error: unknown): HarnessError {
  if (error instanceof HarnessError) {
    if (error.code === "BUDGET_EXCEEDED" || error.code === "LLM_UNAVAILABLE" || error.code === "LLM_INVALID_OUTPUT") {
      return error;
    }

    return new HarnessError("LLM_UNAVAILABLE", "Policy failed before producing a controller action", {
      cause: error,
      context: { originalCode: error.code }
    });
  }

  return new HarnessError("LLM_UNAVAILABLE", "Policy failed before producing a controller action", { cause: error });
}

function statusForErrorCode(code: HarnessErrorCode): HarnessStatus {
  switch (code) {
    case "INVALID_RAM_STATE":
      return "failed_invalid_state";
    case "LLM_UNAVAILABLE":
    case "LLM_INVALID_OUTPUT":
      return "failed_llm";
    case "BUDGET_EXCEEDED":
      return "failed_budget";
    case "TIMEOUT":
      return "failed_timeout";
    case "STUCK":
      return "failed_stuck";
    case "ACTION_REJECTED":
    case "MGBA_UNAVAILABLE":
    case "ROM_NOT_LOADED_OR_INVALID":
    case "SCREENSHOT_FAILED":
      return "failed_mgba";
  }
}

async function fileHash(path: string): Promise<string | undefined> {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch {
    return undefined;
  }
}

function classifyPostActionChange(
  before: PokemonStateSnapshot,
  after: PokemonStateSnapshot,
  visualSamples: readonly PostActionVisualSample[]
): PostActionChange {
  const beforeMap = before.wCurMap ?? before.mapId;
  const afterMap = after.wCurMap ?? after.mapId;
  const beforeY = numberLike(before.wYCoord ?? before.y);
  const afterY = numberLike(after.wYCoord ?? after.y);
  const beforeX = numberLike(before.wXCoord ?? before.x);
  const afterX = numberLike(after.wXCoord ?? after.x);
  const mapIdChanged = beforeMap !== afterMap;
  const coordinateChanged = beforeY !== afterY || beforeX !== afterX;
  const facingChanged = (before.playerFacingDirection ?? before.wSpritePlayerStateData1FacingDirection) !==
    (after.playerFacingDirection ?? after.wSpritePlayerStateData1FacingDirection);
  const pixelChanged = visualSamples.some((sample) => sample.pixelChanged);
  const dy = beforeY !== undefined && afterY !== undefined ? afterY - beforeY : undefined;
  const dx = beforeX !== undefined && afterX !== undefined ? afterX - beforeX : undefined;
  const manhattan = dy !== undefined && dx !== undefined ? Math.abs(dy) + Math.abs(dx) : undefined;
  const adjacentStep = !mapIdChanged && coordinateChanged && manhattan === 1;

  return {
    kind: classifyTransitionKind({ mapIdChanged, coordinateChanged, adjacentStep, facingChanged, pixelChanged }),
    mapIdChanged,
    coordinateChanged,
    adjacentStep,
    facingChanged,
    pixelChanged,
    delta: { mapId: mapIdChanged ? afterMap : undefined, y: dy, x: dx, manhattan }
  };
}

function classifyTransitionKind(input: {
  readonly mapIdChanged: boolean;
  readonly coordinateChanged: boolean;
  readonly adjacentStep: boolean;
  readonly facingChanged: boolean;
  readonly pixelChanged: boolean;
}): PostActionTransitionKind {
  if (input.mapIdChanged) return "map_transition";
  if (input.coordinateChanged && input.adjacentStep) return "walk_step";
  if (input.coordinateChanged) return "non_adjacent_position_jump";
  if (input.facingChanged) return "turn_only";
  if (input.pixelChanged) return "blocked_with_visual_change";
  return "no_change";
}

function numberLike(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function publicVisualSample(sample: CapturedPostActionVisualSample): PostActionVisualSample {
  return {
    poll: sample.poll,
    screenshotPath: sample.screenshotPath,
    screenshotHash: sample.screenshotHash,
    pixelChanged: sample.pixelChanged,
    visibleMapKindCounts: sample.visibleMapKindCounts
  };
}

function containsDirectionalAction(action: PolicyDecision["action"]): boolean {
  if (action.type === "sequence") {
    return action.actions.some((entry) => containsDirectionalAction(entry));
  }

  return (action.type === "press" || action.type === "hold") && ["Up", "Right", "Down", "Left"].includes(action.button);
}

function locationChanged(before: PokemonStateSnapshot, after: PokemonStateSnapshot): boolean {
  return (before.wCurMap ?? before.mapId) !== (after.wCurMap ?? after.mapId) ||
    (before.wYCoord ?? before.y) !== (after.wYCoord ?? after.y) ||
    (before.wXCoord ?? before.x) !== (after.wXCoord ?? after.x);
}

function locationSummary(state: PokemonStateSnapshot): { mapId?: unknown; y?: unknown; x?: unknown; facing?: unknown } {
  return {
    mapId: state.wCurMap ?? state.mapId,
    y: state.wYCoord ?? state.y,
    x: state.wXCoord ?? state.x,
    facing: state.playerFacingDirection
  };
}

function toPolicyState(value: unknown): PokemonStateSnapshot {
  return typeof value === "object" && value !== null ? value as PokemonStateSnapshot : {};
}

function toDetectorState(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function stableHash(value: unknown): string {
  return stableJson(value);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)])
    );
  }

  return value;
}

function trimToLimit<T>(items: T[], limit: number): void {
  if (items.length > limit) {
    items.splice(0, items.length - limit);
  }
}
