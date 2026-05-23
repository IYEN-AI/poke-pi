import { describe, expect, it } from "vitest";
import {
  evaluateStage1Transition,
  createInitialStage1Snapshot,
  RUNNER_OWNED_STAGE1_FAILURE_STATUSES,
  Stage1Detector,
  type Stage1ObservableState
} from "../../src/pokemon/Stage1Detector.js";

function state(overrides: Partial<Stage1ObservableState> = {}): Stage1ObservableState {
  return {
    wCurMap: 0,
    wYCoord: 6,
    wXCoord: 5,
    wPartyCount: 0,
    wIsInBattle: 0,
    ...overrides
  };
}

describe("Stage1Detector", () => {
  it("completes only after ordered initial, starter, battle entry, and battle exit checkpoints", () => {
    const detector = new Stage1Detector();

    expect(detector.update(state()).checkpoints.initialObserved).toBe(true);
    expect(detector.update(state({ wPartyCount: 1 })).checkpoints.starterAcquired).toBe(false);

    const starterStatus = detector.update(state({ wPartyCount: 1 }), { type: "wait", frames: 1 }, 30);
    expect(starterStatus.checkpoints.starterAcquired).toBe(true);
    expect(starterStatus.status).toBe("running");

    const battleEntered = detector.update(state({ wPartyCount: 1, wIsInBattle: 1 }), undefined, 45);
    expect(battleEntered.checkpoints.rivalBattleEntered).toBe(true);
    expect(battleEntered.status).toBe("running");

    const completed = detector.update(state({ wPartyCount: 1, wIsInBattle: 0 }), undefined, 60);
    expect(completed.status).toBe("completed");
    expect(completed.checkpoints).toEqual({
      initialObserved: true,
      starterAcquired: true,
      rivalBattleEntered: true,
      rivalBattleExited: true,
      completed: true
    });
    expect(completed.checkpointEvidence.map((entry) => entry.checkpoint)).toEqual([
      "initialObserved",
      "starterAcquired",
      "rivalBattleEntered",
      "rivalBattleExited",
      "completed"
    ]);
    expect(completed.checkpointEvidence[1]).toMatchObject({
      checkpoint: "starterAcquired",
      frame: 30,
      observed: { wPartyCount: 1, wIsInBattle: 0 }
    });
  });

  it("ignores battle entry and exit observed before starter acquisition", () => {
    const detector = new Stage1Detector({ stuckStepThreshold: 10 });

    detector.update(state());
    detector.update(state({ wIsInBattle: 1 }));
    detector.update(state({ wIsInBattle: 0 }));
    detector.update(state({ wPartyCount: 1 }));
    const status = detector.update(state({ wPartyCount: 1 }));

    expect(status.status).toBe("running");
    expect(status.checkpoints).toEqual({
      initialObserved: true,
      starterAcquired: true,
      rivalBattleEntered: false,
      rivalBattleExited: false,
      completed: false
    });
    expect(status.checkpointEvidence.map((entry) => entry.checkpoint)).not.toContain("rivalBattleEntered");
  });

  it("fails as stuck after threshold repeated observations without progress", () => {
    const detector = new Stage1Detector({ stuckStepThreshold: 3 });

    detector.update(state());
    detector.update(state({ wYCoord: 7 }));
    detector.update(state({ wYCoord: 7 }));
    detector.update(state({ wYCoord: 7 }));
    const status = detector.update(state({ wYCoord: 7 }));

    expect(status.status).toBe("failed_stuck");
    expect(status.failureReason).toBe("no_progress");
    expect(status.stuckStepCount).toBe(3);
    expect(status.checkpoints.completed).toBe(false);
  });

  it("represents timeout and budget statuses as runner-owned, not detector-set", () => {
    const detector = new Stage1Detector({ stuckStepThreshold: 50 });

    detector.update(state());
    detector.update(state({ wXCoord: 6 }));
    const status = detector.getStatus();

    expect(status.status).toBe("running");
    expect(RUNNER_OWNED_STAGE1_FAILURE_STATUSES).toEqual([
      "failed_timeout",
      "failed_budget",
      "failed_mgba",
      "failed_invalid_state",
      "failed_llm"
    ]);
    expect(status.runnerOwnedFailureStatuses).toContain("failed_timeout");
    expect(status.runnerOwnedFailureStatuses).toContain("failed_budget");
  });

  it("exposes a pure transition helper for deterministic checkpoint tests", () => {
    const initial = createInitialStage1Snapshot();
    const observed = evaluateStage1Transition(initial, state());
    const starterFirstRead = evaluateStage1Transition(observed.snapshot, state({ wPartyCount: 1 }));
    const starterSecondRead = evaluateStage1Transition(starterFirstRead.snapshot, state({ wPartyCount: 1 }));

    expect(observed.advanced).toEqual(["initialObserved"]);
    expect(starterFirstRead.advanced).toEqual([]);
    expect(starterSecondRead.advanced).toEqual(["starterAcquired"]);
    expect(initial.checkpoints.initialObserved).toBe(false);
  });
});
