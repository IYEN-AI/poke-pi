import { describe, expect, it } from "vitest";
import { MapKnowledgeTracker, mapKnowledgeFromRecent } from "../../src/pokemon/MapKnowledge.js";
import type { PokemonStateSnapshot } from "../../src/ai/Policy.js";

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
});
