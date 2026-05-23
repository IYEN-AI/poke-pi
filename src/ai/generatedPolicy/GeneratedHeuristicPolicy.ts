import { readFile } from "node:fs/promises";
import { PolicyDecisionSchema } from "../../control/ActionSchema.js";
import type { HarnessAction, PolicyDecision } from "../../control/ActionTypes.js";
import type { MgbaButton } from "../../mgba/MgbaTypes.js";
import type { PlayerFacingDirection, PokemonMapDirectionCandidate, PokemonMapStructure } from "../../pokemon/PokemonTypes.js";
import { HeuristicPolicy } from "../HeuristicPolicy.js";
import type { Policy, PolicyInput, PokemonStateSnapshot, RecentStateSnapshot } from "../Policy.js";
import { GeneratedPolicySchema, type GeneratedPolicyDefinition, type GeneratedPolicyRule } from "./GeneratedPolicyTypes.js";

const DEFAULT_HOLD_FRAMES = 18;

export class GeneratedHeuristicPolicy implements Policy {
  private readonly definition: GeneratedPolicyDefinition;
  private readonly basePolicy: Policy;

  constructor(definition: GeneratedPolicyDefinition, basePolicy: Policy = new HeuristicPolicy()) {
    this.definition = GeneratedPolicySchema.parse(definition);
    this.basePolicy = basePolicy;
  }

  static async fromFile(file: string, basePolicy?: Policy): Promise<GeneratedHeuristicPolicy> {
    const parsed = GeneratedPolicySchema.parse(JSON.parse(await readFile(file, "utf8")));
    return new GeneratedHeuristicPolicy(parsed, basePolicy);
  }

  getDefinition(): GeneratedPolicyDefinition {
    return this.definition;
  }

  async chooseAction(input: PolicyInput): Promise<PolicyDecision> {
    const state = toStateSnapshot(input);
    const sameCoordRepeats = countSameCoordinateRepeats(state, input.recentStates ?? []);

    for (const rule of this.definition.rules) {
      if (!matchesRule(rule, state, sameCoordRepeats)) {
        continue;
      }

      const action = chooseRuleAction(rule, state, input.recentActions ?? [], this.definition.tuning, sameCoordRepeats);
      if (action === undefined) {
        continue;
      }

      return validateDecision({
        action,
        rationale: `generated policy ${this.definition.id}/${rule.id}: ${rule.description}`,
        confidence: rule.confidence,
        observedStateCitations: citations(this.definition.id, rule.id, state, sameCoordRepeats)
      });
    }

    if (this.definition.tuning.fallbackToBaseHeuristic) {
      const base = await this.basePolicy.chooseAction(input);
      return validateDecision({
        ...base,
        rationale: `generated policy ${this.definition.id} fell back to base heuristic: ${base.rationale}`.slice(0, 500),
        observedStateCitations: [`generatedPolicy=${this.definition.id};fallback=base`, ...base.observedStateCitations].slice(0, 5)
      });
    }

    return validateDecision({
      action: { type: "wait", frames: 5 },
      rationale: `generated policy ${this.definition.id} found no matching rule and fallback is disabled`,
      confidence: 0.3,
      observedStateCitations: citations(this.definition.id, "no_match", state, sameCoordRepeats)
    });
  }
}

function chooseRuleAction(
  rule: GeneratedPolicyRule,
  state: PokemonStateSnapshot,
  recentActions: readonly unknown[],
  tuning: GeneratedPolicyDefinition["tuning"],
  sameCoordRepeats: number
): HarnessAction | undefined {
  if (rule.explorationStrategy === "bold-route-probe") {
    return chooseBoldRouteProbeAction(state, recentActions, tuning, sameCoordRepeats);
  }

  if (rule.preferMapDirection === true || rule.explorationStrategy === "greedy-map-direction") {
    return chooseMapDirectionAction(state, recentActions, tuning);
  }

  return rule.action;
}

function matchesRule(rule: GeneratedPolicyRule, state: PokemonStateSnapshot, sameCoordRepeats: number): boolean {
  const condition = rule.when;
  if (condition.battle !== undefined && isBattle(state) !== condition.battle) return false;
  if (condition.textActive !== undefined && isTextActive(state) !== condition.textActive) return false;
  if (condition.screenTextKind !== undefined && state.screenTextKind !== condition.screenTextKind) return false;
  if (condition.mapId !== undefined && state.wCurMap !== condition.mapId) return false;
  if (condition.route !== undefined && routeContext(state) !== condition.route) return false;
  if (condition.y !== undefined && state.wYCoord !== condition.y) return false;
  if (condition.x !== undefined && state.wXCoord !== condition.x) return false;
  if (condition.sameCoordRepeatsGte !== undefined && sameCoordRepeats < condition.sameCoordRepeatsGte) return false;
  if (condition.facingInteractionCandidate !== undefined && hasFacingInteractionCandidate(state) !== condition.facingInteractionCandidate) return false;
  return true;
}

function chooseBoldRouteProbeAction(
  state: PokemonStateSnapshot,
  recentActions: readonly unknown[],
  tuning: GeneratedPolicyDefinition["tuning"],
  sameCoordRepeats: number
): HarnessAction | undefined {
  const mapStructure = state.mapStructure;
  if (mapStructure === undefined) {
    return undefined;
  }

  const recentButtons = recentDirectionalButtons(recentActions, 6);
  const boldCandidate = mapStructure.directionCandidates
    .filter((candidate) => candidate.inBounds)
    .map((candidate) => ({ candidate, score: scoreBoldCandidate(candidate, mapStructure, recentButtons, sameCoordRepeats) }))
    .sort((left, right) => right.score - left.score || directionPriority(left.candidate.direction) - directionPriority(right.candidate.direction))[0];

  if (boldCandidate === undefined || boldCandidate.score < 0) {
    return chooseMapDirectionAction(state, recentActions, tuning);
  }

  const button = directionToButton(boldCandidate.candidate.direction);
  const turnFirst = normalizeFacingDirection(state.playerFacingDirection) !== boldCandidate.candidate.direction;
  const holdFrames = Math.min(60, DEFAULT_HOLD_FRAMES + Math.max(0, sameCoordRepeats - tuning.boldProbeAfterRepeats) * 4);
  const actions: HarnessAction[] = turnFirst
    ? [{ type: "press", button, frames: 4 }, { type: "hold", button, frames: holdFrames }]
    : [{ type: "hold", button, frames: holdFrames }];

  return { type: "sequence", actions };
}

function scoreBoldCandidate(
  candidate: PokemonMapDirectionCandidate,
  mapStructure: PokemonMapStructure,
  recentButtons: ReadonlySet<MgbaButton>,
  sameCoordRepeats: number
): number {
  let score = candidate.inBounds ? 8 : -20;
  if (candidate.blockId !== undefined && candidate.blockId !== mapStructure.currentBlockId) score += 6;
  if (candidate.semantic?.kind === "warp") score += 7;
  if (candidate.semantic?.kind === "path" || candidate.semantic?.kind === "grass") score += 3;
  if (candidate.semantic?.walkability === "likely_walkable") score += 2;
  if (candidate.semantic?.interactionCandidate) score += sameCoordRepeats >= 5 ? 1 : -4;
  if (candidate.semantic?.walkability === "likely_blocked") score -= sameCoordRepeats >= 5 ? 2 : 9;
  if (recentButtons.has(directionToButton(candidate.direction))) score -= 16;
  return score;
}

function chooseMapDirectionAction(
  state: PokemonStateSnapshot,
  recentActions: readonly unknown[],
  tuning: GeneratedPolicyDefinition["tuning"]
): HarnessAction | undefined {
  const mapStructure = state.mapStructure;
  if (mapStructure === undefined) {
    return undefined;
  }

  const recentButtons = tuning.avoidRecentDirections ? recentDirectionalButtons(recentActions, 4) : new Set<MgbaButton>();
  const best = mapStructure.directionCandidates
    .filter((candidate) => candidate.inBounds)
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate, mapStructure, recentButtons, tuning.preferDifferentBlock) }))
    .sort((left, right) => right.score - left.score || directionPriority(left.candidate.direction) - directionPriority(right.candidate.direction))[0];

  if (best === undefined || best.score < 0) {
    return undefined;
  }

  return { type: "hold", button: directionToButton(best.candidate.direction), frames: DEFAULT_HOLD_FRAMES };
}

function scoreCandidate(
  candidate: PokemonMapDirectionCandidate,
  mapStructure: PokemonMapStructure,
  recentButtons: ReadonlySet<MgbaButton>,
  preferDifferentBlock: boolean
): number {
  let score = candidate.inBounds ? 10 : -10;
  if (candidate.blockId !== undefined) score += 2;
  if (preferDifferentBlock && candidate.blockId !== mapStructure.currentBlockId) score += 3;
  if (candidate.semantic?.walkability === "likely_walkable") score += 3;
  if (candidate.semantic?.kind === "path" || candidate.semantic?.kind === "grass") score += 1;
  if (candidate.semantic?.kind === "warp") score += 2;
  if (candidate.semantic?.walkability === "likely_blocked") score -= 8;
  if (candidate.semantic?.interactionCandidate) score -= 2;
  if (recentButtons.has(directionToButton(candidate.direction))) score -= 12;
  return score;
}

function hasFacingInteractionCandidate(state: PokemonStateSnapshot): boolean {
  const mapStructure = state.mapStructure;
  const facing = normalizeFacingDirection(state.playerFacingDirection);
  if (mapStructure === undefined || facing === undefined) {
    return false;
  }

  const candidate = mapStructure.directionCandidates.find((entry) => entry.direction === facing);
  return candidate?.inBounds === true && candidate?.blockId !== undefined;
}

function toStateSnapshot(input: PolicyInput): PokemonStateSnapshot {
  if (input.state !== undefined) return input.state;
  return typeof input.currentState === "object" && input.currentState !== null ? input.currentState as PokemonStateSnapshot : {};
}

function isBattle(state: PokemonStateSnapshot): boolean {
  return state.wIsInBattle === true || (typeof state.wIsInBattle === "number" && state.wIsInBattle !== 0);
}

function isTextActive(state: PokemonStateSnapshot): boolean {
  const textBoxId = state.wTextBoxID ?? state.textBoxId ?? 0;
  const screenText = typeof state.screenText === "string" ? state.screenText.trim() : "";
  const screenTextKind = typeof state.screenTextKind === "string" ? state.screenTextKind : "none";

  if (screenText.length > 0) return true;
  if (screenTextKind === "oak_intro" || screenTextKind === "default_name_menu" || screenTextKind === "naming_screen" || screenTextKind === "overworld_text") return true;
  if (textBoxId !== 0 && screenTextKind === "none" && screenText.length === 0) {
    return state.menuActive === true || state.textActive === true;
  }

  return state.menuActive === true || state.textActive === true || textBoxId !== 0;
}

function countSameCoordinateRepeats(state: PokemonStateSnapshot, recentStates: readonly RecentStateSnapshot[]): number {
  if (state.wCurMap === undefined || state.wYCoord === undefined || state.wXCoord === undefined) return 0;
  let repeats = 0;
  for (let index = recentStates.length - 1; index >= 0; index -= 1) {
    const recent = recentStates[index];
    if (recent.wCurMap !== state.wCurMap || recent.wYCoord !== state.wYCoord || recent.wXCoord !== state.wXCoord) break;
    repeats += 1;
  }
  return repeats;
}

function recentDirectionalButtons(recentActions: readonly unknown[], limit: number): Set<MgbaButton> {
  const buttons = new Set<MgbaButton>();
  for (const actionLike of recentActions.slice(-limit)) {
    const button = extractDirectionalButton(actionLike);
    if (button !== undefined) buttons.add(button);
  }
  return buttons;
}

function extractDirectionalButton(actionLike: unknown): MgbaButton | undefined {
  if (typeof actionLike !== "object" || actionLike === null) return undefined;
  const record = actionLike as Record<string, unknown>;
  const action = typeof record.action === "object" && record.action !== null ? record.action as Record<string, unknown> : record;
  const button = action.button;
  return button === "Up" || button === "Right" || button === "Down" || button === "Left" ? button : undefined;
}

function normalizeFacingDirection(value: unknown): PlayerFacingDirection | undefined {
  return value === "up" || value === "right" || value === "down" || value === "left" ? value : undefined;
}

function directionToButton(direction: PlayerFacingDirection): MgbaButton {
  switch (direction) {
    case "up": return "Up";
    case "right": return "Right";
    case "down": return "Down";
    case "left": return "Left";
  }
}

function directionPriority(direction: PlayerFacingDirection): number {
  switch (direction) {
    case "up": return 0;
    case "right": return 1;
    case "down": return 2;
    case "left": return 3;
  }
}

function routeContext(state: PokemonStateSnapshot): string {
  if (state.wCurMap === 38) return "red_house_2f";
  if (state.wCurMap === 37) return "red_house_1f";
  if (state.wCurMap === 0) return "pallet_town";
  if (state.wCurMap === 40) return "oak_lab";
  if (state.wCurMap === 0x76) return "hall_of_fame";
  if (state.screenTextKind === "oak_intro") return "oak_intro";
  if (state.screenTextKind === "naming_screen" || state.screenTextKind === "default_name_menu") return "name_flow";
  return "unknown";
}

function citations(policyId: string, ruleId: string, state: PokemonStateSnapshot, sameCoordRepeats: number): string[] {
  return [
    `generatedPolicy=${policyId};rule=${ruleId}`,
    `coords=${state.wCurMap ?? "unknown"}:${state.wYCoord ?? "unknown"}:${state.wXCoord ?? "unknown"}`,
    `sameCoordRepeats=${sameCoordRepeats}`,
    `text=${state.screenTextKind ?? "unknown"};battle=${isBattle(state) ? "1" : "0"}`
  ];
}

function validateDecision(decision: PolicyDecision): PolicyDecision {
  return PolicyDecisionSchema.parse(decision);
}
