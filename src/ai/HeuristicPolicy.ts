import { PolicyDecisionSchema } from "../control/ActionSchema.js";
import type { HarnessAction, HoldAction, PolicyDecision, PressAction } from "../control/ActionTypes.js";
import type { MgbaButton } from "../mgba/MgbaTypes.js";
import { mapKnowledgeFromRecent } from "../pokemon/MapKnowledge.js";
import type { MapKnowledgeSummary } from "../pokemon/MapKnowledge.js";
import type { PlayerFacingDirection, PokemonMapDirectionCandidate, PokemonMapStructure } from "../pokemon/PokemonTypes.js";
import type { Policy, PolicyInput, PokemonStateSnapshot, RecentStateSnapshot } from "./Policy.js";

const DEFAULT_PRESS_FRAMES = 5;
const DEFAULT_WAIT_FRAMES = 5;
const DEFAULT_HOLD_FRAMES = 18;
const REPEATED_STATE_THRESHOLD = 3;
const RED_HOUSE_STALE_TEXT_REPEAT_THRESHOLD = 3;
const PLAYER_FACING_RIGHT = 0x0c;

const EXPLORATORY_BUTTONS = ["Up", "Right", "Down", "Left"] as const;
const MAP_AWARE_REPEATED_STATE_THRESHOLD = 1;
const WALL_COLLISION_REPEATED_STATE_THRESHOLD = 2;
const INTERACTION_REPEATED_STATE_THRESHOLD = 2;
const MAP_INTERACTION_BLOCK_IDS = new Set([0x03, 0x04, 0x05, 0x06, 0x07, 0x0c, 0x0d, 0x15, 0x16, 0x17, 0x1c, 0x1d, 0x1e, 0x1f, 0x2c, 0x2d, 0x2e]);

export class HeuristicPolicy implements Policy {
  async chooseAction(input: PolicyInput): Promise<PolicyDecision> {
    const state = toStateSnapshot(input);
    const sameCoordRepeats = countSameCoordinateRepeats(state, input.recentStates ?? []);
    const bootTitleRepeats = countBootTitleRepeats(state, input.recentStates ?? []);
    const citations = buildObservedStateCitations(state, sameCoordRepeats, bootTitleRepeats);

    if (isBootTitleLikeZeroState(state)) {
      const button = chooseBootTitleButton(bootTitleRepeats);
      return validateDecision({
        action: press(button),
        rationale:
          `${button} is safe while Red/Blue RAM is still all zero, indicating boot/title or uninitialized state rather than initialized overworld coordinates.`,
        confidence: 0.62,
        observedStateCitations: citations
      });
    }

    if (isInBattle(state)) {
      const battleAction = chooseBattleAction(state);
      return validateDecision({
        action: battleAction.action,
        rationale: battleAction.rationale,
        confidence: battleAction.confidence,
        observedStateCitations: citations
      });
    }

    const postStarterOakLabDecision = choosePostStarterOakLabAction(state);
    if (postStarterOakLabDecision !== undefined) {
      return validateDecision({
        action: postStarterOakLabDecision.action,
        rationale: postStarterOakLabDecision.rationale,
        confidence: 0.7,
        observedStateCitations: citations
      });
    }

    const oakLabDecision = chooseOakLabStarterAction(state, sameCoordRepeats);
    if (oakLabDecision !== undefined) {
      return validateDecision({
        action: oakLabDecision.action,
        rationale: oakLabDecision.rationale,
        confidence: 0.7,
        observedStateCitations: citations
      });
    }

    const introDecision = chooseIntroScreenAction(state);
    if (introDecision !== undefined) {
      return validateDecision({
        action: introDecision.action,
        rationale: introDecision.rationale,
        confidence: 0.7,
        observedStateCitations: citations
      });
    }

    if (hasActiveTextBox(state)) {
      return validateDecision({
        action: press("A"),
        rationale: "Screen has an active non-empty text box, so advance text before any coordinate-based movement.",
        confidence: 0.7,
        observedStateCitations: citations
      });
    }

    const homeNavigation = chooseHomeNavigationAction(state, sameCoordRepeats);
    if (homeNavigation !== undefined) {
      return validateDecision({
        action: homeNavigation.action,
        rationale: homeNavigation.rationale,
        confidence: 0.68,
        observedStateCitations: citations
      });
    }

    const postStarterRouteOneNavigation = choosePostStarterRouteOneNavigationAction(state);
    if (postStarterRouteOneNavigation !== undefined) {
      return validateDecision({
        action: postStarterRouteOneNavigation.action,
        rationale: postStarterRouteOneNavigation.rationale,
        confidence: 0.6,
        observedStateCitations: citations
      });
    }

    const postStarterOverworldNavigation = choosePostStarterOverworldNavigationAction(state);
    if (postStarterOverworldNavigation !== undefined) {
      return validateDecision({
        action: postStarterOverworldNavigation.action,
        rationale: postStarterOverworldNavigation.rationale,
        confidence: 0.66,
        observedStateCitations: citations
      });
    }

    if (isTextOrMenuActive(state)) {
      const action = shouldBackOutOfRepeatedText(state, sameCoordRepeats) ? press("B") : press("A");
      return validateDecision({
        action,
        rationale:
          action.button === "B"
            ? "Text or menu state appears repeated, so press B once to back out of a possible stale menu."
            : dialogProgressionRationale(state, sameCoordRepeats),
        confidence: 0.64,
        observedStateCitations: citations
      });
    }

    const interactionDecision = chooseGatedInteractionAction(state, sameCoordRepeats);
    if (interactionDecision !== undefined) {
      return validateDecision({
        action: interactionDecision.action,
        rationale: interactionDecision.rationale,
        confidence: 0.63,
        observedStateCitations: citations
      });
    }

    const mapKnowledge = input.mapKnowledge ?? state.mapKnowledge ?? mapKnowledgeFromRecent({
      state,
      recentStates: input.recentStates,
      recentActions: input.recentActions,
      step: input.step
    }).summarize();
    const mapAwareDecision = chooseMapAwareExplorationAction(state, input.recentActions ?? [], sameCoordRepeats, mapKnowledge);
    if (mapAwareDecision !== undefined) {
      return validateDecision({
        action: mapAwareDecision.action,
        rationale: mapAwareDecision.rationale,
        confidence: 0.61,
        observedStateCitations: citations
      });
    }

    if (sameCoordRepeats >= REPEATED_STATE_THRESHOLD) {
      const button = chooseExploratoryButton(state, sameCoordRepeats, input.recentActions ?? []);
      return validateDecision({
        action: press(button),
        rationale: "Overworld coordinates have repeated, so choose a local exploratory direction from the current state hash while avoiding recent wall-collision directions.",
        confidence: 0.56,
        observedStateCitations: citations
      });
    }

    return validateDecision({
      action: { type: "wait", frames: DEFAULT_WAIT_FRAMES },
      rationale: "No battle, text, menu, or repeated-coordinate signal is active, so wait briefly for the next observation.",
      confidence: 0.48,
      observedStateCitations: citations
    });
  }
}

function choosePostStarterOakLabAction(state: PokemonStateSnapshot): Pick<PolicyDecision, "action" | "rationale"> | undefined {
  if (getPartyCount(state) === 0 || state.wCurMap !== 40 || !isTextOrMenuActive(state)) {
    return undefined;
  }

  const screenText = typeof state.screenText === "string" ? state.screenText.trim() : "";
  if (screenText.length === 0 && state.wYCoord !== undefined && state.wXCoord !== undefined) {
    return {
      action: hold(chooseStepToward(state.wYCoord, state.wXCoord, 6, 5, "Down")),
      rationale: "Starter has been acquired and Oak Lab text flags are stale with no visible text, so walk toward y=6 to trigger the rival battle."
    };
  }

  return {
    action: press("A"),
    rationale: "Starter has been acquired in Oak Lab, so continue Oak/Rival text toward the rival battle instead of backing out."
  };
}

function chooseOakLabStarterAction(
  state: PokemonStateSnapshot,
  sameCoordRepeats: number
): Pick<PolicyDecision, "action" | "rationale"> | undefined {
  if (getPartyCount(state) !== 0 || state.wCurMap !== 40) {
    return undefined;
  }

  const y = state.wYCoord;
  const x = state.wXCoord;
  const screenText = typeof state.screenText === "string" ? state.screenText.trim() : "";

  if (screenText.includes("which POK") || screenText.includes("do you want")) {
    return {
      action: press("A"),
      rationale: "Oak is asking which starter to choose, so dismiss the prompt before turning toward the adjacent starter ball."
    };
  }

  if (screenText.length > 0) {
    return undefined;
  }

  if (y === 3 && x === 5 && sameCoordRepeats >= REPEATED_STATE_THRESHOLD && hasOakLabStarterStaleSignals(state)) {
    if (!isPlayerFacingRight(state)) {
      return {
        action: press("Right"),
        rationale: "Player is beside the Oak Lab starter ball but not facing right, so turn toward the starter before interacting."
      };
    }

    return {
      action: press("A"),
      rationale: "Player is beside the Oak Lab starter ball and facing right, so press A to select the adjacent starter."
    };
  }

  if (y !== undefined && x !== undefined && screenText.length === 0 && hasOakLabStarterStaleSignals(state)) {
    const button = chooseStepToward(y, x, 3, 5, "Right");
    return {
      action: hold(button),
      rationale: "Player is in Oak Lab without a starter, so move to the starter-ball interaction tile."
    };
  }

  return undefined;
}

function isPlayerFacingRight(state: PokemonStateSnapshot): boolean {
  if (state.playerFacingDirection === "right") {
    return true;
  }

  return state.wSpritePlayerStateData1FacingDirection === PLAYER_FACING_RIGHT;
}

function hasOakLabStarterStaleSignals(state: PokemonStateSnapshot): boolean {
  const textBoxId = state.wTextBoxID ?? state.textBoxId ?? 0;
  const menuItem = typeof state.wCurrentMenuItem === "number"
    ? state.wCurrentMenuItem
    : typeof state.menuItem === "number"
      ? state.menuItem
      : 0;
  const letterDelayFlags = typeof state.wLetterPrintingDelayFlags === "number"
    ? state.wLetterPrintingDelayFlags
    : typeof state.letterDelayFlags === "number"
      ? state.letterDelayFlags
      : 0;

  return textBoxId !== 0 && menuItem > 0 && letterDelayFlags !== 0;
}

function hasActiveTextBox(state: PokemonStateSnapshot): boolean {
  const textBoxId = typeof state.wTextBoxID === "number"
    ? state.wTextBoxID
    : typeof state.textBoxId === "number"
      ? state.textBoxId
      : 0;
  const screenText = typeof state.screenText === "string" ? state.screenText.trim() : "";

  return textBoxId !== 0 && screenText.length > 0;
}

function chooseIntroScreenAction(state: PokemonStateSnapshot): Pick<PolicyDecision, "action" | "rationale"> | undefined {
  const kind = typeof state.screenTextKind === "string" ? state.screenTextKind : "none";

  if (kind === "oak_intro") {
    return {
      action: press("A"),
      rationale: "Screen text is still Oak intro dialogue, so advance dialogue instead of trusting preloaded Red house coordinates."
    };
  }

  if (kind === "default_name_menu") {
    return {
      action: chooseDefaultNameMenuAction(state),
      rationale: "Screen text is a default-name menu, so choose a default name before attempting overworld movement."
    };
  }

  if (kind === "naming_screen") {
    return {
      action: chooseNamingScreenAction(state),
      rationale: "Screen text is a naming keyboard, so enter or submit a non-empty name before attempting overworld movement."
    };
  }

  return undefined;
}

function chooseDefaultNameMenuAction(state: PokemonStateSnapshot): PressAction {
  const menuItem = typeof state.wCurrentMenuItem === "number"
    ? state.wCurrentMenuItem
    : typeof state.menuItem === "number"
      ? state.menuItem
      : 0;

  return press(menuItem === 0 ? "Down" : "A");
}

function chooseNamingScreenAction(state: PokemonStateSnapshot): PressAction {
  const nameLength = typeof state.wNamingScreenNameLength === "number" ? state.wNamingScreenNameLength : 0;
  return press(nameLength === 0 ? "A" : "Start");
}

function toStateSnapshot(input: PolicyInput): PokemonStateSnapshot {
  if (input.state !== undefined) {
    return input.state;
  }

  if (isRecord(input.currentState)) {
    return input.currentState;
  }

  return {};
}

function isRecord(value: unknown): value is PokemonStateSnapshot {
  return typeof value === "object" && value !== null;
}

function press(button: MgbaButton): PressAction {
  return { type: "press", button, frames: DEFAULT_PRESS_FRAMES };
}

function pressSequence(buttons: readonly MgbaButton[]): HarnessAction {
  return { type: "sequence", actions: buttons.map((button) => press(button)) };
}

function hold(button: MgbaButton): HoldAction {
  return { type: "hold", button, frames: DEFAULT_HOLD_FRAMES };
}

function validateDecision(decision: PolicyDecision): PolicyDecision {
  return PolicyDecisionSchema.parse(decision);
}

function isInBattle(state: PokemonStateSnapshot): boolean {
  return state.wIsInBattle === true || (typeof state.wIsInBattle === "number" && state.wIsInBattle !== 0);
}

function chooseBattleAction(state: PokemonStateSnapshot): { action: HarnessAction; rationale: string; confidence: number } {
  const screenText = typeof state.screenText === "string" ? state.screenText : "";
  const lowHp = typeof state.wBattleMonHP === "number" && state.wBattleMonHP <= 3;
  const wildBattle = state.wIsInBattle === 1 || (typeof state.battle === "object" && state.battle !== null && (state.battle as { kind?: unknown }).kind === "wild");
  const battleMenuVisible = /FIGHT|ITEM|PKMN|RUN/i.test(screenText);

  if (wildBattle && lowHp && battleMenuVisible) {
    return {
      action: pressSequence(["Down", "Right", "A"]),
      rationale: "Wild battle menu is visible and party HP is critically low, so choose RUN instead of attacking and blocking overworld exploration.",
      confidence: 0.69
    };
  }

  return {
    action: press("A"),
    rationale: "Active battle is visible, so press A to progress battle text, menus, or the selected safe move without inventing a route.",
    confidence: 0.72
  };
}

function isTextOrMenuActive(state: PokemonStateSnapshot): boolean {
  const textBoxId = state.wTextBoxID ?? state.textBoxId ?? 0;
  const screenText = typeof state.screenText === "string" ? state.screenText.trim() : undefined;
  const screenTextKind = typeof state.screenTextKind === "string" ? state.screenTextKind : undefined;

  if (textBoxId !== 0 && screenText === "" && screenTextKind === "none" && state.wCurMap !== 40) {
    return state.menuActive === true || state.textActive === true;
  }

  return state.menuActive === true || state.textActive === true || textBoxId !== 0;
}

function chooseHomeNavigationAction(
  state: PokemonStateSnapshot,
  sameCoordRepeats: number
): Pick<PolicyDecision, "action" | "rationale"> | undefined {
  if (getPartyCount(state) !== 0) {
    return undefined;
  }

  const mapId = state.wCurMap;
  const y = state.wYCoord;
  const x = state.wXCoord;
  const textBoxId = state.wTextBoxID ?? state.textBoxId ?? 0;
  const screenText = typeof state.screenText === "string" ? state.screenText.trim() : "";
  const menuItem = typeof state.wCurrentMenuItem === "number"
    ? state.wCurrentMenuItem
    : typeof state.menuItem === "number"
      ? state.menuItem
      : 0;
  const letterDelayFlags = typeof state.wLetterPrintingDelayFlags === "number"
    ? state.wLetterPrintingDelayFlags
    : typeof state.letterDelayFlags === "number"
      ? state.letterDelayFlags
      : 0;

  if (mapId === 38 && y !== undefined && x !== undefined) {
    if (isFreshRedHouseText(textBoxId, letterDelayFlags, menuItem, sameCoordRepeats, screenText)) {
      return {
        action: press("A"),
        rationale: "Player is in Red's upstairs room with fresh text visible, so advance it once before treating repeated text flags as stale."
      };
    }

    const button = chooseRedsHouse2fStep(y, x);
    return {
      action: hold(button),
      rationale: "Player is in Red's upstairs room before starter acquisition, so route toward the stair warp and ignore repeated stale text RAM."
    };
  }

  if (mapId === 37 && y !== undefined && x !== undefined) {
    if (isFreshRedHouseText(textBoxId, letterDelayFlags, menuItem, sameCoordRepeats, screenText)) {
      return {
        action: press("A"),
        rationale: "Player is in Red's downstairs room with fresh text visible, so advance it once before treating repeated text flags as stale."
      };
    }

    const button = chooseRedsHouse1fStep(y, x);
    return {
      action: hold(button),
      rationale: "Player is in Red's downstairs room before starter acquisition, so route toward the front-door warp and ignore repeated stale text RAM."
    };
  }


  if (mapId === 0 && y !== undefined && x !== undefined && !isBootTitleLikeZeroState(state)) {
    const button = chooseStepToward(y, x, 1, 10, "Up");
    return {
      action: hold(button),
      rationale: "Player is in Pallet Town before starter acquisition, so navigate locally toward the north grass trigger that starts Oak's lab flow."
    };
  }

  return undefined;
}

function choosePostStarterRouteOneNavigationAction(
  state: PokemonStateSnapshot
): Pick<PolicyDecision, "action" | "rationale"> | undefined {
  if (getPartyCount(state) === 0 || state.wCurMap !== 12 || state.wYCoord === undefined || state.wXCoord === undefined) {
    return undefined;
  }

  const screenText = typeof state.screenText === "string" ? state.screenText.trim() : "";
  const screenTextKind = typeof state.screenTextKind === "string" ? state.screenTextKind : "none";
  if (screenText.length > 0 || screenTextKind !== "none") {
    return undefined;
  }

  return {
    action: hold(chooseRouteOneStep(state.wYCoord, state.wXCoord)),
    rationale:
      "Player is on Route 1 after starter acquisition with only stale empty text flags, so continue northward route exploration instead of waiting for repeated coordinates."
  };
}

function chooseRouteOneStep(y: number, x: number): MgbaButton {
  if (x > 10) return "Left";
  if (x < 10) return "Right";
  return y > 0 ? "Up" : "Up";
}

function choosePostStarterOverworldNavigationAction(
  state: PokemonStateSnapshot
): Pick<PolicyDecision, "action" | "rationale"> | undefined {
  if (getPartyCount(state) === 0) {
    return undefined;
  }

  const mapId = state.wCurMap;
  const y = state.wYCoord;
  const x = state.wXCoord;
  const screenText = typeof state.screenText === "string" ? state.screenText.trim() : "";
  if (mapId !== 0 || y === undefined || x === undefined || screenText.length > 0) {
    return undefined;
  }

  const button = choosePalletTownRoute1Step(y, x);
  return {
    action: hold(button),
    rationale:
      "Player has a starter and is in Pallet Town with no visible text, so treat empty text RAM flags as stale and route around the lab fence toward Route 1."
  };
}

function choosePalletTownRoute1Step(y: number, x: number): MgbaButton {
  if (y >= 12) {
    if (x > 5) {
      return "Left";
    }

    if (x < 5) {
      return "Right";
    }

    return "Up";
  }

  if (y >= 10) {
    if (x > 2) {
      return "Left";
    }

    if (x < 2) {
      return "Right";
    }

    return "Up";
  }

  if (y > 7) {
    return "Up";
  }

  if (x < 10) {
    return "Right";
  }

  if (x > 10) {
    return "Left";
  }

  return "Up";
}

function isFreshRedHouseText(
  textBoxId: number,
  letterDelayFlags: number,
  menuItem: number,
  sameCoordRepeats: number,
  screenText: string
): boolean {
  return textBoxId !== 0 && screenText.length > 0 && (letterDelayFlags !== 0 || menuItem > 0) && sameCoordRepeats < RED_HOUSE_STALE_TEXT_REPEAT_THRESHOLD;
}

function chooseRedsHouse2fStep(y: number, x: number): MgbaButton {
  if (y > 1) {
    if (x < 5) {
      return "Right";
    }

    if (x > 5) {
      return "Left";
    }

    return "Up";
  }

  if (x < 7) {
    return "Right";
  }

  return "Right";
}

function chooseRedsHouse1fStep(y: number, x: number): MgbaButton {
  if (y >= 3) {
    if (x > 2) {
      return "Left";
    }

    if (x < 2) {
      return "Right";
    }

    return "Down";
  }

  if (y < 7) {
    if (x > 4) {
      return "Left";
    }

    if (x < 4) {
      return "Right";
    }

    return "Down";
  }

  if (x > 3) {
    return "Left";
  }

  if (x < 3) {
    return "Right";
  }

  if (y < 7) {
    return "Down";
  }

  return "Down";
}

function chooseStepToward(
  currentY: number,
  currentX: number,
  targetY: number,
  targetX: number,
  finalButton: MgbaButton
): MgbaButton {
  if (currentX < targetX) {
    return "Right";
  }

  if (currentX > targetX) {
    return "Left";
  }

  if (currentY < targetY) {
    return "Down";
  }

  if (currentY > targetY) {
    return "Up";
  }

  return finalButton;
}



function chooseGatedInteractionAction(
  state: PokemonStateSnapshot,
  sameCoordRepeats: number
): Pick<PolicyDecision, "action" | "rationale"> | undefined {
  if (isTextOrMenuActive(state) || sameCoordRepeats < INTERACTION_REPEATED_STATE_THRESHOLD) {
    return undefined;
  }

  const candidate = getFacingInteractionCandidate(state);
  if (candidate === undefined) {
    return undefined;
  }

  return {
    action: press("A"),
    rationale:
      `Only interact at a map-structure candidate: facing ${candidate.direction} toward block ${formatBlockId(candidate.blockId)} ` +
      `at ${candidate.targetY},${candidate.targetX} after repeated movement did not change coordinates.`
  };
}

function getFacingInteractionCandidate(state: PokemonStateSnapshot): PokemonMapDirectionCandidate | undefined {
  const mapStructure = state.mapStructure;
  const facingDirection = normalizeFacingDirection(state.playerFacingDirection);
  if (mapStructure === undefined || facingDirection === undefined) {
    return undefined;
  }

  const candidate = mapStructure.directionCandidates.find((item) => item.direction === facingDirection);
  if (candidate === undefined || !candidate.inBounds || candidate.blockId === undefined) {
    return undefined;
  }

  if (candidate.blockId === mapStructure.currentBlockId && !MAP_INTERACTION_BLOCK_IDS.has(candidate.blockId)) {
    return undefined;
  }

  return candidate;
}

function normalizeFacingDirection(value: unknown): PlayerFacingDirection | undefined {
  return value === "up" || value === "right" || value === "down" || value === "left" ? value : undefined;
}

function chooseMapAwareExplorationAction(
  state: PokemonStateSnapshot,
  recentActions: readonly unknown[],
  sameCoordRepeats: number,
  mapKnowledge?: MapKnowledgeSummary
): Pick<PolicyDecision, "action" | "rationale"> | undefined {
  const mapStructure = state.mapStructure;
  if (mapStructure === undefined || sameCoordRepeats < MAP_AWARE_REPEATED_STATE_THRESHOLD || isTextOrMenuActive(state)) {
    return undefined;
  }

  const candidates = mapStructure.directionCandidates.filter((candidate) => candidate.inBounds);
  if (candidates.length === 0) {
    return undefined;
  }

  const recentlyFailedButtons = sameCoordRepeats >= WALL_COLLISION_REPEATED_STATE_THRESHOLD
    ? recentDirectionalButtons(recentActions, Math.min(sameCoordRepeats + 2, 8))
    : new Set<MgbaButton>();
  const learnedBlockedDirections = blockedDirectionsFromKnowledge(mapKnowledge);
  const unblockedCandidates = candidates.filter((candidate) =>
    !recentlyFailedButtons.has(directionToButton(candidate.direction)) && !learnedBlockedDirections.has(candidate.direction)
  );
  if (unblockedCandidates.length === 0 && recentlyFailedButtons.size > 0) {
    const probeButton = EXPLORATORY_BUTTONS.find((button) => !recentlyFailedButtons.has(button));
    if (probeButton !== undefined) {
      return {
        action: hold(probeButton),
        rationale:
          `Map RAM candidates were recently tried without coordinate movement (${[...recentlyFailedButtons].join(", ")}), ` +
          `so probe ${probeButton} instead of continuing to push into the same wall.`
      };
    }

    return {
      action: { type: "wait", frames: DEFAULT_WAIT_FRAMES },
      rationale:
        `Map RAM has in-bounds candidates, but all candidate directions were recently tried without coordinate movement ` +
        `(${[...recentlyFailedButtons].join(", ")}), so wait instead of continuing to push into the same wall.`
    };
  }

  const scoredCandidates = (unblockedCandidates.length > 0 ? unblockedCandidates : candidates)
    .map((candidate) => ({ candidate, score: scoreMapCandidate(candidate, mapStructure, recentlyFailedButtons, mapKnowledge) }))
    .sort((left, right) => right.score - left.score || directionPriority(left.candidate.direction) - directionPriority(right.candidate.direction));
  const best = scoredCandidates[0];
  if (best === undefined || best.score < 0) {
    return undefined;
  }

  const button = directionToButton(best.candidate.direction);
  return {
    action: hold(button),
    rationale:
      `Map RAM shows ${mapStructure.width}x${mapStructure.height} block map with current block ${formatBlockId(mapStructure.currentBlockId)}; ` +
      `choose ${button} toward block ${formatBlockId(best.candidate.blockId)} at ${best.candidate.targetY},${best.candidate.targetX} while avoiding recent/learned blocked directions; ` +
      `learned map has ${mapKnowledge?.totals.visitedTiles ?? 0} visited tiles, ${mapKnowledge?.totals.frontierTiles ?? 0} frontier tiles, and ${mapKnowledge?.totals.blockedEdges ?? 0} blocked edges.`
  };
}

function scoreMapCandidate(
  candidate: PokemonMapDirectionCandidate,
  mapStructure: PokemonMapStructure,
  recentlyFailedButtons: ReadonlySet<MgbaButton>,
  mapKnowledge?: MapKnowledgeSummary
): number {
  let score = 0;
  if (candidate.inBounds) {
    score += 10;
  }
  if (candidate.blockId !== undefined) {
    score += 2;
  }
  if (candidate.blockId !== mapStructure.currentBlockId) {
    score += 2;
  }
  if (recentlyFailedButtons.has(directionToButton(candidate.direction))) {
    score -= 100;
  }
  const learnedStatus = learnedCandidateStatus(mapKnowledge, candidate);
  if (learnedStatus === "frontier") {
    score += 6;
  } else if (learnedStatus === "visited") {
    score -= 3;
  }
  if (blockedDirectionsFromKnowledge(mapKnowledge).has(candidate.direction)) {
    score -= 100;
  }
  return score;
}

function blockedDirectionsFromKnowledge(mapKnowledge: MapKnowledgeSummary | undefined): ReadonlySet<PlayerFacingDirection> {
  return new Set((mapKnowledge?.localEdges ?? [])
    .filter((edge) => edge.status === "blocked")
    .map((edge) => edge.direction));
}

function learnedCandidateStatus(
  mapKnowledge: MapKnowledgeSummary | undefined,
  candidate: PokemonMapDirectionCandidate
): "visited" | "frontier" | undefined {
  if (mapKnowledge === undefined) return undefined;
  const targetKey = `${mapKnowledge.current?.mapId}:${candidate.targetY}:${candidate.targetX}`;
  if (mapKnowledge.currentTile !== undefined && `${mapKnowledge.currentTile.mapId}:${mapKnowledge.currentTile.y}:${mapKnowledge.currentTile.x}` === targetKey) {
    return mapKnowledge.currentTile.status;
  }
  if (mapKnowledge.localFrontierTiles.some((tile) => `${tile.mapId}:${tile.y}:${tile.x}` === targetKey)) return "frontier";
  return mapKnowledge.localEdges.some((edge) => edge.to === targetKey && edge.status === "walkable") ? "visited" : undefined;
}

function recentDirectionalButtons(recentActions: readonly unknown[], limit: number): ReadonlySet<MgbaButton> {
  const buttons = new Set<MgbaButton>();
  for (const actionLike of recentActions.slice(-limit)) {
    const button = extractDirectionalButton(actionLike);
    if (button !== undefined) {
      buttons.add(button);
    }
  }
  return buttons;
}

function extractDirectionalButton(actionLike: unknown): MgbaButton | undefined {
  if (!isRecord(actionLike)) {
    return undefined;
  }

  const action = isRecord(actionLike.action) ? actionLike.action : actionLike;
  const button = action.button;
  return isDirectionalButton(button) ? button : undefined;
}

function isDirectionalButton(value: unknown): value is MgbaButton {
  return value === "Up" || value === "Right" || value === "Down" || value === "Left";
}

function directionToButton(direction: PlayerFacingDirection): MgbaButton {
  switch (direction) {
    case "up":
      return "Up";
    case "right":
      return "Right";
    case "down":
      return "Down";
    case "left":
      return "Left";
  }
}

function directionPriority(direction: PlayerFacingDirection): number {
  switch (direction) {
    case "up":
      return 0;
    case "right":
      return 1;
    case "down":
      return 2;
    case "left":
      return 3;
  }
}

function formatBlockId(blockId: number | undefined): string {
  return blockId === undefined ? "unknown" : `0x${blockId.toString(16).padStart(2, "0")}`;
}

function shouldBackOutOfRepeatedText(state: PokemonStateSnapshot, sameCoordRepeats: number): boolean {
  return sameCoordRepeats >= REPEATED_STATE_THRESHOLD && getPartyCount(state) > 0;
}

function dialogProgressionRationale(state: PokemonStateSnapshot, sameCoordRepeats: number): string {
  if (sameCoordRepeats >= REPEATED_STATE_THRESHOLD && getPartyCount(state) === 0) {
    return "Repeated text appears before starter acquisition, so press A to continue intro or Oak dialog instead of backing out.";
  }

  return "Text or menu state appears active, so press A to advance the current prompt.";
}

function getPartyCount(state: PokemonStateSnapshot): number {
  return state.wPartyCount ?? state.partyCount ?? 0;
}

function isBootTitleLikeZeroState(state: PokemonStateSnapshot): boolean {
  return (
    state.wCurMap === 0 &&
    state.wYCoord === 0 &&
    state.wXCoord === 0 &&
    getPartyCount(state) === 0 &&
    state.wIsInBattle === 0 &&
    (state.wTextBoxID ?? state.textBoxId) === 0
  );
}

function countBootTitleRepeats(state: PokemonStateSnapshot, recentStates: readonly RecentStateSnapshot[]): number {
  if (!isBootTitleLikeZeroState(state)) {
    return 0;
  }

  let repeats = 0;
  for (let index = recentStates.length - 1; index >= 0; index -= 1) {
    if (!isBootTitleLikeZeroState(recentStates[index])) {
      break;
    }

    repeats += 1;
  }

  return repeats;
}

function chooseBootTitleButton(bootTitleRepeats: number): "Start" | "A" {
  return bootTitleRepeats % 2 === 0 ? "Start" : "A";
}

function countSameCoordinateRepeats(state: PokemonStateSnapshot, recentStates: readonly RecentStateSnapshot[]): number {
  if (state.wCurMap === undefined || state.wYCoord === undefined || state.wXCoord === undefined) {
    return 0;
  }

  let repeats = 0;
  for (let index = recentStates.length - 1; index >= 0; index -= 1) {
    const recentState = recentStates[index];
    if (
      recentState.wCurMap !== state.wCurMap ||
      recentState.wYCoord !== state.wYCoord ||
      recentState.wXCoord !== state.wXCoord
    ) {
      break;
    }

    repeats += 1;
  }

  return repeats;
}

function chooseExploratoryButton(
  state: PokemonStateSnapshot,
  sameCoordRepeats: number,
  recentActions: readonly unknown[] = []
): (typeof EXPLORATORY_BUTTONS)[number] {
  const recentlyFailedButtons = sameCoordRepeats >= WALL_COLLISION_REPEATED_STATE_THRESHOLD
    ? recentDirectionalButtons(recentActions, Math.min(sameCoordRepeats + 2, 8))
    : new Set<MgbaButton>();
  const availableButtons = EXPLORATORY_BUTTONS.filter((button) => !recentlyFailedButtons.has(button));
  const buttons = availableButtons.length > 0 ? availableButtons : EXPLORATORY_BUTTONS;
  const hash = [state.wCurMap ?? 0, state.wYCoord ?? 0, state.wXCoord ?? 0, sameCoordRepeats].reduce(
    (total, value) => total * 31 + value,
    7
  );

  return buttons[Math.abs(hash) % buttons.length];
}

function buildObservedStateCitations(
  state: PokemonStateSnapshot,
  sameCoordRepeats: number,
  bootTitleRepeats: number
): string[] {
  const partyCount = getPartyCount(state);
  const textBoxId = state.wTextBoxID ?? state.textBoxId ?? 0;
  const bootTitleSignal = isBootTitleLikeZeroState(state);

  const citations = [
    `wIsInBattle=${formatStateValue(state.wIsInBattle ?? 0)}`,
    `partyCount=${partyCount}`,
    `wTextBoxID=${textBoxId}`,
    `coords=${state.wCurMap ?? "unknown"}:${state.wYCoord ?? "unknown"}:${state.wXCoord ?? "unknown"}`,
    `sameCoordRepeats=${sameCoordRepeats};bootTitleZeroSignal=${bootTitleSignal ? "true" : "false"};bootTitleRepeats=${bootTitleRepeats}`
  ];

  if (state.mapStructure !== undefined) {
    citations[2] = mapStructureCitation(state.mapStructure);
  }

  return citations;
}

function mapStructureCitation(mapStructure: PokemonMapStructure | undefined): string {
  if (mapStructure === undefined) {
    return "mapStructure=unavailable";
  }

  const candidates = mapStructure.directionCandidates
    .map((candidate) => `${candidate.direction}:${candidate.inBounds ? "in" : "out"}:${formatBlockId(candidate.blockId)}`)
    .join(",");
  return `mapStructure=${mapStructure.width}x${mapStructure.height};currentBlock=${formatBlockId(mapStructure.currentBlockId)};candidates=${candidates}`;
}

function formatStateValue(value: number | boolean): string {
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }

  return String(value);
}
