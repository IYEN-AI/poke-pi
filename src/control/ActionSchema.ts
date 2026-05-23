import { z } from "zod";
import { MGBA_BUTTONS } from "../mgba/MgbaTypes.js";
import type { HarnessAction, PolicyDecision } from "./ActionTypes.js";

const FrameCountSchema = z.int().min(1).max(60);

export const MgbaButtonSchema = z.enum(MGBA_BUTTONS);

const PressActionSchema = z.strictObject({
  type: z.literal("press"),
  button: MgbaButtonSchema,
  frames: FrameCountSchema
});

const HoldActionSchema = z.strictObject({
  type: z.literal("hold"),
  button: MgbaButtonSchema,
  frames: FrameCountSchema
});

const WaitActionSchema = z.strictObject({
  type: z.literal("wait"),
  frames: FrameCountSchema
});

function sequenceDepth(action: HarnessAction): number {
  if (action.type !== "sequence") {
    return 0;
  }

  return 1 + Math.max(0, ...action.actions.map(sequenceDepth));
}

export const HarnessActionSchema: z.ZodType<HarnessAction> = z.lazy(() =>
  z.discriminatedUnion("type", [
    PressActionSchema,
    HoldActionSchema,
    WaitActionSchema,
    z.strictObject({
      type: z.literal("sequence"),
      actions: z.array(HarnessActionSchema).max(24)
    })
  ])
).superRefine((action, context) => {
  if (sequenceDepth(action) > 2) {
    context.addIssue({
      code: "custom",
      message: "Sequence depth must be at most 2",
      path: ["actions"]
    });
  }
});

export const PolicyDecisionSchema: z.ZodType<PolicyDecision> = z.strictObject({
  action: HarnessActionSchema,
  rationale: z.string().min(1).max(500),
  confidence: z.number().min(0).max(1),
  observedStateCitations: z.array(z.string()).max(5)
});

export function createPolicyDecisionJsonSchema(): unknown {
  return z.toJSONSchema(PolicyDecisionSchema);
}

export function createHarnessActionJsonSchema(): unknown {
  return z.toJSONSchema(HarnessActionSchema);
}
