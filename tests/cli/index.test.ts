import { describe, expect, it } from "vitest";
import type { HarnessConfig } from "../../src/config.js";
import { getHarnessHelp, parseCliArgs, runCli } from "../../src/index.js";
import type { MgbaPreflightReport } from "../../src/mgba/preflight.js";

describe("CLI", () => {
  it("prints command help", async () => {
    const io = createIo();

    const exitCode = await runCli(["--help"], io);

    expect(exitCode).toBe(0);
    expect(io.out.join("\n")).toContain("snapshot");
    expect(io.out.join("\n")).toContain("preflight");
    expect(io.out.join("\n")).toContain("run");
    expect(io.out.join("\n")).toContain("press");
    expect(io.out.join("\n")).toContain("dashboard");
    expect(io.out.join("\n")).toContain("map-heuristic");
    expect(io.out.join("\n")).toContain("play");
    expect(io.out.join("\n")).toContain("status");
    expect(io.out.join("\n")).toContain("clean-failed");
    expect(io.out.join("\n")).toContain("synthesize-policy");
    expect(io.out.join("\n")).toContain("play-policy");
    expect(io.out.join("\n")).toContain("strategy-loop");
    expect(io.out.join("\n")).toContain("heuristic|openai");
    expect(io.out.join("\n")).toContain("stage1|full-game");
  });

  it("parses commands and common options without a CLI framework", () => {
    const parsed = parseCliArgs(["run", "--policy", "openai", "--mode", "full-game", "--max-steps", "9", "--run-id", "manual"]);
    const dashboard = parseCliArgs(["dashboard", "--port", "4040"]);
    const mapHeuristic = parseCliArgs(["map-heuristic", "--max-steps", "12", "--run-id", "map-cli", "--with-dashboard", "--port", "3031"]);
    const play = parseCliArgs(["play", "--max-steps", "5", "--run-id", "easy", "--port", "3032"]);
    const synthesize = parseCliArgs(["synthesize-policy", "--from-run", "scout-1", "--policy-id", "pallet-v1", "--objective", "find starter"]);
    const playPolicy = parseCliArgs(["play-policy", "--policy-file", "policies/generated/pallet-v1.json", "--max-steps", "11"]);
    const strategyLoop = parseCliArgs(["strategy-loop", "--iterations", "3", "--poll-ms", "10", "--llm-every", "2", "--run-id-prefix", "unit"]);
    const cleanFailed = parseCliArgs(["clean-failed", "--yes"]);

    expect(parsed.errors).toEqual([]);
    expect(parsed.options).toMatchObject({ command: "run", policy: "openai", mode: "full-game", maxSteps: 9, runId: "manual" });
    expect(dashboard.errors).toEqual([]);
    expect(dashboard.options).toMatchObject({ command: "dashboard", dashboardPort: 4040 });
    expect(mapHeuristic.errors).toEqual([]);
    expect(mapHeuristic.options).toMatchObject({ command: "map-heuristic", maxSteps: 12, runId: "map-cli", withDashboard: true, dashboardPort: 3031 });
    expect(play.errors).toEqual([]);
    expect(play.options).toMatchObject({ command: "play", maxSteps: 5, runId: "easy", dashboardPort: 3032 });
    expect(synthesize.errors).toEqual([]);
    expect(synthesize.options).toMatchObject({ command: "synthesize-policy", fromRun: "scout-1", policyId: "pallet-v1", objective: "find starter" });
    expect(playPolicy.errors).toEqual([]);
    expect(playPolicy.options).toMatchObject({ command: "play-policy", policyFile: "policies/generated/pallet-v1.json", maxSteps: 11 });
    expect(strategyLoop.errors).toEqual([]);
    expect(strategyLoop.options).toMatchObject({ command: "strategy-loop", iterations: 3, pollMs: 10, llmEvery: 2, runIdPrefix: "unit" });
    expect(cleanFailed.errors).toEqual([]);
    expect(cleanFailed.options).toMatchObject({ command: "clean-failed", yes: true });
  });

  it("rejects unsupported policy names", () => {
    const parsed = parseCliArgs(["run", "--policy", "codexlb"]);

    expect(parsed.errors).toEqual(["--policy must be heuristic or openai"]);
    expect(parsed.options.policy).toBeUndefined();
  });

  it("rejects unsupported mode names", () => {
    const parsed = parseCliArgs(["run", "--mode", "credits"]);

    expect(parsed.errors).toEqual(["--mode must be stage1 or full-game"]);
    expect(parsed.options.mode).toBeUndefined();
  });

  it("runs snapshot dry-run without constructing live dependencies or requiring an API key", async () => {
    const io = createIo();
    let runnerConstructed = false;

    const exitCode = await withEnv({ AI_PROVIDER: "openai", HARNESS_MODE: undefined, OPENAI_API_KEY: undefined }, () => runCli(["snapshot", "--dry-run"], io, {
      createRunner() {
        runnerConstructed = true;
        throw new Error("runner should not be constructed");
      }
    }));

    const output = io.out.join("\n");
    expect(exitCode).toBe(0);
    expect(runnerConstructed).toBe(false);
    expect(output).toContain("Snapshot dry run succeeded");
    expect(output).toContain('"harnessMode": "stage1"');
    expect(output).toContain('"aiProvider": "heuristic"');
    expect(output).not.toContain("hasOpenaiApiKey");
    expect(output).not.toContain("sk-");
  });

  it("passes CLI mode override into loaded config and dry-run summary", async () => {
    const io = createIo();

    const exitCode = await runCli(["snapshot", "--dry-run", "--mode", "full-game"], io);

    expect(exitCode).toBe(0);
    expect(io.out.join("\n")).toContain('"harnessMode": "full-game"');
  });

  it("prints a secret-safe OpenAI-compatible dry-run summary for custom base URLs", async () => {
    const io = createIo();

    const exitCode = await withEnv({
      AI_PROVIDER: "openai",
      OPENAI_API_KEY: "provider-key-must-not-appear",
      OPENAI_BASE_URL: "https://codex.example.invalid/v1",
      OPENAI_MODEL: "codex-compatible-model"
    }, () => runCli(["snapshot", "--dry-run"], io));

    const output = io.out.join("\n");
    expect(exitCode).toBe(0);
    expect(output).toContain('"aiProvider": "openai"');
    expect(output).toContain('"hasOpenaiApiKey": true');
    expect(output).toContain('"openaiBaseUrl": "https://codex.example.invalid/v1"');
    expect(output).toContain('"openaiModel": "codex-compatible-model"');
    expect(output).not.toContain("provider-key-must-not-appear");
  });

  it("formats preflight failures as guidance without stack noise", async () => {
    const io = createIo();
    const exitCode = await runCli(["preflight"], io, {
      async runPreflight(): Promise<MgbaPreflightReport> {
        return {
          ok: false,
          checks: [
            {
              name: "current_frame",
              status: "fail",
              message: "mGBA-http request could not be completed",
              guidance: "Start mGBA manually with mGBA-http enabled and verify MGBA_HTTP_BASE_URL points to it.",
              errorCode: "MGBA_UNAVAILABLE"
            }
          ]
        };
      }
    });

    const output = io.out.join("\n");
    expect(exitCode).toBe(1);
    expect(output).toContain("mGBA preflight failed");
    expect(output).toContain("Start mGBA manually");
    expect(output).not.toContain("Error:");
    expect(output).not.toContain("    at ");
  });

  it("constructs run dependencies through the runner factory", async () => {
    const io = createIo();
    const seen: Array<{ config: HarnessConfig; maxSteps?: number }> = [];
    const exitCode = await withEnv({ OPENAI_API_KEY: "unit-test-key" }, () => runCli(["run", "--policy", "openai", "--mode", "full-game", "--max-steps", "2", "--run-id", "cli-test"], io, {
      createRunner(config, options) {
        seen.push({ config, maxSteps: options.maxSteps });
        return {
          async snapshot() {
            throw new Error("snapshot should not run");
          },
          async run() {
            return {
              runId: config.harnessRunId,
              status: "completed",
              startedAt: "2026-05-22T00:00:00.000Z",
              completedAt: "2026-05-22T00:00:01.000Z",
              totalSteps: options.maxSteps ?? 0,
              checkpoints: { initialObserved: true, starterAcquired: true, rivalBattleEntered: true, rivalBattleExited: true, completed: true },
              detector: {},
              last20Actions: [],
              recentStateHashes: []
            };
          }
        };
      }
    }));

    expect(exitCode).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.config.aiProvider).toBe("openai");
    expect(seen[0]?.config.harnessMode).toBe("full-game");
    expect(seen[0]?.config.harnessRunId).toBe("cli-test");
    expect(seen[0]?.maxSteps).toBe(2);
    expect(io.out.join("\n")).toContain("completed");
  });





  it("runs status as redacted config plus preflight", async () => {
    const io = createIo();
    const exitCode = await runCli(["status"], io, {
      loadConfig(env) {
        return createTestConfig({ aiProvider: env.AI_PROVIDER === "openai" ? "openai" : "heuristic" });
      },
      async runPreflight() {
        return { ok: true, checks: [{ name: "current_frame", status: "pass", message: "ok" }] };
      }
    });

    expect(exitCode).toBe(0);
    expect(io.out.join("\n")).toContain('"mgbaHttpBaseUrl"');
    expect(io.out.join("\n")).toContain("mGBA preflight passed");
  });

  it("runs play by POSTing to the HTTP control server", async () => {
    const io = createIo();
    const requests: Array<{ baseUrl: string; path: string; body: unknown }> = [];

    const exitCode = await runCli(["play", "--max-steps", "3", "--run-id", "easy-play", "--port", "3033"], io, {
      async controlRequest(baseUrl, path, body) {
        requests.push({ baseUrl, path, body });
        if (path === "/api/control/status") {
          return { status: 200, body: { running: false } };
        }
        return { status: 202, body: { started: true, activeRun: { kind: "play", runId: "easy-play" } } };
      }
    });

    expect(exitCode).toBe(0);
    expect(requests).toEqual([
      { baseUrl: "http://127.0.0.1:3033", path: "/api/control/status", body: undefined },
      { baseUrl: "http://127.0.0.1:3033", path: "/api/control/play", body: { maxSteps: 3, runId: "easy-play", mode: "stage1" } }
    ]);
    expect(io.out.join("\n")).toContain('"command": "play"');
  });

  it("runs llm by POSTing to the HTTP control server", async () => {
    const io = createIo();
    const requests: Array<{ path: string; body: unknown }> = [];

    const exitCode = await withEnv({ OPENAI_API_KEY: "unit-test-key" }, () => runCli(["llm", "--max-steps", "2", "--run-id", "llm-easy", "--policy-file", "policies/generated/pallet-v1.json"], io, {
      async controlRequest(_baseUrl, path, body) {
        requests.push({ path, body });
        if (path === "/api/control/status") {
          return { status: 200, body: { running: false } };
        }
        return { status: 202, body: { started: true, activeRun: { kind: "llm", runId: "llm-easy" } } };
      }
    }));

    expect(exitCode).toBe(0);
    expect(requests).toEqual([
      { path: "/api/control/status", body: undefined },
      { path: "/api/control/llm", body: { maxSteps: 2, runId: "llm-easy", mode: "stage1", policyFile: "policies/generated/pallet-v1.json" } }
    ]);
  });

  it("requires confirmation before deleting failed runs", async () => {
    const io = createIo();

    const exitCode = await runCli(["clean-failed"], io);

    expect(exitCode).toBe(1);
    expect(io.err.join("\n")).toContain("--yes");
  });

  it("runs the map-heuristic convenience command with heuristic stage1 config and optional dashboard", async () => {
    const io = createIo();
    const seen: Array<{ config: HarnessConfig; maxSteps?: number }> = [];
    let dashboardClosed = false;

    const exitCode = await withEnv({ AI_PROVIDER: "openai", OPENAI_API_KEY: "unit-test-key" }, () => runCli([
      "map-heuristic",
      "--max-steps",
      "4",
      "--run-id",
      "map-cli-run",
      "--with-dashboard",
      "--port",
      "3131"
    ], io, {
      async startDashboard(config, port) {
        expect(config.aiProvider).toBe("heuristic");
        expect(config.harnessMode).toBe("stage1");
        expect(port).toBe(3131);
        return {
          url: "http://127.0.0.1:3131",
          async close() {
            dashboardClosed = true;
          }
        };
      },
      createRunner(config, options) {
        seen.push({ config, maxSteps: options.maxSteps });
        return {
          async snapshot() {
            throw new Error("snapshot should not run");
          },
          async run() {
            return { status: "completed" };
          }
        };
      }
    }));

    expect(exitCode).toBe(0);
    expect(dashboardClosed).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.config.aiProvider).toBe("heuristic");
    expect(seen[0]?.config.harnessMode).toBe("stage1");
    expect(seen[0]?.config.harnessRunId).toBe("map-cli-run");
    expect(seen[0]?.maxSteps).toBe(4);
    expect(io.out.join("\n")).toContain("Dashboard listening at http://127.0.0.1:3131");
    expect(io.out.join("\n")).toContain('"command": "map-heuristic"');
  });

  it("validates press through the action schema before executing", async () => {
    const io = createIo();
    const actions: unknown[] = [];

    const okExit = await runCli(["press", "A", "--frames", "3"], io, {
      async controlRequest() {
        throw new Error("no control server in unit test");
      },
      async executePress(_config, action) {
        actions.push(action);
      }
    });
    const badExit = await runCli(["press", "L", "--frames", "3"], createIo(), {
      async controlRequest() {
        throw new Error("no control server in unit test");
      },
      async executePress(_config, action) {
        actions.push(action);
      }
    });

    expect(okExit).toBe(0);
    expect(badExit).toBe(1);
    expect(actions).toEqual([{ type: "press", button: "A", frames: 3 }]);
  });

  it("keeps legacy scaffold help expectations meaningful", () => {
    expect(getHarnessHelp()).toContain("Pokemon Red/Blue AI harness CLI");
    expect(getHarnessHelp()).toContain("mGBA preflight");
  });
});


function createTestConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    mgbaHttpBaseUrl: "http://127.0.0.1:5000",
    pokemonVersion: "red",
    harnessMode: "stage1",
    evidenceDir: "runs",
    harnessRunId: "test-run",
    logLevel: "info",
    loopMaxSteps: 10,
    loopStepDelayMs: 0,
    maxLlmCalls: 10,
    defaultTapFrames: 5,
    defaultHoldFrames: 15,
    aiProvider: "heuristic",
    ...overrides
  } as HarnessConfig;
}

function createIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout(message: string) {
      out.push(message);
    },
    stderr(message: string) {
      err.push(message);
    }
  };
}

async function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
