import type { MgbaButton } from "../mgba/MgbaTypes.js";

export type PressAction = {
  type: "press";
  button: MgbaButton;
  frames: number;
};

export type HoldAction = {
  type: "hold";
  button: MgbaButton;
  frames: number;
};

export type WaitAction = {
  type: "wait";
  frames: number;
};

export type SequenceAction = {
  type: "sequence";
  actions: HarnessAction[];
};

export type HarnessAction = PressAction | HoldAction | WaitAction | SequenceAction;

export type PolicyDecision = {
  action: HarnessAction;
  rationale: string;
  confidence: number;
  observedStateCitations: string[];
};
