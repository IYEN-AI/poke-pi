import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildMovementFeedback, readLatestMovementFeedback, runMovementMonitor } from "../src/agent/MovementMonitor.js";

describe("movement monitor", () => {
  it("summarizes post-action movement experience into feedback artifacts", async () => {
    const evidenceDir = await mkdtemp(path.join(os.tmpdir(), "poke-movement-"));
    const runId = "run-one";
    await writeEvents(evidenceDir, runId, [
      postAction(1, "Up", "no_change"),
      postAction(2, "Up", "no_change"),
      postAction(3, "Up", "no_change"),
      postAction(4, "Right", "blocked_with_visual_change")
    ]);

    const feedback = await buildMovementFeedback(evidenceDir, runId, () => new Date("2026-05-23T00:00:00.000Z"));

    expect(feedback).toMatchObject({
      schema: "pokemon-movement-feedback.v1",
      runId,
      updatedAt: "2026-05-23T00:00:00.000Z",
      counts: { no_change: 3, blocked_with_visual_change: 1 },
      movementQuality: "blocked",
      recommendation: "avoid_repeating_last_direction_and_request_visual_reroute"
    });
    expect(feedback?.recentExperiences.at(-1)).toMatchObject({ step: 4, kind: "blocked_with_visual_change" });
  });

  it("detects two-tile walk-step ping-pong as oscillation instead of progress", async () => {
    const evidenceDir = await mkdtemp(path.join(os.tmpdir(), "poke-movement-"));
    const runId = "oscillating-run";
    await writeEvents(evidenceDir, runId, [
      postAction(1, "Right", "walk_step", { x: 10, y: 24 }, { x: 11, y: 24 }),
      postAction(2, "Left", "walk_step", { x: 11, y: 24 }, { x: 10, y: 24 }),
      postAction(3, "Right", "walk_step", { x: 10, y: 24 }, { x: 11, y: 24 }),
      postAction(4, "Left", "walk_step", { x: 11, y: 24 }, { x: 10, y: 24 }),
      postAction(5, "Right", "walk_step", { x: 10, y: 24 }, { x: 11, y: 24 }),
      postAction(6, "Left", "walk_step", { x: 11, y: 24 }, { x: 10, y: 24 })
    ]);

    const feedback = await buildMovementFeedback(evidenceDir, runId);

    expect(feedback).toMatchObject({
      counts: { walk_step: 6 },
      movementQuality: "oscillating",
      recommendation: "avoid_two_tile_ping_pong_and_request_visual_route_with_forward_progress"
    });
  });

  it("polls the control server status and writes latest feedback for the active run", async () => {
    const evidenceDir = await mkdtemp(path.join(os.tmpdir(), "poke-movement-"));
    const runId = "active-run";
    await writeEvents(evidenceDir, runId, [postAction(1, "Down", "walk_step")]);
    const logs: unknown[] = [];

    const feedback = await runMovementMonitor({
      evidenceDir,
      baseUrl: "http://127.0.0.1:3030",
      iterations: 1,
      pollMs: 1,
      request: async () => ({ status: 200, body: { running: true, activeRun: { runId } } }),
      log: (event) => logs.push(event)
    });

    expect(feedback).toMatchObject({ runId, counts: { walk_step: 1 }, movementQuality: "moving" });
    expect(logs).toHaveLength(1);
    expect(await readLatestMovementFeedback(evidenceDir)).toMatchObject({ runId, movementQuality: "moving" });
    const latestText = await readFile(path.join(evidenceDir, ".movement-feedback", "latest.json"), "utf8");
    expect(latestText).toContain("pokemon-movement-feedback.v1");
  });
});

async function writeEvents(evidenceDir: string, runId: string, events: readonly unknown[]): Promise<void> {
  const runDir = path.join(evidenceDir, runId);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(runDir, { recursive: true }));
  await writeFile(path.join(runDir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
}

function postAction(
  step: number,
  button: string,
  kind: string,
  beforePosition: { readonly x: number; readonly y: number } = { x: 4, y: 5 },
  afterPosition: { readonly x: number; readonly y: number } = { x: 4, y: kind === "walk_step" ? 6 : 5 }
): unknown {
  return {
    type: "pokemon_telemetry",
    payload: {
      schema: "pokemon-post-action-observation.v1",
      step,
      action: { type: "press", button, frames: 8 },
      before: { mapId: 1, x: beforePosition.x, y: beforePosition.y },
      after: { mapId: 1, x: afterPosition.x, y: afterPosition.y },
      change: { kind, delta: { dx: afterPosition.x - beforePosition.x, dy: afterPosition.y - beforePosition.y }, pixelChanged: kind !== "no_change" }
    }
  };
}
