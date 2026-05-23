import type { HarnessAction } from "../control/ActionTypes.js";
import type { HarnessStatus } from "../types.js";
import type { DetectorStatus, ProgressDetector } from "./Detector.js";

export type Stage1CheckpointName =
  | "initialObserved"
  | "starterAcquired"
  | "rivalBattleEntered"
  | "rivalBattleExited"
  | "completed";

export type Stage1FailureReason =
  | "no_progress"
  | "runner_timeout"
  | "runner_budget"
  | "mgba_unavailable"
  | "invalid_state"
  | "llm_failure";

export interface Stage1ObservableState {
  readonly [key: string]: unknown;
  readonly wCurMap?: number;
  readonly wYCoord?: number;
  readonly wXCoord?: number;
  readonly wPartyCount?: number;
  readonly wIsInBattle?: number;
  readonly mapId?: number;
  readonly y?: number;
  readonly x?: number;
  readonly partyCount?: number;
  readonly isInBattle?: number | boolean;
  readonly menuItem?: number;
  readonly textBoxId?: number;
  readonly letterDelayFlags?: number;
}

export interface Stage1ObservedFields {
  readonly wCurMap?: number;
  readonly wYCoord?: number;
  readonly wXCoord?: number;
  readonly wPartyCount?: number;
  readonly wIsInBattle?: number;
  readonly menuItem?: number;
  readonly textBoxId?: number;
  readonly letterDelayFlags?: number;
}

export interface Stage1CheckpointEvidence {
  readonly checkpoint: Stage1CheckpointName;
  readonly step: number;
  readonly frame?: number;
  readonly action?: HarnessAction;
  readonly observed: Stage1ObservedFields;
}

export interface Stage1Checkpoints {
  readonly initialObserved: boolean;
  readonly starterAcquired: boolean;
  readonly rivalBattleEntered: boolean;
  readonly rivalBattleExited: boolean;
  readonly completed: boolean;
}

export interface Stage1ProgressSnapshot {
  readonly checkpoints: Stage1Checkpoints;
  readonly starterObservationStreak: number;
  readonly lastBattleFlag?: number;
  readonly step: number;
  readonly frame?: number;
}

export interface Stage1TransitionResult {
  readonly snapshot: Stage1ProgressSnapshot;
  readonly advanced: readonly Stage1CheckpointName[];
  readonly evidence: readonly Stage1CheckpointEvidence[];
}

export interface Stage1DetectorOptions {
  readonly stuckStepThreshold?: number;
}

export interface Stage1Status extends DetectorStatus<Stage1Checkpoints> {
  readonly status: HarnessStatus;
  readonly checkpoints: Stage1Checkpoints;
  readonly progressStep: number;
  readonly lastProgressStep: number;
  readonly stuckStepCount: number;
  readonly stuckStepThreshold: number;
  readonly failureReason?: Stage1FailureReason;
  readonly checkpointEvidence: readonly Stage1CheckpointEvidence[];
  readonly lastObserved?: Stage1ObservedFields;
  readonly runnerOwnedFailureStatuses: readonly HarnessStatus[];
}

export const RUNNER_OWNED_STAGE1_FAILURE_STATUSES = [
  "failed_timeout",
  "failed_budget",
  "failed_mgba",
  "failed_invalid_state",
  "failed_llm"
] as const satisfies readonly HarnessStatus[];

const EMPTY_CHECKPOINTS: Stage1Checkpoints = {
  initialObserved: false,
  starterAcquired: false,
  rivalBattleEntered: false,
  rivalBattleExited: false,
  completed: false
};

const DEFAULT_STUCK_STEP_THRESHOLD = 30;

function isReadableNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function battleFlagFrom(state: Stage1ObservableState): number | undefined {
  if (typeof state.wIsInBattle === "number") {
    return state.wIsInBattle === 0 ? 0 : 1;
  }

  if (typeof state.isInBattle === "boolean") {
    return state.isInBattle ? 1 : 0;
  }

  if (typeof state.isInBattle === "number") {
    return state.isInBattle === 0 ? 0 : 1;
  }

  return undefined;
}

function observedFieldsFrom(state: Stage1ObservableState): Stage1ObservedFields {
  return {
    wCurMap: state.wCurMap ?? state.mapId,
    wYCoord: state.wYCoord ?? state.y,
    wXCoord: state.wXCoord ?? state.x,
    wPartyCount: state.wPartyCount ?? state.partyCount,
    wIsInBattle: battleFlagFrom(state),
    menuItem: state.menuItem,
    textBoxId: state.textBoxId,
    letterDelayFlags: state.letterDelayFlags
  };
}

function hasInitialObservation(fields: Stage1ObservedFields): boolean {
  return (
    isReadableNumber(fields.wCurMap) &&
    isReadableNumber(fields.wYCoord) &&
    isReadableNumber(fields.wXCoord) &&
    isReadableNumber(fields.wPartyCount)
  );
}

function progressSignature(fields: Stage1ObservedFields, checkpoints: Stage1Checkpoints): string {
  return JSON.stringify({
    checkpoints,
    wCurMap: fields.wCurMap,
    wYCoord: fields.wYCoord,
    wXCoord: fields.wXCoord,
    wPartyCount: fields.wPartyCount,
    wIsInBattle: fields.wIsInBattle,
    menuItem: fields.menuItem,
    textBoxId: fields.textBoxId,
    letterDelayFlags: fields.letterDelayFlags
  });
}

function withCheckpoint(checkpoints: Stage1Checkpoints, checkpoint: Stage1CheckpointName): Stage1Checkpoints {
  return { ...checkpoints, [checkpoint]: true };
}

export function createInitialStage1Snapshot(): Stage1ProgressSnapshot {
  return {
    checkpoints: EMPTY_CHECKPOINTS,
    starterObservationStreak: 0,
    step: 0
  };
}

export function evaluateStage1Transition(
  previous: Stage1ProgressSnapshot,
  state: Stage1ObservableState,
  action?: HarnessAction,
  frame?: number
): Stage1TransitionResult {
  const observed = observedFieldsFrom(state);
  let checkpoints = previous.checkpoints;
  let starterObservationStreak = observed.wPartyCount !== undefined && observed.wPartyCount >= 1
    ? previous.starterObservationStreak + 1
    : 0;
  const advanced: Stage1CheckpointName[] = [];
  const evidence: Stage1CheckpointEvidence[] = [];
  const step = previous.step + 1;

  const advance = (checkpoint: Stage1CheckpointName): void => {
    checkpoints = withCheckpoint(checkpoints, checkpoint);
    advanced.push(checkpoint);
    evidence.push({ checkpoint, step, frame, action, observed });
  };

  if (!checkpoints.initialObserved && hasInitialObservation(observed)) {
    advance("initialObserved");
  }

  if (
    checkpoints.initialObserved &&
    !checkpoints.starterAcquired &&
    starterObservationStreak >= 2
  ) {
    advance("starterAcquired");
  }

  if (
    checkpoints.starterAcquired &&
    !checkpoints.rivalBattleEntered &&
    previous.lastBattleFlag === 0 &&
    observed.wIsInBattle !== undefined &&
    observed.wIsInBattle !== 0
  ) {
    advance("rivalBattleEntered");
  }

  if (
    checkpoints.rivalBattleEntered &&
    !checkpoints.rivalBattleExited &&
    previous.lastBattleFlag !== undefined &&
    previous.lastBattleFlag !== 0 &&
    observed.wIsInBattle === 0
  ) {
    advance("rivalBattleExited");
  }

  if (checkpoints.rivalBattleExited && !checkpoints.completed) {
    advance("completed");
  }

  return {
    snapshot: {
      checkpoints,
      starterObservationStreak,
      lastBattleFlag: observed.wIsInBattle,
      step,
      frame
    },
    advanced,
    evidence
  };
}

export class Stage1Detector implements ProgressDetector<Stage1ObservableState, Stage1Status> {
  private snapshot: Stage1ProgressSnapshot = createInitialStage1Snapshot();
  private status: HarnessStatus = "running";
  private failureReason: Stage1FailureReason | undefined;
  private lastProgressStep = 0;
  private stuckStepCount = 0;
  private readonly stuckStepThreshold: number;
  private readonly checkpointEvidence: Stage1CheckpointEvidence[] = [];
  private lastObserved: Stage1ObservedFields | undefined;
  private lastProgressSignature: string | undefined;

  constructor(options: Stage1DetectorOptions = {}) {
    this.stuckStepThreshold = options.stuckStepThreshold ?? DEFAULT_STUCK_STEP_THRESHOLD;
  }

  update(state: Stage1ObservableState, action?: HarnessAction, frame?: number): Stage1Status {
    if (this.status !== "running") {
      return this.getStatus();
    }

    const transition = evaluateStage1Transition(this.snapshot, state, action, frame);
    this.snapshot = transition.snapshot;
    this.checkpointEvidence.push(...transition.evidence);
    this.lastObserved = observedFieldsFrom(state);

    if (transition.advanced.length > 0) {
      this.lastProgressStep = this.snapshot.step;
      this.stuckStepCount = 0;
    } else {
      const signature = progressSignature(this.lastObserved, this.snapshot.checkpoints);
      this.stuckStepCount = signature === this.lastProgressSignature ? this.stuckStepCount + 1 : 0;
      this.lastProgressSignature = signature;
    }

    if (this.snapshot.checkpoints.completed) {
      this.status = "completed";
    } else if (this.stuckStepCount >= this.stuckStepThreshold) {
      this.status = "failed_stuck";
      this.failureReason = "no_progress";
    }

    if (transition.advanced.length > 0) {
      this.lastProgressSignature = progressSignature(this.lastObserved, this.snapshot.checkpoints);
    }

    return this.getStatus();
  }

  getStatus(): Stage1Status {
    return {
      status: this.status,
      checkpoints: this.snapshot.checkpoints,
      progressStep: this.snapshot.step,
      lastProgressStep: this.lastProgressStep,
      stuckStepCount: this.stuckStepCount,
      stuckStepThreshold: this.stuckStepThreshold,
      failureReason: this.failureReason,
      checkpointEvidence: [...this.checkpointEvidence],
      lastObserved: this.lastObserved,
      runnerOwnedFailureStatuses: RUNNER_OWNED_STAGE1_FAILURE_STATUSES
    };
  }
}
