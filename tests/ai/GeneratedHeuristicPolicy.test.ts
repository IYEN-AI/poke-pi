import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GeneratedHeuristicPolicy } from "../../src/ai/generatedPolicy/GeneratedHeuristicPolicy.js";
import { synthesizeGeneratedPolicy } from "../../src/ai/generatedPolicy/PolicySynthesis.js";
import type { GeneratedPolicyDefinition } from "../../src/ai/generatedPolicy/GeneratedPolicyTypes.js";
import type { PokemonStateSnapshot } from "../../src/ai/Policy.js";

const generatedPolicy: GeneratedPolicyDefinition = {
  schema: "pokemon-generated-policy.v1",
  id: "unit-generated",
  createdAt: "2026-05-23T00:00:00.000Z",
  objective: "unit test generated policy",
  base: "map-heuristic",
  tuning: {
    avoidRecentDirections: true,
    preferDifferentBlock: true,
    interactionCandidatePatience: 2,
    fallbackToBaseHeuristic: true
  },
  rules: [
    {
      id: "candidate-interact",
      description: "Interact with a facing candidate after repeated movement.",
      when: { sameCoordRepeatsGte: 2, facingInteractionCandidate: true, textActive: false },
      action: { type: "press", button: "A", frames: 5 },
      confidence: 0.7
    },
    {
      id: "map-explore",
      description: "Use map candidates for generated exploration.",
      when: { sameCoordRepeatsGte: 1, textActive: false },
      preferMapDirection: true,
      confidence: 0.62
    }
  ],
  notes: []
};

const baseState: PokemonStateSnapshot = {
  wIsInBattle: 0,
  wPartyCount: 1,
  wCurMap: 1,
  wYCoord: 5,
  wXCoord: 6,
  wTextBoxID: 0,
  playerFacingDirection: "right",
  mapStructure: {
    mapId: 1,
    width: 4,
    height: 4,
    stride: 4,
    tileset: 0,
    currentViewPointer: 0xc580,
    currentBlockRow: 1,
    currentBlockCol: 1,
    currentBlockId: 1,
    visibleBlocks: [],
    directionCandidates: [
      { direction: "up", targetY: 4, targetX: 6, targetBlockRow: 0, targetBlockCol: 1, inBounds: true, blockId: 1 },
      { direction: "right", targetY: 5, targetX: 7, targetBlockRow: 1, targetBlockCol: 2, inBounds: true, blockId: 9 },
      { direction: "down", targetY: 6, targetX: 6, targetBlockRow: 2, targetBlockCol: 1, inBounds: true, blockId: 1 },
      { direction: "left", targetY: 5, targetX: 5, targetBlockRow: 1, targetBlockCol: 0, inBounds: true, blockId: 1 }
    ]
  }
};

describe("GeneratedHeuristicPolicy", () => {
  it("executes validated JSON rules before falling back to base heuristic", async () => {
    const policy = new GeneratedHeuristicPolicy(generatedPolicy);
    const decision = await policy.chooseAction({
      state: baseState,
      recentStates: [baseState, baseState]
    });

    expect(decision.action).toEqual({ type: "press", button: "A", frames: 5 });
    expect(decision.rationale).toContain("unit-generated");
    expect(decision.observedStateCitations[0]).toContain("rule=candidate-interact");
  });

  it("chooses map direction candidates from generated preferMapDirection rules", async () => {
    const policy = new GeneratedHeuristicPolicy(generatedPolicy);
    const decision = await policy.chooseAction({
      state: { ...baseState, playerFacingDirection: "left" },
      recentStates: [baseState],
      recentActions: [{ action: { type: "hold", button: "Up", frames: 18 } }]
    });

    expect(decision.action).toEqual({ type: "hold", button: "Right", frames: 18 });
    expect(decision.rationale).toContain("map-explore");
  });

  it("loads policy files and synthesizes policy artifacts from scout telemetry", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "poke-generated-policy-"));
    const runDir = path.join(dir, "scout-one");
    await writeFile(path.join(dir, "placeholder"), "", "utf8");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(runDir, { recursive: true }));
    await writeFile(path.join(runDir, "events.jsonl"), [
      JSON.stringify({ type: "pokemon_telemetry", payload: { route: "pallet_town", improvementSignals: ["repeated_state_tail"] } }),
      JSON.stringify({ type: "pokemon_telemetry", payload: { route: "pallet_town", improvementSignals: [] } })
    ].join("\n") + "\n", "utf8");

    const outputFile = path.join(dir, "policy.json");
    const result = await synthesizeGeneratedPolicy({ evidenceDir: dir, fromRun: "scout-one", policyId: "pallet-v1", outputFile, now: () => new Date("2026-05-23T00:00:00.000Z") });
    const loaded = await GeneratedHeuristicPolicy.fromFile(outputFile);
    const saved = JSON.parse(await readFile(outputFile, "utf8")) as GeneratedPolicyDefinition;

    expect(result.telemetryEvents).toBe(2);
    expect(saved.id).toBe("pallet-v1");
    expect(saved.rules.some((rule) => rule.id === "explore-pallet_town")).toBe(true);
    expect(loaded.getDefinition().sourceRunId).toBe("scout-one");
  });
});
