import { describe, expect, it } from "vitest";
import { HeuristicPolicy } from "../../src/ai/HeuristicPolicy.js";
import type { PolicyInput, PokemonStateSnapshot } from "../../src/ai/Policy.js";
import { PolicyDecisionSchema } from "../../src/control/ActionSchema.js";

const baseState: PokemonStateSnapshot = {
  wIsInBattle: 0,
  wPartyCount: 1,
  wCurMap: 1,
  wYCoord: 5,
  wXCoord: 6,
  wTextBoxID: 0
};

const zeroBootState: PokemonStateSnapshot = {
  wIsInBattle: 0,
  wPartyCount: 0,
  wCurMap: 0,
  wYCoord: 0,
  wXCoord: 0,
  wTextBoxID: 0
};

const introTextState: PokemonStateSnapshot = {
  wIsInBattle: 0,
  wPartyCount: 0,
  wCurMap: 40,
  wYCoord: 6,
  wXCoord: 3,
  wTextBoxID: 1,
  wLetterPrintingDelayFlags: 3
};

const redsHouse2fState: PokemonStateSnapshot = {
  wIsInBattle: 0,
  wPartyCount: 0,
  wCurMap: 38,
  wYCoord: 6,
  wXCoord: 3,
  wTextBoxID: 0,
  wLetterPrintingDelayFlags: 0
};

const redsHouse1fState: PokemonStateSnapshot = {
  wIsInBattle: 0,
  wPartyCount: 0,
  wCurMap: 37,
  wYCoord: 1,
  wXCoord: 7,
  wTextBoxID: 0,
  wLetterPrintingDelayFlags: 0
};

const palletTownState: PokemonStateSnapshot = {
  wIsInBattle: 0,
  wPartyCount: 0,
  wCurMap: 0,
  wYCoord: 6,
  wXCoord: 5,
  wTextBoxID: 1,
  wLetterPrintingDelayFlags: 1
};

const oakLabStarterState: PokemonStateSnapshot = {
  wIsInBattle: 0,
  wPartyCount: 0,
  wCurMap: 40,
  wYCoord: 3,
  wXCoord: 5,
  wTextBoxID: 1,
  wLetterPrintingDelayFlags: 1,
  wCurrentMenuItem: 1
};

describe("HeuristicPolicy", () => {
  it("chooses different battle and non-battle actions from observed state", async () => {
    const policy = new HeuristicPolicy();

    const battleDecision = await policy.chooseAction({
      state: { ...baseState, wIsInBattle: 1 }
    });
    const nonBattleDecision = await policy.chooseAction({ state: baseState });

    expect(battleDecision.action).toEqual({ type: "press", button: "A", frames: 5 });
    expect(nonBattleDecision.action).toEqual({ type: "wait", frames: 5 });
    expect(battleDecision.observedStateCitations).toContain("wIsInBattle=1");
    expect(nonBattleDecision.observedStateCitations).toContain("wIsInBattle=0");
  });

  it("advances fresh text or menu state and backs out when the same state repeats", async () => {
    const policy = new HeuristicPolicy();
    const textState = { ...baseState, wTextBoxID: 1 };
    const repeatedTextInput: PolicyInput = {
      state: textState,
      recentStates: [textState, textState, textState]
    };

    const freshTextDecision = await policy.chooseAction({ state: textState });
    const repeatedTextDecision = await policy.chooseAction(repeatedTextInput);

    expect(freshTextDecision.action).toEqual({ type: "press", button: "A", frames: 5 });
    expect(repeatedTextDecision.action).toEqual({ type: "press", button: "B", frames: 5 });
    expect(repeatedTextDecision.observedStateCitations).toContain("wTextBoxID=1");
    expect(repeatedTextDecision.observedStateCitations).toContain(
      "sameCoordRepeats=3;bootTitleZeroSignal=false;bootTitleRepeats=0"
    );
  });

  it("uses local repeated-coordinate state instead of absolute step alone", async () => {
    const policy = new HeuristicPolicy();
    const repeatedInput: PolicyInput = {
      state: baseState,
      recentStates: [baseState, baseState, baseState],
      step: 10
    };
    const sameStepDifferentStateInput: PolicyInput = {
      state: { ...baseState, wCurMap: 2, wYCoord: 7, wXCoord: 9 },
      recentStates: [{ ...baseState, wCurMap: 2, wYCoord: 7, wXCoord: 9 }],
      step: 10
    };

    const repeatedDecision = await policy.chooseAction(repeatedInput);
    const movingDecision = await policy.chooseAction(sameStepDifferentStateInput);

    expect(repeatedDecision.action.type).toBe("press");
    expect(movingDecision.action).toEqual({ type: "wait", frames: 5 });
    expect(repeatedDecision.action).not.toEqual(movingDecision.action);
    expect(repeatedDecision.observedStateCitations).toContain(
      "sameCoordRepeats=3;bootTitleZeroSignal=false;bootTitleRepeats=0"
    );
    expect(movingDecision.observedStateCitations).toContain(
      "sameCoordRepeats=1;bootTitleZeroSignal=false;bootTitleRepeats=0"
    );
  });

  it("progresses all-zero boot or title state with safe Start and A buttons", async () => {
    const policy = new HeuristicPolicy();
    const freshBootDecision = await policy.chooseAction({ state: zeroBootState });
    const repeatedBootDecision = await policy.chooseAction({
      state: zeroBootState,
      recentStates: [zeroBootState, zeroBootState, zeroBootState]
    });

    expect(freshBootDecision.action).toEqual({ type: "press", button: "Start", frames: 5 });
    expect(repeatedBootDecision.action).toEqual({ type: "press", button: "A", frames: 5 });
    expect(freshBootDecision.observedStateCitations).toContain(
      "sameCoordRepeats=0;bootTitleZeroSignal=true;bootTitleRepeats=0"
    );
    expect(repeatedBootDecision.observedStateCitations).toContain(
      "sameCoordRepeats=3;bootTitleZeroSignal=true;bootTitleRepeats=3"
    );
  });

  it("advances repeated intro text before starter acquisition instead of backing out", async () => {
    const policy = new HeuristicPolicy();
    const decision = await policy.chooseAction({
      state: introTextState,
      recentStates: [introTextState, introTextState, introTextState]
    });

    expect(decision.action).toEqual({ type: "press", button: "A", frames: 5 });
    expect(decision.action).not.toEqual({ type: "press", button: "B", frames: 5 });
    expect(decision.rationale).toContain("before starter acquisition");
    expect(decision.observedStateCitations).toContain("partyCount=0");
    expect(decision.observedStateCitations).toContain("wTextBoxID=1");
    expect(decision.observedStateCitations).toContain("coords=40:6:3");
    expect(decision.observedStateCitations).toContain(
      "sameCoordRepeats=3;bootTitleZeroSignal=false;bootTitleRepeats=0"
    );
  });

  it("uses screen text to keep Oak intro ahead of Red house coordinate routing", async () => {
    const policy = new HeuristicPolicy();
    const decision = await policy.chooseAction({
      state: {
        ...redsHouse2fState,
        wTextBoxID: 1,
        wLetterPrintingDelayFlags: 3,
        screenText: "Hello there! Welcome to the world of POKEMON!",
        screenTextKind: "oak_intro"
      },
      recentStates: [redsHouse2fState, redsHouse2fState, redsHouse2fState]
    });

    expect(decision.action).toEqual({ type: "press", button: "A", frames: 5 });
    expect(decision.rationale).toContain("Oak intro dialogue");
    expect(decision.action).not.toEqual({ type: "hold", button: "Right", frames: 18 });
  });

  it("advances active Oak text boxes even after the first intro phrase", async () => {
    const policy = new HeuristicPolicy();
    const decision = await policy.chooseAction({
      state: {
        ...redsHouse2fState,
        wTextBoxID: 1,
        screenText: "My name is OAK! People call me",
        screenTextKind: "overworld_text"
      }
    });

    expect(decision.action).toEqual({ type: "press", button: "A", frames: 5 });
    expect(decision.rationale).toContain("active non-empty text box");
  });

  it("chooses default names from name menus before overworld routing", async () => {
    const policy = new HeuristicPolicy();
    const initialNameMenu = await policy.chooseAction({
      state: {
        ...redsHouse2fState,
        screenText: "NEW NAME ASH JACK JOHN",
        screenTextKind: "default_name_menu",
        wCurrentMenuItem: 0
      }
    });
    const selectedDefaultName = await policy.chooseAction({
      state: {
        ...redsHouse2fState,
        screenText: "NEW NAME ASH JACK JOHN",
        screenTextKind: "default_name_menu",
        wCurrentMenuItem: 1
      }
    });

    expect(initialNameMenu.action).toEqual({ type: "press", button: "Down", frames: 5 });
    expect(selectedDefaultName.action).toEqual({ type: "press", button: "A", frames: 5 });
  });

  it("handles Oak Lab starter prompts without looping generic A", async () => {
    const policy = new HeuristicPolicy();
    const promptDecision = await policy.chooseAction({
      state: {
        ...oakLabStarterState,
        screenText: "OAK Now RED which POKEMON do you want?",
        screenTextKind: "overworld_text"
      },
      recentStates: [oakLabStarterState, oakLabStarterState, oakLabStarterState]
    });
    const faceStarterDecision = await policy.chooseAction({
      state: {
        ...oakLabStarterState,
        playerFacingDirection: "up",
        screenText: "",
        screenTextKind: "none"
      },
      recentStates: [oakLabStarterState, oakLabStarterState, oakLabStarterState]
    });
    const selectStarterDecision = await policy.chooseAction({
      state: {
        ...oakLabStarterState,
        playerFacingDirection: "right",
        screenText: "",
        screenTextKind: "none"
      },
      recentStates: [oakLabStarterState, oakLabStarterState, oakLabStarterState, oakLabStarterState]
    });

    expect(promptDecision.action).toEqual({ type: "press", button: "A", frames: 5 });
    expect(promptDecision.action).not.toEqual({ type: "press", button: "B", frames: 5 });
    expect(faceStarterDecision.action).toEqual({ type: "press", button: "Right", frames: 5 });
    expect(selectStarterDecision.action).toEqual({ type: "press", button: "A", frames: 5 });
  });

  it("uses the raw player-facing byte for Oak Lab starter selection when no decoded direction is present", async () => {
    const policy = new HeuristicPolicy();
    const faceStarterDecision = await policy.chooseAction({
      state: {
        ...oakLabStarterState,
        wSpritePlayerStateData1FacingDirection: 0x04,
        screenText: "",
        screenTextKind: "none"
      },
      recentStates: [oakLabStarterState, oakLabStarterState, oakLabStarterState]
    });
    const selectStarterDecision = await policy.chooseAction({
      state: {
        ...oakLabStarterState,
        wSpritePlayerStateData1FacingDirection: 0x0c,
        screenText: "",
        screenTextKind: "none"
      },
      recentStates: [oakLabStarterState, oakLabStarterState, oakLabStarterState]
    });

    expect(faceStarterDecision.action).toEqual({ type: "press", button: "Right", frames: 5 });
    expect(selectStarterDecision.action).toEqual({ type: "press", button: "A", frames: 5 });
  });

  it("advances visible Oak Lab dialogue before starter-facing logic", async () => {
    const policy = new HeuristicPolicy();
    const decision = await policy.chooseAction({
      state: {
        ...oakLabStarterState,
        playerFacingDirection: "up",
        screenText: "I fed up with waiting!",
        screenTextKind: "overworld_text"
      },
      recentStates: [oakLabStarterState, oakLabStarterState, oakLabStarterState]
    });

    expect(decision.action).toEqual({ type: "press", button: "A", frames: 5 });
    expect(decision.rationale).toContain("active non-empty text box");
  });

  it("continues post-starter Oak Lab text with A instead of backing out", async () => {
    const policy = new HeuristicPolicy();
    const postStarterState = {
      ...oakLabStarterState,
      wPartyCount: 1,
      playerFacingDirection: "right",
      screenText: "RIVAL received a SQUIRTLE!",
      screenTextKind: "overworld_text"
    };

    const decision = await policy.chooseAction({
      state: postStarterState,
      recentStates: [postStarterState, postStarterState, postStarterState]
    });

    expect(decision.action).toEqual({ type: "press", button: "A", frames: 5 });
    expect(decision.action).not.toEqual({ type: "press", button: "B", frames: 5 });
    expect(decision.rationale).toContain("rival battle");
  });

  it("routes post-starter Oak Lab stale text state down to the rival trigger", async () => {
    const policy = new HeuristicPolicy();
    const postStarterStaleState = {
      ...oakLabStarterState,
      wPartyCount: 1,
      wCurrentMenuItem: 5,
      playerFacingDirection: "right",
      screenText: "",
      screenTextKind: "none"
    };

    const decision = await policy.chooseAction({
      state: postStarterStaleState,
      recentStates: [postStarterStaleState, postStarterStaleState, postStarterStaleState]
    });

    expect(decision.action).toEqual({ type: "hold", button: "Down", frames: 18 });
    expect(decision.action).not.toEqual({ type: "press", button: "A", frames: 5 });
    expect(decision.action).not.toEqual({ type: "press", button: "B", frames: 5 });
    expect(decision.rationale).toContain("y=6");
  });

  it("routes through Red's house toward stairs and door despite stale text flags after the intro", async () => {
    const policy = new HeuristicPolicy();
    const visibleTextState = { ...redsHouse2fState, wTextBoxID: 1, wLetterPrintingDelayFlags: 3, screenText: "Visible text" };
    const staleTextState = { ...redsHouse2fState, wTextBoxID: 1, wLetterPrintingDelayFlags: 3, screenText: "" };

    const activeTextDecision = await policy.chooseAction({
      state: visibleTextState
    });
    const repeatedTextDecision = await policy.chooseAction({
      state: staleTextState,
      recentStates: [staleTextState, staleTextState, staleTextState]
    });
    const upstairsDecision = await policy.chooseAction({ state: redsHouse2fState });
    const downstairsDecision = await policy.chooseAction({ state: redsHouse1fState });
    const palletDecision = await policy.chooseAction({ state: palletTownState });

    expect(activeTextDecision.action).toEqual({ type: "press", button: "A", frames: 5 });
    expect(repeatedTextDecision.action).toEqual({ type: "hold", button: "Right", frames: 18 });
    expect(upstairsDecision.action).toEqual({ type: "hold", button: "Right", frames: 18 });
    expect(downstairsDecision.action).toEqual({ type: "hold", button: "Left", frames: 18 });
    expect(palletDecision.action).toEqual({ type: "hold", button: "Right", frames: 18 });
    expect(repeatedTextDecision.rationale).toContain("ignore repeated stale text RAM");
    expect(upstairsDecision.rationale).toContain("upstairs room");
    expect(downstairsDecision.rationale).toContain("downstairs room");
    expect(palletDecision.rationale).toContain("Pallet Town");
  });

  it("routes post-starter Pallet Town around the lab fence instead of backing out of stale text", async () => {
    const policy = new HeuristicPolicy();
    const belowFence = {
      ...palletTownState,
      wPartyCount: 1,
      wYCoord: 12,
      wXCoord: 10,
      playerFacingDirection: "down",
      screenText: "",
      screenTextKind: "none"
    };
    const fenceGap = { ...belowFence, wXCoord: 5 };
    const secondFence = { ...belowFence, wYCoord: 10, wXCoord: 5 };
    const leftGap = { ...belowFence, wYCoord: 10, wXCoord: 2 };
    const aboveFence = { ...belowFence, wYCoord: 7, wXCoord: 5 };

    const belowFenceDecision = await policy.chooseAction({
      state: belowFence,
      recentStates: [belowFence, belowFence, belowFence]
    });
    const gapDecision = await policy.chooseAction({ state: fenceGap });
    const secondFenceDecision = await policy.chooseAction({ state: secondFence });
    const leftGapDecision = await policy.chooseAction({ state: leftGap });
    const aboveFenceDecision = await policy.chooseAction({ state: aboveFence });

    expect(belowFenceDecision.action).toEqual({ type: "hold", button: "Left", frames: 18 });
    expect(gapDecision.action).toEqual({ type: "hold", button: "Up", frames: 18 });
    expect(secondFenceDecision.action).toEqual({ type: "hold", button: "Left", frames: 18 });
    expect(leftGapDecision.action).toEqual({ type: "hold", button: "Up", frames: 18 });
    expect(aboveFenceDecision.action).toEqual({ type: "hold", button: "Right", frames: 18 });
    expect(belowFenceDecision.action).not.toEqual({ type: "press", button: "B", frames: 5 });
    expect(belowFenceDecision.rationale).toContain("Route 1");
  });

  it("routes up from the observed Red house 2F x5 blocker", async () => {
    const policy = new HeuristicPolicy();
    const liveBlockedState = {
      ...redsHouse2fState,
      wXCoord: 5,
      wTextBoxID: 1,
      wLetterPrintingDelayFlags: 1,
      wCurrentMenuItem: 1,
      screenText: "",
      screenTextKind: "none"
    };

    const decision = await policy.chooseAction({
      state: liveBlockedState,
      recentStates: [liveBlockedState, liveBlockedState, liveBlockedState]
    });

    expect(decision.action).toEqual({ type: "hold", button: "Up", frames: 18 });
    expect(decision.action).not.toEqual({ type: "hold", button: "Right", frames: 18 });
    expect(decision.rationale).toContain("stair warp");
  });

  it("routes down from the observed Red house 1F x4 blocker", async () => {
    const policy = new HeuristicPolicy();
    const liveBlockedState = {
      ...redsHouse1fState,
      wXCoord: 4,
      wTextBoxID: 1,
      wLetterPrintingDelayFlags: 1,
      wCurrentMenuItem: 1,
      screenText: "",
      screenTextKind: "none"
    };

    const decision = await policy.chooseAction({
      state: liveBlockedState,
      recentStates: [liveBlockedState, liveBlockedState, liveBlockedState]
    });

    expect(decision.action).toEqual({ type: "hold", button: "Down", frames: 18 });
    expect(decision.action).not.toEqual({ type: "hold", button: "Left", frames: 18 });
    expect(decision.rationale).toContain("front-door warp");
  });

  it("routes left from the observed Red house 1F x4 y3 blocker", async () => {
    const policy = new HeuristicPolicy();
    const liveBlockedState = {
      ...redsHouse1fState,
      wYCoord: 3,
      wXCoord: 4,
      wTextBoxID: 1,
      wLetterPrintingDelayFlags: 1,
      wCurrentMenuItem: 1,
      screenText: "",
      screenTextKind: "none"
    };

    const decision = await policy.chooseAction({
      state: liveBlockedState,
      recentStates: [liveBlockedState, liveBlockedState, liveBlockedState]
    });

    expect(decision.action).toEqual({ type: "hold", button: "Left", frames: 18 });
    expect(decision.action).not.toEqual({ type: "hold", button: "Down", frames: 18 });
    expect(decision.rationale).toContain("front-door warp");
  });

  it("continues down from Red house 1F left door column after stale text becomes empty", async () => {
    const policy = new HeuristicPolicy();
    const leftDoorColumn = {
      ...redsHouse1fState,
      wYCoord: 3,
      wXCoord: 2,
      wTextBoxID: 1,
      wLetterPrintingDelayFlags: 1,
      wCurrentMenuItem: 1,
      screenText: "",
      screenTextKind: "none"
    };

    const leftDoorDecision = await policy.chooseAction({
      state: leftDoorColumn,
      recentStates: [leftDoorColumn, leftDoorColumn, leftDoorColumn]
    });

    expect(leftDoorDecision.action).toEqual({ type: "hold", button: "Down", frames: 18 });
    expect(leftDoorDecision.action).not.toEqual({ type: "hold", button: "Right", frames: 18 });
  });

  it("routes left from the observed Red house 1F x3 y3 blocker", async () => {
    const policy = new HeuristicPolicy();
    const liveBlockedState = {
      ...redsHouse1fState,
      wYCoord: 3,
      wXCoord: 3,
      wTextBoxID: 1,
      wLetterPrintingDelayFlags: 1,
      wCurrentMenuItem: 1,
      screenText: "",
      screenTextKind: "none"
    };

    const decision = await policy.chooseAction({
      state: liveBlockedState,
      recentStates: [liveBlockedState, liveBlockedState, liveBlockedState]
    });

    expect(decision.action).toEqual({ type: "hold", button: "Left", frames: 18 });
    expect(decision.action).not.toEqual({ type: "hold", button: "Down", frames: 18 });
  });

  it("routes the repeated Red house menu state instead of looping on prompt inputs", async () => {
    const policy = new HeuristicPolicy();
    const stuckState = {
      ...redsHouse2fState,
      wTextBoxID: 1,
      wLetterPrintingDelayFlags: 1,
      wCurrentMenuItem: 5
    };
    const decision = await policy.chooseAction({
      state: stuckState,
      recentStates: [stuckState, stuckState, stuckState]
    });

    expect(decision.action).toEqual({ type: "hold", button: "Right", frames: 18 });
    expect(decision.action).not.toEqual({ type: "hold", button: "Left", frames: 18 });
    expect(decision.action).not.toEqual({ type: "hold", button: "Start", frames: 18 });
    expect(decision.action).not.toEqual({ type: "press", button: "A", frames: 5 });
    expect(decision.rationale).toContain("stair warp");
  });

  it("treats empty Route 1 text flags as stale overworld instead of backing out", async () => {
    const policy = new HeuristicPolicy();
    const routeOneState: PokemonStateSnapshot = {
      ...baseState,
      wCurMap: 12,
      wYCoord: 35,
      wXCoord: 10,
      wTextBoxID: 1,
      screenText: "",
      screenTextKind: "none"
    };

    const decision = await policy.chooseAction({
      state: routeOneState,
      recentStates: [routeOneState, routeOneState, routeOneState]
    });

    expect(decision.action.type).toBe("hold");
    if (decision.action.type !== "hold") {
      throw new Error("expected hold action");
    }
    expect(["Up", "Right", "Down", "Left"]).toContain(decision.action.button);
    expect(decision.action).not.toEqual({ type: "press", button: "B", frames: 5 });
  });

  it("keeps repeated initialized overworld coordinates on exploratory directions", async () => {
    const policy = new HeuristicPolicy();
    const decision = await policy.chooseAction({
      state: baseState,
      recentStates: [baseState, baseState, baseState]
    });

    expect(decision.action.type).toBe("press");
    if (decision.action.type !== "press") {
      throw new Error("expected press action");
    }
    expect(["Up", "Right", "Down", "Left"]).toContain(decision.action.button);
    expect(decision.observedStateCitations).toContain(
      "sameCoordRepeats=3;bootTitleZeroSignal=false;bootTitleRepeats=0"
    );
  });

  it("moves immediately on Route 1 with stale empty text flags instead of waiting", async () => {
    const policy = new HeuristicPolicy();
    const routeOneState: PokemonStateSnapshot = {
      ...baseState,
      wCurMap: 12,
      wYCoord: 35,
      wXCoord: 11,
      wTextBoxID: 1,
      wLetterPrintingDelayFlags: 1,
      screenText: "",
      screenTextKind: "none"
    };

    const decision = await policy.chooseAction({ state: routeOneState });

    expect(decision.action).toEqual({ type: "hold", button: "Up", frames: 18 });
    expect(decision.rationale).toContain("Route 1");
  });

  it("does not undo a Route 1 lateral sidestep immediately", async () => {
    const policy = new HeuristicPolicy();
    const routeOneCenter: PokemonStateSnapshot = {
      ...baseState,
      wCurMap: 12,
      wYCoord: 24,
      wXCoord: 10,
      wTextBoxID: 1,
      wLetterPrintingDelayFlags: 1,
      screenText: "",
      screenTextKind: "none"
    };
    const routeOneSidestep: PokemonStateSnapshot = { ...routeOneCenter, wXCoord: 11 };

    const sidestep = await policy.chooseAction({
      state: routeOneCenter,
      recentStates: [routeOneCenter, routeOneCenter],
      recentActions: [{ type: "hold", button: "Up", frames: 18 }]
    });
    const continueForward = await policy.chooseAction({
      state: routeOneSidestep,
      recentActions: [{ type: "hold", button: "Up", frames: 18 }, { type: "hold", button: "Right", frames: 18 }]
    });

    expect(sidestep.action).toEqual({ type: "hold", button: "Right", frames: 18 });
    expect(continueForward.action).toEqual({ type: "hold", button: "Up", frames: 18 });
  });

  it("runs from low-HP wild battles when the battle menu is visible", async () => {
    const policy = new HeuristicPolicy();
    const decision = await policy.chooseAction({
      state: {
        ...baseState,
        wIsInBattle: 1,
        wBattleMonHP: 1,
        screenText: "FIGHT ITEM PKMN RUN",
        screenTextKind: "overworld_text"
      }
    });

    expect(decision.action).toEqual({
      type: "sequence",
      actions: [
        { type: "press", button: "Down", frames: 5 },
        { type: "press", button: "Right", frames: 5 },
        { type: "press", button: "A", frames: 5 }
      ]
    });
    expect(decision.rationale).toContain("RUN");
  });


  it("returns schema-valid decisions with rationale and observed-state citations", async () => {
    const policy = new HeuristicPolicy();
    const inputs: PolicyInput[] = [
      { state: { ...baseState, wIsInBattle: 1 } },
      { state: { ...baseState, textActive: true } },
      { state: zeroBootState, recentStates: [zeroBootState] },
      { state: baseState, recentStates: [baseState, baseState, baseState] },
      { state: baseState }
    ];

    for (const input of inputs) {
      const decision = await policy.chooseAction(input);
      const parsed = PolicyDecisionSchema.safeParse(decision);

      expect(parsed.success).toBe(true);
      expect(decision.rationale).not.toHaveLength(0);
      expect(decision.observedStateCitations.length).toBeGreaterThan(0);
      expect(decision.observedStateCitations.some((citation) => citation.startsWith("wIsInBattle="))).toBe(true);
    }
  });

  it("uses RAM map structure to choose an in-bounds unexplored direction after repeated coordinate stalls", async () => {
    const policy = new HeuristicPolicy();
    const mapAwareState: PokemonStateSnapshot = {
      ...baseState,
      wCurMap: 2,
      wYCoord: 4,
      wXCoord: 4,
      mapStructure: {
        mapId: 2,
        width: 8,
        height: 8,
        stride: 14,
        tileset: 1,
        currentViewPointer: 0xc5d0,
        currentBlockRow: 5,
        currentBlockCol: 5,
        currentBlockId: 0x22,
        visibleBlocks: [[0x22]],
        directionCandidates: [
          { direction: "up", targetY: 3, targetX: 4, targetBlockRow: 4, targetBlockCol: 5, blockId: 0x22, inBounds: true },
          { direction: "right", targetY: 4, targetX: 5, targetBlockRow: 5, targetBlockCol: 5, blockId: 0x22, inBounds: true },
          { direction: "down", targetY: 5, targetX: 4, targetBlockRow: 5, targetBlockCol: 5, blockId: 0x22, inBounds: true },
          { direction: "left", targetY: 4, targetX: 3, targetBlockRow: 5, targetBlockCol: 4, blockId: 0x31, inBounds: true }
        ]
      }
    };

    const decision = await policy.chooseAction({
      state: mapAwareState,
      recentStates: [mapAwareState, mapAwareState],
      recentActions: [{ action: { type: "hold", button: "Up", frames: 18 } }]
    });

    expect(decision.action).toEqual({ type: "hold", button: "Left", frames: 18 });
    expect(decision.rationale).toContain("Map RAM shows 8x8 block map");
    expect(decision.observedStateCitations).toContain(
      "mapStructure=8x8;currentBlock=0x22;candidates=up:in:0x22:unknown/unknown,right:in:0x22:unknown/unknown,down:in:0x22:unknown/unknown,left:in:0x31:unknown/unknown"
    );
  });

  it("does not keep pushing a recently failed map direction into a wall", async () => {
    const policy = new HeuristicPolicy();
    const mapAwareState: PokemonStateSnapshot = {
      ...baseState,
      wCurMap: 2,
      wYCoord: 4,
      wXCoord: 4,
      mapStructure: {
        mapId: 2,
        width: 8,
        height: 8,
        stride: 14,
        tileset: 1,
        currentViewPointer: 0xc5d0,
        currentBlockRow: 5,
        currentBlockCol: 5,
        currentBlockId: 0x22,
        visibleBlocks: [[0x22]],
        directionCandidates: [
          { direction: "up", targetY: 3, targetX: 4, targetBlockRow: 4, targetBlockCol: 5, blockId: 0x22, inBounds: true },
          { direction: "right", targetY: 4, targetX: 5, targetBlockRow: 5, targetBlockCol: 5, blockId: 0x22, inBounds: false },
          { direction: "down", targetY: 5, targetX: 4, targetBlockRow: 5, targetBlockCol: 5, blockId: 0x22, inBounds: false },
          { direction: "left", targetY: 4, targetX: 3, targetBlockRow: 5, targetBlockCol: 4, blockId: 0x22, inBounds: false }
        ]
      }
    };

    const decision = await policy.chooseAction({
      state: mapAwareState,
      recentStates: [mapAwareState, mapAwareState, mapAwareState],
      recentActions: [
        { action: { type: "hold", button: "Up", frames: 18 } },
        { action: { type: "hold", button: "Up", frames: 18 } },
        { action: { type: "hold", button: "Up", frames: 18 } }
      ]
    });

    expect(decision.action).toEqual({ type: "hold", button: "Right", frames: 18 });
    expect(decision.rationale).toContain("instead of continuing to push into the same wall");
  });

  it("avoids recently failed generic exploratory directions when no map structure is available", async () => {
    const policy = new HeuristicPolicy();
    const decision = await policy.chooseAction({
      state: baseState,
      recentStates: [baseState, baseState, baseState],
      recentActions: [
        { action: { type: "press", button: "Right", frames: 5 } },
        { action: { type: "press", button: "Right", frames: 5 } },
        { action: { type: "press", button: "Right", frames: 5 } }
      ]
    });

    expect(decision.action).not.toEqual({ type: "press", button: "Right", frames: 5 });
    expect(decision.rationale).toContain("avoiding recent wall-collision directions");
  });


  it("explores by map structure before pressing A, then interacts only when facing an interaction candidate", async () => {
    const policy = new HeuristicPolicy();
    const mapAwareState: PokemonStateSnapshot = {
      ...baseState,
      wCurMap: 2,
      wYCoord: 4,
      wXCoord: 4,
      playerFacingDirection: "up",
      mapStructure: {
        mapId: 2,
        width: 8,
        height: 8,
        stride: 14,
        tileset: 1,
        currentViewPointer: 0xc5d0,
        currentBlockRow: 5,
        currentBlockCol: 5,
        currentBlockId: 0x22,
        visibleBlocks: [[0x22]],
        directionCandidates: [
          { direction: "up", targetY: 3, targetX: 4, targetBlockRow: 4, targetBlockCol: 5, blockId: 0x22, inBounds: true },
          { direction: "right", targetY: 4, targetX: 5, targetBlockRow: 5, targetBlockCol: 5, blockId: 0x22, inBounds: true },
          { direction: "down", targetY: 5, targetX: 4, targetBlockRow: 5, targetBlockCol: 5, blockId: 0x22, inBounds: true },
          { direction: "left", targetY: 4, targetX: 3, targetBlockRow: 5, targetBlockCol: 4, blockId: 0x31, inBounds: true }
        ]
      }
    };

    const exploratoryDecision = await policy.chooseAction({
      state: mapAwareState,
      recentStates: [mapAwareState],
      recentActions: [{ action: { type: "hold", button: "Up", frames: 18 } }]
    });
    const interactionDecision = await policy.chooseAction({
      state: {
        ...mapAwareState,
        playerFacingDirection: "left"
      },
      recentStates: [mapAwareState, mapAwareState]
    });

    expect(exploratoryDecision.action).toEqual({ type: "hold", button: "Left", frames: 18 });
    expect(exploratoryDecision.action).not.toEqual({ type: "press", button: "A", frames: 5 });
    expect(interactionDecision.action).toEqual({ type: "press", button: "A", frames: 5 });
    expect(interactionDecision.rationale).toContain("Only interact at a map-structure candidate");
  });

});
