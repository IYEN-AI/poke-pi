import type { ScreenshotMetadata } from "../evidence/EvidenceRecorder.js";
import type { PolicyDecision } from "../control/ActionTypes.js";
import type { MapKnowledgeSummary } from "../pokemon/MapKnowledge.js";
import type { PokemonMapStructure } from "../pokemon/PokemonTypes.js";

export interface PokemonStateSnapshot {
  wIsInBattle?: number | boolean;
  wPartyCount?: number;
  partyCount?: number;
  wObtainedBadges?: number;
  badgeCount?: number;
  badgesObtained?: readonly boolean[];
  hallOfFameComplete?: boolean;
  wCurMap?: number;
  wYCoord?: number;
  wXCoord?: number;
  wSpritePlayerStateData1FacingDirection?: number;
  playerFacingDirection?: string;
  wTextBoxID?: number;
  textBoxId?: number;
  screenText?: string;
  screenTextKind?: string;
  wCurrentMenuItem?: number;
  menuItem?: number;
  wLetterPrintingDelayFlags?: number;
  letterDelayFlags?: number;
  wNamingScreenNameLength?: number;
  wNamingScreenSubmitName?: number;
  wNamingScreenType?: number;
  menuActive?: boolean;
  textActive?: boolean;
  mapStructure?: PokemonMapStructure;
  mapKnowledge?: MapKnowledgeSummary;
  [key: string]: unknown;
}

export interface RecentStateSnapshot extends PokemonStateSnapshot {
  step?: number;
  mapKnowledge?: MapKnowledgeSummary;
  recentPostActionObservations?: readonly unknown[];
  visualObservation?: PolicyVisualObservation;
}

export interface PolicyVisualObservation {
  readonly screenshot?: ScreenshotMetadata;
}

export interface PolicyInput {
  state?: PokemonStateSnapshot;
  currentState?: unknown;
  recentActions?: readonly unknown[];
  recentStates?: readonly RecentStateSnapshot[];
  step?: number;
  mapKnowledge?: MapKnowledgeSummary;
  recentPostActionObservations?: readonly unknown[];
  visualObservation?: PolicyVisualObservation;
}

export interface PolicyVisualObservation {
  readonly screenshot?: ScreenshotMetadata;
}

export interface Policy {
  chooseAction(input: PolicyInput): Promise<PolicyDecision>;
}
