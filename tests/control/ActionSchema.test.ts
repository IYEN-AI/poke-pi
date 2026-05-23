import { describe, expect, it } from "vitest";
import {
  HarnessActionSchema,
  MgbaButtonSchema,
  PolicyDecisionSchema,
  createHarnessActionJsonSchema,
  createPolicyDecisionJsonSchema
} from "../../src/control/ActionSchema.js";
import { MGBA_BUTTONS } from "../../src/mgba/MgbaTypes.js";

describe("ActionSchema", () => {
  it("accepts only the Red/Blue button whitelist", () => {
    expect(MGBA_BUTTONS).toEqual(["A", "B", "Start", "Select", "Up", "Down", "Left", "Right"]);
    expect(MgbaButtonSchema.safeParse("A").success).toBe(true);
    expect(MgbaButtonSchema.safeParse("L").success).toBe(false);
    expect(MgbaButtonSchema.safeParse("R").success).toBe(false);
  });

  it("accepts valid press, hold, wait, and short sequence actions", () => {
    const validActions = [
      { type: "press", button: "A", frames: 5 },
      { type: "hold", button: "Down", frames: 15 },
      { type: "wait", frames: 10 },
      {
        type: "sequence",
        actions: [
          { type: "press", button: "Start", frames: 1 },
          { type: "wait", frames: 2 },
          { type: "hold", button: "Right", frames: 3 }
        ]
      }
    ] as const;

    for (const action of validActions) {
      expect(HarnessActionSchema.safeParse(action).success).toBe(true);
    }
  });

  it("rejects invalid buttons and unsafe frame counts", () => {
    expect(HarnessActionSchema.safeParse({ type: "press", button: "L", frames: 5 }).success).toBe(false);
    expect(HarnessActionSchema.safeParse({ type: "hold", button: "A", frames: 999 }).success).toBe(false);
    expect(HarnessActionSchema.safeParse({ type: "wait", frames: 0 }).success).toBe(false);
    expect(HarnessActionSchema.safeParse({ type: "press", button: "A", frames: 1.5 }).success).toBe(false);
  });

  it("rejects overly long or overly deep sequences", () => {
    expect(
      HarnessActionSchema.safeParse({
        type: "sequence",
        actions: Array.from({ length: 9 }, () => ({ type: "wait", frames: 1 }))
      }).success
    ).toBe(false);

    expect(
      HarnessActionSchema.safeParse({
        type: "sequence",
        actions: [
          {
            type: "sequence",
            actions: [
              {
                type: "sequence",
                actions: [{ type: "wait", frames: 1 }]
              }
            ]
          }
        ]
      }).success
    ).toBe(false);
  });

  it("accepts valid policy decisions", () => {
    const result = PolicyDecisionSchema.safeParse({
      action: { type: "press", button: "A", frames: 5 },
      rationale: "Advance the current dialog using a safe Red/Blue button.",
      confidence: 0.75,
      observedStateCitations: ["wTextBoxID=1", "wIsInBattle=0"]
    });

    expect(result.success).toBe(true);
  });

  it("rejects empty rationale and invalid confidence", () => {
    const baseDecision = {
      action: { type: "wait", frames: 1 },
      rationale: "Pause briefly to observe the next frame.",
      confidence: 0.5,
      observedStateCitations: []
    };

    expect(PolicyDecisionSchema.safeParse({ ...baseDecision, rationale: "" }).success).toBe(false);
    expect(PolicyDecisionSchema.safeParse({ ...baseDecision, confidence: -0.1 }).success).toBe(false);
    expect(PolicyDecisionSchema.safeParse({ ...baseDecision, confidence: 1.1 }).success).toBe(false);
  });

  it("generates JSON schema for actions and policy decisions", () => {
    expect(createHarnessActionJsonSchema()).toEqual(expect.objectContaining({ $schema: expect.any(String) }));
    expect(createPolicyDecisionJsonSchema()).toEqual(expect.objectContaining({ $schema: expect.any(String) }));
  });
});
