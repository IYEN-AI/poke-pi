export type BattleKind = "none" | "wild" | "trainer" | "lost";

export type BattleFlag =
  | { kind: "none"; raw: 0 }
  | { kind: "wild"; raw: 1 }
  | { kind: "trainer"; raw: 2 }
  | { kind: "lost"; raw: 255 };

export interface PokemonCoordinates {
  mapId: number;
  y: number;
  x: number;
  yBlock: number;
  xBlock: number;
}

export type PlayerFacingDirection = "down" | "up" | "left" | "right";

export interface PlayerFacing {
  raw: number;
  direction: PlayerFacingDirection;
}

export interface HitPoints {
  current: number;
  max?: number;
}

export interface PartySummary {
  count: number;
  firstPokemonHp?: HitPoints;
}

export interface BadgeProgress {
  raw: number;
  count: number;
  obtained: readonly boolean[];
}

export interface MenuTextState {
  currentMenuItem: number;
  textBoxId: number;
  letterPrintingDelayFlags: number;
  screenText: string;
  screenTextKind: ScreenTextKind;
  namingScreenNameLength: number;
  namingScreenSubmitName: number;
  namingScreenType: number;
}

export type ScreenTextKind = "none" | "oak_intro" | "default_name_menu" | "naming_screen" | "overworld_text";

export type PokemonMapBlockSemanticKind = "path" | "grass" | "water" | "obstacle" | "warp" | "interaction" | "unknown";

export interface PokemonMapBlockSemanticGuess {
  kind: PokemonMapBlockSemanticKind;
  walkability: "likely_walkable" | "likely_blocked" | "unknown";
  interactionCandidate: boolean;
  source: "static_block_id_hint" | "unclassified_block_id" | "missing_block_id";
  confidence: number;
}

export interface PokemonMapBlockObservation {
  row: number;
  col: number;
  blockId?: number;
  semantic?: PokemonMapBlockSemanticGuess;
}

export interface PokemonMapDirectionCandidate {
  direction: PlayerFacingDirection;
  targetY: number;
  targetX: number;
  targetBlockRow: number;
  targetBlockCol: number;
  blockId?: number;
  inBounds: boolean;
  semantic?: PokemonMapBlockSemanticGuess;
}

export interface PokemonMapStructure {
  mapId: number;
  width: number;
  height: number;
  stride: number;
  tileset: number;
  currentViewPointer: number;
  currentBlockRow: number;
  currentBlockCol: number;
  currentBlockId?: number;
  currentBlockSemantic?: PokemonMapBlockSemanticGuess;
  visibleBlocks: readonly (readonly number[])[];
  semanticVisibleBlocks?: readonly (readonly PokemonMapBlockObservation[])[];
  directionCandidates: readonly PokemonMapDirectionCandidate[];
}

export interface PokemonGameState {
  battle: BattleFlag;
  coordinates: PokemonCoordinates;
  playerFacing: PlayerFacing;
  party: PartySummary;
  badges: BadgeProgress;
  menuText: MenuTextState;
  mapStructure?: PokemonMapStructure;
}
