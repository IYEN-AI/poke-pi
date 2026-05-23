import type { MgbaButton } from "../mgba/MgbaTypes.js";
import type { PolicyDecision } from "../control/ActionTypes.js";
import type { PokemonStateSnapshot, RecentStateSnapshot } from "../ai/Policy.js";
import type { PlayerFacingDirection, PokemonMapDirectionCandidate } from "./PokemonTypes.js";

export type LearnedTileStatus = "visited" | "frontier";
export type LearnedEdgeStatus = "walkable" | "blocked" | "transition";

export interface LearnedMapFingerprint {
  readonly mapId: number;
  readonly firstSeenStep?: number;
  readonly lastSeenStep?: number;
  readonly visits: number;
  readonly width?: number;
  readonly height?: number;
  readonly tileset?: number;
  readonly visibleBlockHash?: string;
  readonly semanticAlias?: string;
}

export interface LearnedMapTransition {
  readonly fromMapId: number;
  readonly toMapId: number;
  readonly from: string;
  readonly to: string;
  readonly direction: PlayerFacingDirection;
  readonly attempts: number;
  readonly lastStep?: number;
  readonly fromFingerprint?: LearnedMapFingerprint;
  readonly toFingerprint?: LearnedMapFingerprint;
  readonly semanticAlias?: string;
}

export interface LearnedMapTile {
  readonly mapId: number;
  readonly y: number;
  readonly x: number;
  readonly status: LearnedTileStatus;
  readonly visits: number;
  readonly firstSeenStep?: number;
  readonly lastSeenStep?: number;
  readonly blockId?: number;
}

export interface LearnedMapEdge {
  readonly from: string;
  readonly to: string;
  readonly direction: PlayerFacingDirection;
  readonly status: LearnedEdgeStatus;
  readonly attempts: number;
  readonly successes: number;
  readonly failures: number;
  readonly lastStep?: number;
  readonly blockId?: number;
}

export interface MapKnowledgeSummary {
  readonly schema: "pokemon-map-knowledge.v1";
  readonly current?: { readonly mapId: number; readonly y: number; readonly x: number };
  readonly totals: {
    readonly knownMaps: number;
    readonly visitedTiles: number;
    readonly frontierTiles: number;
    readonly walkableEdges: number;
    readonly blockedEdges: number;
    readonly transitionEdges: number;
    readonly mapTransitions: number;
  };
  readonly currentTile?: LearnedMapTile;
  readonly localFrontierTiles: readonly LearnedMapTile[];
  readonly localEdges: readonly LearnedMapEdge[];
  readonly recentBlockedEdges: readonly LearnedMapEdge[];
  readonly currentMap?: LearnedMapFingerprint;
  readonly knownMaps: readonly LearnedMapFingerprint[];
  readonly recentMapTransitions: readonly LearnedMapTransition[];
}

interface MutableTile {
  mapId: number;
  y: number;
  x: number;
  status: LearnedTileStatus;
  visits: number;
  firstSeenStep?: number;
  lastSeenStep?: number;
  blockId?: number;
}

interface MutableMapFingerprint {
  mapId: number;
  firstSeenStep?: number;
  lastSeenStep?: number;
  visits: number;
  width?: number;
  height?: number;
  tileset?: number;
  visibleBlockHash?: string;
  semanticAlias?: string;
}

interface MutableMapTransition {
  fromMapId: number;
  toMapId: number;
  from: string;
  to: string;
  direction: PlayerFacingDirection;
  attempts: number;
  lastStep?: number;
  semanticAlias?: string;
}

interface MutableEdge {
  from: string;
  to: string;
  direction: PlayerFacingDirection;
  status: LearnedEdgeStatus;
  attempts: number;
  successes: number;
  failures: number;
  lastStep?: number;
  blockId?: number;
}

export class MapKnowledgeTracker {
  private readonly tiles = new Map<string, MutableTile>();
  private readonly edges = new Map<string, MutableEdge>();
  private readonly maps = new Map<number, MutableMapFingerprint>();
  private readonly mapTransitions = new Map<string, MutableMapTransition>();
  private currentKey: string | undefined;

  observeCurrent(state: PokemonStateSnapshot, step?: number): void {
    const location = getLocation(state);
    if (location === undefined) return;

    if (!isMappableOverworld(state)) return;

    const key = tileKey(location.mapId, location.y, location.x);
    this.currentKey = key;
    this.observeMapFingerprint(state, step);
    this.markVisited(location.mapId, location.y, location.x, step, currentBlockId(state));
    for (const candidate of state.mapStructure?.directionCandidates ?? []) {
      if (!candidate.inBounds) continue;
      const targetKey = tileKey(location.mapId, candidate.targetY, candidate.targetX);
      if (!this.tiles.has(targetKey)) {
        this.tiles.set(targetKey, {
          mapId: location.mapId,
          y: candidate.targetY,
          x: candidate.targetX,
          status: "frontier",
          visits: 0,
          firstSeenStep: step,
          lastSeenStep: step,
          blockId: candidate.blockId
        });
      }
    }
  }

  observeTransition(previous: PokemonStateSnapshot | undefined, actionLike: unknown, current: PokemonStateSnapshot, step?: number): void {
    this.observeCurrent(current, step);
    if (previous === undefined || !isMappableOverworld(previous) || !isMappableOverworld(current)) return;

    const direction = extractDirection(actionLike);
    const from = getLocation(previous);
    const to = getLocation(current);
    if (direction === undefined || from === undefined || to === undefined) return;

    const expected = expectedTarget(from.y, from.x, direction);
    const target = sameMap(from, to) && to.y === expected.y && to.x === expected.x
      ? to
      : { mapId: from.mapId, y: expected.y, x: expected.x };
    const edgeKey = `${tileKey(from.mapId, from.y, from.x)}:${direction}`;
    const edge = this.edges.get(edgeKey) ?? {
      from: tileKey(from.mapId, from.y, from.x),
      to: tileKey(target.mapId, target.y, target.x),
      direction,
      status: "blocked" as LearnedEdgeStatus,
      attempts: 0,
      successes: 0,
      failures: 0,
      blockId: candidateBlockId(previous, direction)
    };

    edge.attempts += 1;
    edge.lastStep = step;
    edge.blockId = edge.blockId ?? candidateBlockId(previous, direction);

    if (sameMap(from, to) && from.y === to.y && from.x === to.x) {
      edge.failures += 1;
      edge.status = "blocked";
      edge.to = tileKey(from.mapId, expected.y, expected.x);
      this.markFrontier(from.mapId, expected.y, expected.x, step, edge.blockId);
    } else if (sameMap(from, to) && to.y === expected.y && to.x === expected.x) {
      edge.successes += 1;
      edge.status = "walkable";
      edge.to = tileKey(to.mapId, to.y, to.x);
      this.markVisited(to.mapId, to.y, to.x, step, currentBlockId(current));
    } else {
      edge.successes += 1;
      edge.status = "transition";
      edge.to = tileKey(to.mapId, to.y, to.x);
      this.markVisited(to.mapId, to.y, to.x, step, currentBlockId(current));
      if (!sameMap(from, to)) {
        this.recordMapTransition(from, to, direction, step);
      }
    }

    this.edges.set(edgeKey, edge);
  }

  isBlocked(mapId: number, y: number, x: number, direction: PlayerFacingDirection): boolean {
    return this.edges.get(`${tileKey(mapId, y, x)}:${direction}`)?.status === "blocked";
  }

  candidateStatus(mapId: number, candidate: PokemonMapDirectionCandidate): LearnedTileStatus | undefined {
    return this.tiles.get(tileKey(mapId, candidate.targetY, candidate.targetX))?.status;
  }

  summarize(current?: PokemonStateSnapshot): MapKnowledgeSummary {
    const currentLocation = current === undefined ? undefined : getLocation(current);
    const currentKey = currentLocation === undefined ? this.currentKey : tileKey(currentLocation.mapId, currentLocation.y, currentLocation.x);
    const localEdges = currentKey === undefined ? [] : [...this.edges.values()].filter((edge) => edge.from === currentKey).map(freezeEdge);
    const localFrontierTiles = currentLocation === undefined ? [] : [...this.tiles.values()]
      .filter((tile) => tile.mapId === currentLocation.mapId && tile.status === "frontier" && manhattan(tile, currentLocation) === 1)
      .map((tile) => freezeTile(tile))
      .filter((tile): tile is LearnedMapTile => tile !== undefined);
    const recentBlockedEdges = [...this.edges.values()]
      .filter((edge) => edge.status === "blocked")
      .sort((left, right) => (right.lastStep ?? 0) - (left.lastStep ?? 0))
      .slice(0, 8)
      .map(freezeEdge);
    const recentMapTransitions = [...this.mapTransitions.values()]
      .sort((left, right) => (right.lastStep ?? 0) - (left.lastStep ?? 0))
      .slice(0, 8)
      .map((transition) => freezeMapTransition(transition, this.maps));
    const currentMap = currentLocation === undefined ? undefined : freezeMapFingerprint(this.maps.get(currentLocation.mapId));
    const knownMaps = [...this.maps.values()]
      .sort((left, right) => left.mapId - right.mapId)
      .map((map) => freezeMapFingerprint(map))
      .filter((map): map is LearnedMapFingerprint => map !== undefined);

    return {
      schema: "pokemon-map-knowledge.v1",
      current: currentLocation,
      totals: {
        knownMaps: this.maps.size,
        visitedTiles: [...this.tiles.values()].filter((tile) => tile.status === "visited").length,
        frontierTiles: [...this.tiles.values()].filter((tile) => tile.status === "frontier").length,
        walkableEdges: [...this.edges.values()].filter((edge) => edge.status === "walkable").length,
        blockedEdges: [...this.edges.values()].filter((edge) => edge.status === "blocked").length,
        transitionEdges: [...this.edges.values()].filter((edge) => edge.status === "transition").length,
        mapTransitions: this.mapTransitions.size
      },
      currentTile: currentKey === undefined ? undefined : freezeTile(this.tiles.get(currentKey)),
      localFrontierTiles,
      localEdges,
      recentBlockedEdges,
      currentMap,
      knownMaps,
      recentMapTransitions
    };
  }

  private markVisited(mapId: number, y: number, x: number, step?: number, blockId?: number): void {
    const key = tileKey(mapId, y, x);
    const tile = this.tiles.get(key) ?? { mapId, y, x, status: "visited" as LearnedTileStatus, visits: 0, firstSeenStep: step };
    tile.status = "visited";
    tile.visits += 1;
    tile.lastSeenStep = step;
    tile.blockId = blockId ?? tile.blockId;
    this.tiles.set(key, tile);
  }

  private observeMapFingerprint(state: PokemonStateSnapshot, step?: number): void {
    const mapId = state.wCurMap ?? (typeof state.mapId === "number" ? state.mapId : undefined);
    if (mapId === undefined) return;

    const existing = this.maps.get(mapId) ?? { mapId, visits: 0, firstSeenStep: step };
    existing.visits += 1;
    existing.lastSeenStep = step;
    existing.width = state.mapStructure?.width ?? existing.width;
    existing.height = state.mapStructure?.height ?? existing.height;
    existing.tileset = state.mapStructure?.tileset ?? existing.tileset;
    existing.visibleBlockHash = visibleBlockHash(state) ?? existing.visibleBlockHash;
    this.maps.set(mapId, existing);
  }

  private recordMapTransition(
    from: { mapId: number; y: number; x: number },
    to: { mapId: number; y: number; x: number },
    direction: PlayerFacingDirection,
    step?: number
  ): void {
    const key = `${tileKey(from.mapId, from.y, from.x)}:${direction}->${tileKey(to.mapId, to.y, to.x)}`;
    const transition = this.mapTransitions.get(key) ?? {
      fromMapId: from.mapId,
      toMapId: to.mapId,
      from: tileKey(from.mapId, from.y, from.x),
      to: tileKey(to.mapId, to.y, to.x),
      direction,
      attempts: 0
    };
    transition.attempts += 1;
    transition.lastStep = step;
    this.mapTransitions.set(key, transition);
  }

  private markFrontier(mapId: number, y: number, x: number, step?: number, blockId?: number): void {
    const key = tileKey(mapId, y, x);
    if (this.tiles.has(key)) return;
    this.tiles.set(key, { mapId, y, x, status: "frontier", visits: 0, firstSeenStep: step, lastSeenStep: step, blockId });
  }
}

export function mapKnowledgeFromRecent(input: {
  readonly state: PokemonStateSnapshot;
  readonly recentStates?: readonly RecentStateSnapshot[];
  readonly recentActions?: readonly unknown[];
  readonly step?: number;
}): MapKnowledgeTracker {
  const tracker = new MapKnowledgeTracker();
  const states = input.recentStates?.length ? input.recentStates : [input.state];
  states.forEach((state, index) => {
    const previous = index > 0 ? states[index - 1] : undefined;
    const action = index > 0 ? input.recentActions?.[index - 1] : undefined;
    tracker.observeTransition(previous, action, state, typeof state.step === "number" ? state.step : index + 1);
  });
  tracker.observeCurrent(input.state, input.step);
  return tracker;
}

function isMappableOverworld(state: PokemonStateSnapshot): boolean {
  const battle = state.wIsInBattle === true || (typeof state.wIsInBattle === "number" && state.wIsInBattle !== 0);
  const textBoxId = state.wTextBoxID ?? state.textBoxId ?? 0;
  const screenTextKind = typeof state.screenTextKind === "string" ? state.screenTextKind : "none";
  const screenText = typeof state.screenText === "string" ? state.screenText.trim() : "";
  return !battle && screenTextKind !== "oak_intro" && screenTextKind !== "default_name_menu" && screenTextKind !== "naming_screen" && screenText.length === 0 && textBoxId === 0;
}

function getLocation(state: PokemonStateSnapshot): { mapId: number; y: number; x: number } | undefined {
  const mapId = state.wCurMap ?? (typeof state.mapId === "number" ? state.mapId : undefined);
  const y = state.wYCoord ?? (typeof state.y === "number" ? state.y : undefined);
  const x = state.wXCoord ?? (typeof state.x === "number" ? state.x : undefined);
  return typeof mapId === "number" && typeof y === "number" && typeof x === "number" ? { mapId, y, x } : undefined;
}

function extractDirection(actionLike: unknown): PlayerFacingDirection | undefined {
  if (actionLike === undefined || actionLike === null || typeof actionLike !== "object") return undefined;
  const record = actionLike as Record<string, unknown>;
  const action = record.action !== null && typeof record.action === "object" ? record.action as Record<string, unknown> : record;
  return buttonToDirection(action.button as MgbaButton | undefined);
}

function buttonToDirection(button: MgbaButton | undefined): PlayerFacingDirection | undefined {
  if (button === "Up") return "up";
  if (button === "Right") return "right";
  if (button === "Down") return "down";
  if (button === "Left") return "left";
  return undefined;
}

function expectedTarget(y: number, x: number, direction: PlayerFacingDirection): { y: number; x: number } {
  if (direction === "up") return { y: y - 1, x };
  if (direction === "right") return { y, x: x + 1 };
  if (direction === "down") return { y: y + 1, x };
  return { y, x: x - 1 };
}

function manhattan(left: { y: number; x: number }, right: { y: number; x: number }): number {
  return Math.abs(left.y - right.y) + Math.abs(left.x - right.x);
}

function sameMap(left: { mapId: number }, right: { mapId: number }): boolean {
  return left.mapId === right.mapId;
}

function tileKey(mapId: number, y: number, x: number): string {
  return `${mapId}:${y}:${x}`;
}

function currentBlockId(state: PokemonStateSnapshot): number | undefined {
  return state.mapStructure?.currentBlockId;
}

function candidateBlockId(state: PokemonStateSnapshot, direction: PlayerFacingDirection): number | undefined {
  return state.mapStructure?.directionCandidates.find((candidate) => candidate.direction === direction)?.blockId;
}

function visibleBlockHash(state: PokemonStateSnapshot): string | undefined {
  const blocks = state.mapStructure?.visibleBlocks;
  return blocks === undefined ? undefined : blocks.map((row) => row.map((block) => block.toString(16).padStart(2, "0")).join("")).join("/");
}

function freezeMapFingerprint(map: MutableMapFingerprint | undefined): LearnedMapFingerprint | undefined {
  return map === undefined ? undefined : { ...map };
}

function freezeMapTransition(transition: MutableMapTransition, maps: ReadonlyMap<number, MutableMapFingerprint>): LearnedMapTransition {
  return {
    ...transition,
    fromFingerprint: freezeMapFingerprint(maps.get(transition.fromMapId)),
    toFingerprint: freezeMapFingerprint(maps.get(transition.toMapId))
  };
}

function freezeTile(tile: MutableTile | undefined): LearnedMapTile | undefined {
  return tile === undefined ? undefined : { ...tile };
}

function freezeEdge(edge: MutableEdge): LearnedMapEdge {
  return { ...edge };
}
