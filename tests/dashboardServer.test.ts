import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessConfig } from "../src/config.js";
import { type DashboardHandle, startDashboard } from "../src/dashboardServer.js";

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
    await writeFile(path.join(runDir, "events.jsonl"), `${[
      JSON.stringify({ type: "state", sequence: 1, timestamp: "2026-05-23T00:00:00.000Z", payload: { state: { wCurMap: 0 } } }),
      JSON.stringify({ type: "decision", sequence: 1, timestamp: "2026-05-23T00:00:01.000Z", payload: { rationale: "go" } }),
      JSON.stringify({ type: "action", sequence: 1, timestamp: "2026-05-23T00:00:02.000Z", payload: { action: { type: "press", button: "A" } } }),
      JSON.stringify({ type: "pokemon_telemetry", timestamp: "2026-05-23T00:00:03.000Z", payload: { step: 1, frame: 2, route: "pallet_town", categories: ["progress"], location: { mapId: 0, y: 1, x: 10 }, decision: { action: { type: "press", button: "A" }, confidence: 0.8 }, progress: { newCheckpoints: ["initialObserved"] }, improvementSignals: ["checkpoint:initialObserved"] } })
    ].join("\n")}\n`, "utf8");

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


  it("reports active run evidence through the same control status used by the dashboard", async () => {
    const evidenceDir = await mkdtemp(path.join(tmpdir(), "poke-pi-dashboard-control-evidence-"));
    const runDir = path.join(evidenceDir, "active-one");
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "summary.json"), JSON.stringify({ runId: "active-one", status: "running", counts: { states: 2, decisions: 2, actions: 1 } }), "utf8");
    await writeFile(path.join(runDir, "events.jsonl"), `${[
      JSON.stringify({ type: "decision", sequence: 1, payload: { decision: { action: { type: "hold", button: "Right", frames: 12 } } } }),
      JSON.stringify({ type: "action", sequence: 1, payload: { action: { type: "hold", button: "Right", frames: 12 } } }),
      JSON.stringify({ type: "pokemon_telemetry", payload: { step: 2, frame: 44, location: { mapId: 43, y: 6, x: 4 } } })
    ].join(`\n`)}\n`, "utf8");
    const handle = await startDashboard({
      config: config(evidenceDir),
      port: 0,
      spawnHarness() {
        return Object.assign(new EventEmitter(), { pid: 5678, kill: () => true }) as never;
      }
    });
    handles.push(handle);

    await fetch(`${handle.url}/api/control/play`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "active-one" })
    });
    const statusResponse = await fetch(`${handle.url}/api/control/status`);
    const htmlResponse = await fetch(`${handle.url}/`);

    expect(await statusResponse.json()).toMatchObject({
      schema: "pokemon-control-status.v1",
      running: true,
      activeRun: {
        kind: "play",
        runId: "active-one",
        pid: 5678,
        summaryStatus: "running",
        counts: { states: 2, decisions: 2, actions: 1 },
        lastAction: { action: { type: "hold", button: "Right", frames: 12 } },
        latestTelemetry: { step: 2, frame: 44 }
      }
    });
    const html = await htmlResponse.text();
    expect(html).toContain("latestTelemetry");
    expect(html).toContain("summaryStatus");
  });

  it("exposes Hermes-style agent endpoints for generated policy orchestration", async () => {
    const evidenceDir = await mkdtemp(path.join(tmpdir(), "poke-pi-dashboard-agent-"));
    const runDir = path.join(evidenceDir, "scout-one");
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "summary.json"), JSON.stringify({ runId: "scout-one", status: "failed_timeout", counts: { decisions: 2 } }), "utf8");
    await writeFile(path.join(runDir, "events.jsonl"), `${[
      JSON.stringify({ type: "decision", payload: { decision: { confidence: 0.5 } } }),
      JSON.stringify({ type: "pokemon_telemetry", payload: { route: "pallet_town", improvementSignals: ["repeated_state_tail"] } })
    ].join("\n")}\n`, "utf8");
    const spawned: Array<{ args: readonly string[] }> = [];
    const handle = await startDashboard({
      config: config(evidenceDir),
      port: 0,
      spawnHarness(args) {
        const child = Object.assign(new EventEmitter(), {
          pid: 4321,
          kill(signal?: string) {
            child.emit("exit", null, signal ?? "SIGTERM");
            return true;
          }
        });
        spawned.push({ args });
        return child as never;
      }
    });
    handles.push(handle);

    const synthesizeResponse = await fetch(`${handle.url}/api/agent/synthesize-policy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fromRun: "scout-one", policyId: "pallet-web", policyFile: path.join(evidenceDir, "pallet-web.json") })
    });
    const runResponse = await fetch(`${handle.url}/api/agent/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ policy: "generated", policyFile: path.join(evidenceDir, "pallet-web.json"), runId: "generated-one", maxSteps: 9 })
    });
    await mkdir(path.join(evidenceDir, ".movement-feedback"), { recursive: true });
    await writeFile(path.join(evidenceDir, ".movement-feedback", "latest.json"), JSON.stringify({ schema: "pokemon-movement-feedback.v1", runId: "scout-one", movementQuality: "blocked", recommendation: "avoid_repeating_last_direction_and_request_visual_reroute", counts: { no_change: 3 }, recentExperiences: [] }), "utf8");
    const evaluateResponse = await fetch(`${handle.url}/api/agent/evaluate/scout-one`);
    const movementFeedbackResponse = await fetch(`${handle.url}/api/agent/movement-feedback`);

    expect(synthesizeResponse.status).toBe(200);
    expect(await synthesizeResponse.json()).toMatchObject({ policy: { id: "pallet-web" } });
    expect(runResponse.status).toBe(202);
    expect(spawned[0]?.args).toContain("--policy-file");
    expect(spawned[0]?.args).toContain(path.join(evidenceDir, "pallet-web.json"));
    expect(await evaluateResponse.json()).toMatchObject({ schema: "pokemon-agent-run-evaluation.v1", recommendation: "synthesize_or_tune_policy_to_avoid_loops" });
    expect(await movementFeedbackResponse.json()).toMatchObject({ schema: "pokemon-movement-feedback.v1", runId: "scout-one", movementQuality: "blocked" });
  });

  it("accepts redacted world-understanding updates from agent clients", async () => {
    const evidenceDir = await mkdtemp(path.join(tmpdir(), "poke-pi-dashboard-world-update-"));
    const handle = await startDashboard({ config: config(evidenceDir), port: 0 });
    handles.push(handle);

    const response = await fetch(`${handle.url}/api/agent/world-update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema: "pokemon-world-update.v1",
        source: "test-agent",
        note: "api_key=leaked-token",
        entries: [
          { type: "tile", mapId: 1, y: 2, x: 3, status: "visited", visualKind: "path", visualConfidence: 0.7 }
        ]
      })
    });

    const body = await response.json();
    const events = await readFile(path.join(evidenceDir, ".world-updates", "events.jsonl"), "utf8");

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ schema: "pokemon-world-update-ack.v1", accepted: true });
    expect(events).toContain("world_update");
    expect(events).toContain("pokemon-world-update.v1");
    expect(events).not.toContain("leaked-token");
  });

  it("rejects malformed world-understanding updates", async () => {
    const evidenceDir = await mkdtemp(path.join(tmpdir(), "poke-pi-dashboard-bad-world-update-"));
    const handle = await startDashboard({ config: config(evidenceDir), port: 0 });
    handles.push(handle);

    const response = await fetch(`${handle.url}/api/agent/world-update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schema: "pokemon-world-update.v1", entries: [{ type: "edge", direction: "north" }] })
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_world_update", schema: "pokemon-world-update.v1" });
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
    expect(html).not.toContain("Manual input");
    expect(html).not.toContain("controlPress");
    expect(html).toContain("Agent orchestration");
    expect(html).toContain("/api/agent/observation");
    expect(html).toContain("/api/agent/movement-feedback");
    expect(html).toContain("Movement monitor feedback");
    expect(html).toContain("Map structure");
    expect(html).toContain("directionCandidates");
  });

  it("waits out battle-entry HP box animation before serving a live screen", async () => {
    const evidenceDir = await mkdtemp(path.join(tmpdir(), "poke-pi-dashboard-battle-screen-"));
    const requests: string[] = [];
    const onePixelPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGOSHzRgQAAAABJRU5ErkJggg==",
      "base64"
    );
    const mgba = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? "/", "http://mgba.local");
        requests.push(url.pathname);
        if (url.pathname === "/core/read8") {
          response.end("1");
          return;
        }
        if (url.pathname === "/core/screenshot") {
          const screenshotPath = url.searchParams.get("path");
          if (screenshotPath !== null) {
            await writeFile(screenshotPath, onePixelPng);
          }
          response.end("ok");
          return;
        }
        response.statusCode = 404;
        response.end("missing");
      })();
    });
    await new Promise<void>((resolve, reject) => {
      mgba.once("error", reject);
      mgba.listen(0, "127.0.0.1", () => {
        mgba.off("error", reject);
        resolve();
      });
    });

    try {
      const address = mgba.address() as AddressInfo;
      const handle = await startDashboard({
        config: { ...config(evidenceDir), mgbaHttpBaseUrl: `http://127.0.0.1:${address.port}` },
        port: 0,
        battleVisualSettleMs: 25
      });
      handles.push(handle);

      const startedAt = Date.now();
      const response = await fetch(`${handle.url}/api/screen`);
      await response.arrayBuffer();

      expect(response.status).toBe(200);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20);
      expect(requests).toEqual(["/core/read8", "/core/screenshot"]);
    } finally {
      await new Promise<void>((resolve, reject) => mgba.close((error) => error ? reject(error) : resolve()));
    }
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
