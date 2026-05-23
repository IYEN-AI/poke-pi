import { describe, expect, it } from "vitest";
import type { PokemonStateSnapshot } from "../../src/ai/Policy.js";
import { MapKnowledgeTracker, mapKnowledgeFromRecent } from "../../src/pokemon/MapKnowledge.js";
import type { VisibleMapObservation } from "../../src/pokemon/VisualMap.js";

const mapStructure = (mapId: number, y: number, x: number): PokemonStateSnapshot["mapStructure"] => ({
  mapId,
  width: 10,
  height: 9,
  stride: 12,
  tileset: mapId + 1,
  currentViewPointer: 0xc6e8,
  currentBlockRow: y,
  currentBlockCol: x,
  currentBlockId: 0x01,
  visibleBlocks: [[0x01, 0x02], [0x03, 0x04]],
  directionCandidates: [
    { direction: "up", targetY: y - 1, targetX: x, targetBlockRow: y - 1, targetBlockCol: x, blockId: 0x01, inBounds: true },
    { direction: "right", targetY: y, targetX: x + 1, targetBlockRow: y, targetBlockCol: x + 1, blockId: 0x02, inBounds: true },
    { direction: "down", targetY: y + 1, targetX: x, targetBlockRow: y + 1, targetBlockCol: x, blockId: 0x03, inBounds: true },
    { direction: "left", targetY: y, targetX: x - 1, targetBlockRow: y, targetBlockCol: x - 1, blockId: 0x04, inBounds: true }
  ]
});

function state(overrides: Partial<PokemonStateSnapshot> = {}): PokemonStateSnapshot {
  const mapId = overrides.wCurMap ?? 0;
  const y = overrides.wYCoord ?? 5;
  const x = overrides.wXCoord ?? 5;
  return {
    wCurMap: mapId,
    wYCoord: y,
    wXCoord: x,
    wIsInBattle: 0,
    wTextBoxID: 0,
    screenTextKind: "none",
    screenText: "",
    mapStructure: mapStructure(mapId, y, x),
    ...overrides
  };
}

describe("MapKnowledgeTracker", () => {
  it("learns blocked and walkable edges in all four movement directions", () => {
    const tracker = mapKnowledgeFromRecent({
      state: state({ wYCoord: 4, wXCoord: 6 }),
      recentStates: [
        { ...state({ wYCoord: 5, wXCoord: 5 }), step: 1 },
        { ...state({ wYCoord: 5, wXCoord: 5 }), step: 2 },
        { ...state({ wYCoord: 5, wXCoord: 6 }), step: 3 },
        { ...state({ wYCoord: 4, wXCoord: 6 }), step: 4 }
      ],
      recentActions: [
        { action: { type: "hold", button: "Up", frames: 18 } },
        { action: { type: "hold", button: "Right", frames: 18 } },
        { action: { type: "hold", button: "Up", frames: 18 } }
      ],
      step: 4
    });

    const summary = tracker.summarize(state({ wYCoord: 4, wXCoord: 6 }));

    expect(summary.totals.visitedTiles).toBeGreaterThanOrEqual(3);
    expect(summary.totals.blockedEdges).toBe(1);
    expect(summary.totals.walkableEdges).toBe(2);
    expect(summary.recentBlockedEdges[0]).toMatchObject({ from: "0:5:5", direction: "up", status: "blocked" });
  });

  it("records map transitions with source and target fingerprints instead of merging map identity", () => {
    const tracker = new MapKnowledgeTracker();
    tracker.observeTransition(undefined, undefined, state({ wCurMap: 0, wYCoord: 1, wXCoord: 10 }), 1);
    tracker.observeTransition(
      state({ wCurMap: 0, wYCoord: 1, wXCoord: 10 }),
      { action: { type: "hold", button: "Up", frames: 18 } },
      state({ wCurMap: 12, wYCoord: 33, wXCoord: 4 }),
      2
    );

    const summary = tracker.summarize(state({ wCurMap: 12, wYCoord: 33, wXCoord: 4 }));

    expect(summary.totals.knownMaps).toBe(2);
    expect(summary.totals.mapTransitions).toBe(1);
    expect(summary.recentMapTransitions[0]).toMatchObject({
      fromMapId: 0,
      toMapId: 12,
      from: "0:1:10",
      to: "12:33:4",
      direction: "up",
      attempts: 1
    });
    expect(summary.recentMapTransitions[0]?.fromFingerprint).toMatchObject({ mapId: 0, width: 10, height: 9 });
    expect(summary.recentMapTransitions[0]?.toFingerprint).toMatchObject({ mapId: 12, width: 10, height: 9 });
  });

  it("does not learn map geometry while battle or text context is active", () => {
    const tracker = new MapKnowledgeTracker();
    tracker.observeTransition(undefined, undefined, state({ wCurMap: 1, wYCoord: 1, wXCoord: 1, wIsInBattle: 1 }), 1);
    tracker.observeTransition(undefined, undefined, state({ wCurMap: 1, wYCoord: 1, wXCoord: 1, wTextBoxID: 1, screenText: "Hello" }), 2);

    const summary = tracker.summarize();

    expect(summary.totals.knownMaps).toBe(0);
    expect(summary.totals.visitedTiles).toBe(0);
    expect(summary.totals.mapTransitions).toBe(0);
  });

  it("projects visual screenshot tiles into local world knowledge and refines movement edges", () => {
    const tracker = new MapKnowledgeTracker();
    const before = state({ wCurMap: 12, wYCoord: 20, wXCoord: 10 });
    const after = state({ wCurMap: 12, wYCoord: 20, wXCoord: 11 });
    const visibleMap = visibleMapObservation([
      { screenRow: 4, screenCol: 5, kind: "path", fingerprint: "player" },
      { screenRow: 4, screenCol: 6, kind: "path", fingerprint: "east-path" },
      { screenRow: 3, screenCol: 5, kind: "obstacle", fingerprint: "north-wall" }
    ]);

    tracker.observeCurrent(before, 1);
    tracker.observeVisibleMap(before, visibleMap, 1);
    tracker.observeTransition(before, { action: { type: "hold", button: "Right", frames: 18 } }, after, 2);
    tracker.refineLastDirectionalOutcome(before, { action: { type: "hold", button: "Right", frames: 18 } }, after, visibleMap, 2);

    const summary = tracker.summarize(before);

    expect(summary.totals.visualTiles).toBeGreaterThanOrEqual(3);
    expect(summary.localVisualTiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ y: 20, x: 11, kind: "path", fingerprint: "east-path" }),
      expect.objectContaining({ y: 19, x: 10, kind: "obstacle", fingerprint: "north-wall" })
    ]));
    expect(summary.localEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({ direction: "right", status: "walkable", visualEvidence: "walk_step" })
    ]));
  });

  it("applies explicit world-knowledge updates from an external interface", () => {
    const tracker = new MapKnowledgeTracker();

    const result = tracker.applyWorldUpdate({
      schema: "pokemon-world-update.v1",
      source: "test-agent",
      entries: [
        { type: "map", mapId: 9, width: 20, height: 18, tileset: 2, semanticAlias: "route_1", step: 4 },
        { type: "tile", mapId: 9, y: 7, x: 11, status: "visited", visualKind: "path", visualConfidence: 0.9, visualFingerprint: "manual-path", step: 4 },
        { type: "edge", mapId: 9, y: 7, x: 11, direction: "up", status: "blocked", visualEvidence: "blocked", step: 5 },
        { type: "transition", fromMapId: 9, fromY: 7, fromX: 11, toMapId: 10, toY: 1, toX: 2, direction: "right", semanticAlias: "gate", step: 6 }
      ]
    });

    const summary = tracker.summarize(state({ wCurMap: 9, wYCoord: 7, wXCoord: 11 }));

    expect(result).toMatchObject({ schema: "pokemon-world-update-result.v1", applied: 4, ignored: 0 });
    expect(summary.currentMap).toMatchObject({ mapId: 9, width: 20, height: 18, semanticAlias: "route_1" });
    expect(summary.currentTile).toMatchObject({ status: "visited", visualKind: "path", visualFingerprint: "manual-path" });
    expect(summary.localEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({ direction: "up", status: "blocked", visualEvidence: "blocked" })
    ]));
    expect(summary.recentMapTransitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromMapId: 9, toMapId: 10, semanticAlias: "gate" })
    ]));
  });
});

function visibleMapObservation(tiles: Array<{ screenRow: number; screenCol: number; kind: VisibleMapObservation["tiles"][number]["kind"]; fingerprint: string }>): VisibleMapObservation {
  return {
    schema: "pokemon-visible-map.v1",
    screenshotPath: "/tmp/test.png",
    width: 160,
    height: 144,
    tileSize: 16,
    rows: 9,
    cols: 10,
    playerScreenTile: { row: 4, col: 5 },
    kindCounts: { path: 2, grass: 0, water: 0, obstacle: 1, interaction: 0, ui: 0, unknown: 0 },
    tiles: tiles.map((tile) => ({
      ...tile,
      confidence: 0.8,
      meanLuma: 180,
      darkRatio: tile.kind === "obstacle" ? 0.7 : 0.1,
      brightRatio: tile.kind === "path" ? 0.7 : 0.1,
      edgeScore: 20
    }))
  };
}
