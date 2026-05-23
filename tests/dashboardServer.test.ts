import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessConfig } from "../src/config.js";
import { startDashboard, type DashboardHandle } from "../src/dashboardServer.js";

const handles: DashboardHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

describe("dashboard server", () => {
  it("serves a redacted config and recent run evidence", async () => {
    const evidenceDir = await mkdtemp(path.join(tmpdir(), "poke-pi-dashboard-"));
    const runDir = path.join(evidenceDir, "run-one");
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "summary.json"), JSON.stringify({ runId: "run-one", status: "failed_timeout", counts: { states: 1, decisions: 1, actions: 1 } }), "utf8");
    await writeFile(path.join(runDir, "config.json"), JSON.stringify({ OPENAI_API_KEY: "secret-token" }), "utf8");
    await writeFile(path.join(runDir, "events.jsonl"), [
      JSON.stringify({ type: "state", sequence: 1, timestamp: "2026-05-23T00:00:00.000Z", payload: { state: { wCurMap: 0 } } }),
      JSON.stringify({ type: "decision", sequence: 1, timestamp: "2026-05-23T00:00:01.000Z", payload: { rationale: "go" } }),
      JSON.stringify({ type: "action", sequence: 1, timestamp: "2026-05-23T00:00:02.000Z", payload: { action: { type: "press", button: "A" } } }),
      JSON.stringify({ type: "pokemon_telemetry", timestamp: "2026-05-23T00:00:03.000Z", payload: { step: 1, frame: 2, route: "pallet_town", categories: ["progress"], location: { mapId: 0, y: 1, x: 10 }, decision: { action: { type: "press", button: "A" }, confidence: 0.8 }, progress: { newCheckpoints: ["initialObserved"] }, improvementSignals: ["checkpoint:initialObserved"] } })
    ].join("\n") + "\n", "utf8");

    const handle = await startDashboard({ config: config(evidenceDir), port: 0 });
    handles.push(handle);

    const configResponse = await fetch(`${handle.url}/api/config`);
    const runsResponse = await fetch(`${handle.url}/api/runs`);
    const runResponse = await fetch(`${handle.url}/api/runs/run-one`);

    expect(configResponse.status).toBe(200);
    expect(await configResponse.json()).toMatchObject({ aiProvider: "openai", openaiModel: "gpt-5.5" });
    expect(await runsResponse.json()).toMatchObject([{ runId: "run-one", status: "failed_timeout" }]);
    const runText = await runResponse.text();
    expect(runText).toContain("decision");
    expect(runText).toContain("action");
    expect(runText).toContain("improvementLog");
    expect(runText).toContain("pallet_town");
    expect(runText).not.toContain("secret-token");
  });

  it("exposes HTTP control endpoints that start, report, and stop harness runs", async () => {
    const evidenceDir = await mkdtemp(path.join(tmpdir(), "poke-pi-dashboard-control-"));
    const spawned: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv; child: EventEmitter & { pid: number; kill: (signal?: string) => boolean } }> = [];
    const handle = await startDashboard({
      config: config(evidenceDir),
      port: 0,
      spawnHarness(args, env) {
        const child = Object.assign(new EventEmitter(), {
          pid: 1234 + spawned.length,
          kill(signal?: string) {
            child.emit("exit", null, signal ?? "SIGTERM");
            return true;
          }
        });
        spawned.push({ args, env, child });
        return child as never;
      }
    });
    handles.push(handle);

    const startResponse = await fetch(`${handle.url}/api/control/play`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxSteps: 7, runId: "http-map" })
    });
    const busyResponse = await fetch(`${handle.url}/api/control/llm`, { method: "POST" });
    const statusResponse = await fetch(`${handle.url}/api/control/status`);
    const stopResponse = await fetch(`${handle.url}/api/control/stop`, { method: "POST" });

    expect(startResponse.status).toBe(202);
    expect(busyResponse.status).toBe(409);
    expect(await statusResponse.json()).toMatchObject({ running: true, activeRun: { kind: "play", runId: "http-map", pid: 1234 } });
    expect(await stopResponse.json()).toMatchObject({ stopped: true, run: { runId: "http-map" } });
    expect(spawned[0]?.args).toEqual([
      "src/index.ts",
      "run",
      "--policy",
      "heuristic",
      "--mode",
      "stage1",
      "--run-id",
      "http-map",
      "--max-steps",
      "7"
    ]);
    expect(spawned[0]?.env.AI_PROVIDER).toBe("heuristic");
  });

  it("renders dashboard controls for HTTP run management and map telemetry", async () => {
    const evidenceDir = await mkdtemp(path.join(tmpdir(), "poke-pi-dashboard-ui-"));
    const handle = await startDashboard({ config: config(evidenceDir), port: 0 });
    handles.push(handle);

    const response = await fetch(`${handle.url}/`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Control server");
    expect(html).toContain("Play heuristic");
    expect(html).toContain("LLM run");
    expect(html).toContain("/api/control/status");
    expect(html).toContain("controlStart('play')");
    expect(html).toContain("/api/control/press");
    expect(html).toContain("Map structure");
    expect(html).toContain("directionCandidates");
  });

});

function config(evidenceDir: string): HarnessConfig {
  return {
    mgbaHttpBaseUrl: "http://127.0.0.1:5000",
    pokemonVersion: "red",
    evidenceDir,
    harnessRunId: "dashboard-test",
    harnessMode: "stage1",
    logLevel: "info",
    loopMaxSteps: 100,
    loopStepDelayMs: 0,
    maxLlmCalls: 10,
    llmTimeoutMs: 1000,
    llmMaxRetries: 0,
    defaultTapFrames: 5,
    defaultHoldFrames: 15,
    aiProvider: "openai",
    openaiBaseUrl: "https://router.example.invalid/v1",
    openaiApiKey: "secret-token",
    openaiModel: "gpt-5.5",
    openaiTemperature: 0.2
  };
}
