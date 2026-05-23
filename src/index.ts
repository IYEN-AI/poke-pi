import "dotenv/config";
import { execFile, spawn } from "node:child_process";
import { mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { HeuristicPolicy } from "./ai/HeuristicPolicy.js";
import { GeneratedHeuristicPolicy } from "./ai/generatedPolicy/GeneratedHeuristicPolicy.js";
import { synthesizeGeneratedPolicy } from "./ai/generatedPolicy/PolicySynthesis.js";
import { LLMPolicy } from "./ai/LLMPolicy.js";
import { Controller } from "./control/Controller.js";
import type { MgbaButton } from "./mgba/MgbaTypes.js";
import { MGBA_BUTTONS } from "./mgba/MgbaTypes.js";
import { HarnessActionSchema } from "./control/ActionSchema.js";
import { loadConfig, type AiProvider, type HarnessConfig, type HarnessMode } from "./config.js";
import { EvidenceRecorder } from "./evidence/EvidenceRecorder.js";
import { redactSecrets } from "./evidence/redaction.js";
import { HarnessError } from "./errors.js";
import { HarnessRunner } from "./loop/HarnessRunner.js";
import { runMgbaSmokeWorkflow, type MgbaSmokeWorkflowDependencies } from "./loop/MgbaSmokeWorkflow.js";
import { MgbaHttpClient } from "./mgba/MgbaHttpClient.js";
import { runMgbaPreflight, type MgbaPreflightReport } from "./mgba/preflight.js";
import { PokemonStateReader } from "./pokemon/PokemonStateReader.js";
import { FullGameDetector } from "./pokemon/FullGameDetector.js";
import { Stage1Detector } from "./pokemon/Stage1Detector.js";
import { startDashboard, type DashboardHandle } from "./dashboardServer.js";
import { runStrategyLoop } from "./agent/StrategyLoop.js";
import { readLatestMovementFeedback, runMovementMonitor } from "./agent/MovementMonitor.js";

type HarnessCommand = "snapshot" | "preflight" | "run" | "press" | "smoke" | "dashboard" | "map-heuristic" | "scout" | "synthesize-policy" | "play-policy" | "strategy-loop" | "strategy-bg" | "movement-monitor" | "movement-monitor-bg" | "status" | "play" | "llm" | "ui" | "doctor" | "stop" | "clean-failed";

export interface CliOptions {
  readonly command?: HarnessCommand;
  readonly dryRun: boolean;
  readonly help: boolean;
  readonly policy?: AiProvider;
  readonly mode?: HarnessMode;
  readonly maxSteps?: number;
  readonly runId?: string;
  readonly pressButton?: string;
  readonly pressFrames?: number;
  readonly dashboardPort?: number;
  readonly withDashboard: boolean;
  readonly yes: boolean;
  readonly fromRun?: string;
  readonly policyId?: string;
  readonly policyFile?: string;
  readonly objective?: string;
  readonly iterations?: number;
  readonly pollMs?: number;
  readonly llmEvery?: number;
  readonly runIdPrefix?: string;
}

export interface CliIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

export interface CliFactories {
  readonly loadConfig?: (env: NodeJS.ProcessEnv) => HarnessConfig;
  readonly createRunner?: (config: HarnessConfig, options: RunnerCommandOptions) => CliRunner | Promise<CliRunner>;
  readonly runPreflight?: (config: HarnessConfig) => Promise<MgbaPreflightReport>;
  readonly executePress?: (config: HarnessConfig, action: unknown) => Promise<void>;
  readonly startDashboard?: (config: HarnessConfig, port?: number) => Promise<DashboardHandle>;
  readonly controlRequest?: (baseUrl: string, path: string, body?: unknown, method?: "GET" | "POST") => Promise<{ status: number; body: unknown }>;
}

export interface CliRunner {
  snapshot(): Promise<unknown>;
  run(): Promise<{ readonly status: string }>;
}

interface RunnerCommandOptions {
  readonly maxSteps?: number;
  readonly policyFile?: string;
}

interface ParsedOptionResult {
  readonly options: CliOptions;
  readonly errors: string[];
}

const execFileAsync = promisify(execFile);

const DEFAULT_IO: CliIo = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message)
};

export function getHarnessHelp(): string {
  return [
    "Pokemon Red/Blue AI harness CLI",
    "",
    "Usage:",
    "  npm run harness -- --help",
    "  npm run harness -- snapshot [--dry-run] [--policy heuristic|openai] [--mode stage1|full-game] [--max-steps N] [--run-id ID]",
    "  npm run harness -- preflight [--policy heuristic|openai] [--mode stage1|full-game] [--run-id ID]",
    "  npm run harness -- run [--policy heuristic|openai] [--mode stage1|full-game] [--max-steps N] [--run-id ID]",
    "  npm run poke -- status",
    "  npm run poke -- play [--max-steps N] [--run-id ID] [--port N]",
    "  npm run poke -- scout [--max-steps N] [--run-id ID] [--port N]",
    "  npm run poke -- synthesize-policy --from-run RUN --policy-id ID [--objective TEXT]",
    "  npm run poke -- play-policy --policy-file policies/generated/ID.json [--max-steps N] [--run-id ID]",
    "  npm run poke -- llm [--max-steps N] [--run-id ID] [--port N] [--policy-file policies/generated/ID.json]",
    "  npm run poke -- strategy-loop [--iterations N] [--max-steps N] [--llm-every N] [--poll-ms N] [--port N]",
    "  npm run poke -- strategy-bg [--iterations N] [--max-steps N] [--llm-every N] [--poll-ms N] [--port N]",
    "  npm run poke -- movement-monitor [--iterations N] [--poll-ms N] [--port N]",
    "  npm run poke -- movement-monitor-bg [--iterations N] [--poll-ms N] [--port N]",
    "  npm run poke -- ui [--port N]",
    "  npm run poke -- stop",
    "  npm run poke -- clean-failed --yes",
    "  npm run harness -- map-heuristic [--max-steps N] [--run-id ID] [--with-dashboard] [--port N]",
    "  npm run harness -- press BUTTON [--frames N] [--run-id ID]",
    "  npm run smoke:mgba",
    "  npm run harness -- dashboard [--port N] [--policy heuristic|openai] [--mode stage1|full-game]",
    "",
    "Commands:",
    "  snapshot   Record one runner snapshot, or print config only with --dry-run.",
    "  preflight  Run mGBA preflight against the manually started service and loaded ROM state.",
    "  run        Start the selected harness loop. Defaults to Stage 1.",
    "  map-heuristic  Run map-aware heuristic exploration; optionally starts the dashboard for the run.",
    "  scout      Alias for play: collect cheap heuristic map/state/action evidence.",
    "  synthesize-policy  Create a validated JSON heuristic policy from a scout run.",
    "  play-policy  Execute a generated JSON heuristic policy artifact.",
    "  strategy-loop  Poll in foreground and alternate scout/generated/LLM-guided policy runs.",
    "  strategy-bg  Start strategy-loop as a detached background process and write a log under runs/.strategy/.",
    "  movement-monitor  Watch active runs and write movement feedback under runs/.movement-feedback/.",
    "  movement-monitor-bg  Start movement-monitor as a detached background observer.",
    "  status     Print redacted config and mGBA preflight status.",
    "  play       Start map-aware heuristic Stage 1 with dashboard enabled by default.",
    "  llm        Start OpenAI-compatible Stage 1 with dashboard enabled by default; --policy-file supplies a generated-policy guide.",
    "  ui         Start the dashboard alias.",
    "  doctor     Run preflight alias.",
    "  stop       Stop repo-started harness/dashboard Node processes; leaves mGBA alone.",
    "  clean-failed  Delete non-completed run directories; requires --yes.",
    "  press      Send one safe Game Boy button press for smoke checks.",
    "  smoke      Opt-in mGBA smoke: preflight, snapshot, press B, snapshot.",
    "  dashboard  Start a local web dashboard for live screen, RAM state, and run evidence.",
    "",
    "Safe buttons: A, B, Start, Select, Up, Down, Left, Right"
  ].join("\n");
}

export function parseCliArgs(args: readonly string[]): ParsedOptionResult {
  const errors: string[] = [];
  const options: MutableCliOptions = { dryRun: false, help: false, withDashboard: false, yes: false };
  const rest: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--policy":
        options.policy = parsePolicy(args[++index], errors);
        break;
      case "--mode":
        options.mode = parseMode(args[++index], errors);
        break;
      case "--max-steps":
        options.maxSteps = parsePositiveInteger(args[++index], "--max-steps", errors);
        break;
      case "--run-id":
        options.runId = parseNonEmpty(args[++index], "--run-id", errors);
        break;
      case "--frames":
        options.pressFrames = parsePositiveInteger(args[++index], "--frames", errors);
        break;
      case "--port":
        options.dashboardPort = parsePositiveInteger(args[++index], "--port", errors);
        break;
      case "--with-dashboard":
        options.withDashboard = true;
        break;
      case "--yes":
      case "-y":
        options.yes = true;
        break;
      case "--from-run":
        options.fromRun = parseNonEmpty(args[++index], "--from-run", errors);
        break;
      case "--policy-id":
        options.policyId = parseNonEmpty(args[++index], "--policy-id", errors);
        break;
      case "--policy-file":
        options.policyFile = parseNonEmpty(args[++index], "--policy-file", errors);
        break;
      case "--objective":
        options.objective = parseNonEmpty(args[++index], "--objective", errors);
        break;
      case "--iterations":
        options.iterations = parsePositiveInteger(args[++index], "--iterations", errors);
        break;
      case "--poll-ms":
        options.pollMs = parsePositiveInteger(args[++index], "--poll-ms", errors);
        break;
      case "--llm-every":
        options.llmEvery = parsePositiveInteger(args[++index], "--llm-every", errors);
        break;
      case "--run-id-prefix":
        options.runIdPrefix = parseNonEmpty(args[++index], "--run-id-prefix", errors);
        break;
      default:
        if (arg?.startsWith("--") === true) {
          errors.push(`Unknown option: ${arg}`);
        } else if (arg !== undefined) {
          rest.push(arg);
        }
    }
  }

  const command = rest[0];
  if (command !== undefined) {
    if (isHarnessCommand(command)) {
      options.command = command;
      if (command === "press") {
        options.pressButton = rest[1];
        if (rest.length > 2) {
          errors.push(`Unexpected argument for press: ${rest.slice(2).join(" ")}`);
        }
      } else if (rest.length > 1) {
        errors.push(`Unexpected argument for ${command}: ${rest.slice(1).join(" ")}`);
      }
    } else {
      errors.push(`Unknown command: ${command}`);
    }
  }

  return { options, errors };
}

export async function runCli(
  args: readonly string[] = process.argv.slice(2),
  io: CliIo = DEFAULT_IO,
  factories: CliFactories = {}
): Promise<number> {
  const parsed = parseCliArgs(args);
  if (parsed.options.help || args.length === 0) {
    io.stdout(getHarnessHelp());
    return parsed.errors.length === 0 ? 0 : 1;
  }

  if (parsed.errors.length > 0) {
    io.stderr(parsed.errors.join("\n"));
    io.stderr("\n" + getHarnessHelp());
    return 1;
  }

  try {
    switch (parsed.options.command) {
      case "snapshot":
        return await handleSnapshot(parsed.options, io, factories);
      case "preflight":
      case "doctor":
        return await handlePreflight(parsed.options, io, factories);
      case "status":
        return await handleStatus(parsed.options, io, factories);
      case "run":
        return await handleRun(parsed.options, io, factories);
      case "map-heuristic":
        return await handleMapHeuristic(parsed.options, io, factories);
      case "scout":
        return await handleScout(parsed.options, io, factories);
      case "synthesize-policy":
        return await handleSynthesizePolicy(parsed.options, io, factories);
      case "play-policy":
        return await handlePlayPolicy(parsed.options, io, factories);
      case "strategy-loop":
        return await handleStrategyLoop(parsed.options, io, factories);
      case "strategy-bg":
        return await handleStrategyBackground(parsed.options, io, factories);
      case "movement-monitor":
        return await handleMovementMonitor(parsed.options, io, factories);
      case "movement-monitor-bg":
        return await handleMovementMonitorBackground(parsed.options, io, factories);
      case "play":
        return await handlePlay(parsed.options, io, factories);
      case "llm":
        return await handleLlm(parsed.options, io, factories);
      case "press":
        return await handlePress(parsed.options, io, factories);
      case "smoke":
        return await handleSmoke(parsed.options, io);
      case "dashboard":
      case "ui":
        return await handleDashboard(parsed.options, io, factories);
      case "stop":
        return await handleStop(parsed.options, io, factories);
      case "clean-failed":
        return await handleCleanFailed(parsed.options, io, factories);
      default:
        io.stderr("Missing command.\n" + getHarnessHelp());
        return 1;
    }
  } catch (error) {
    io.stderr(formatSafeError(error));
    return 1;
  }
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  process.exitCode = await runCli(args);
}

function loadCommandConfig(options: CliOptions, factories: CliFactories, dryRun = false): HarnessConfig {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (options.policy !== undefined) {
    env.AI_PROVIDER = options.policy;
  }
  if (options.mode !== undefined) {
    env.HARNESS_MODE = options.mode;
  }
  if (options.maxSteps !== undefined) {
    env.LOOP_MAX_STEPS = String(options.maxSteps);
  }
  if (options.runId !== undefined) {
    env.HARNESS_RUN_ID = options.runId;
  }
  if (dryRun && !hasProviderApiKey(env)) {
    env.AI_PROVIDER = "heuristic";
  }

  return (factories.loadConfig ?? loadConfig)(env);
}

async function handleSnapshot(options: CliOptions, io: CliIo, factories: CliFactories): Promise<number> {
  const config = loadCommandConfig(options, factories, options.dryRun);
  if (options.dryRun) {
    io.stdout("Snapshot dry run succeeded. No mGBA or OpenAI client was constructed.");
    io.stdout(formatConfigSummary(config));
    return 0;
  }

  const runner = await (factories.createRunner ?? createRunner)(config, { maxSteps: options.maxSteps, policyFile: options.policyFile });
  const snapshot = await runner.snapshot();
  io.stdout(redactSecrets({ command: "snapshot", snapshot }));
  return 0;
}

async function handlePreflight(options: CliOptions, io: CliIo, factories: CliFactories): Promise<number> {
  const config = loadCommandConfig(options, factories);
  const report = await (factories.runPreflight ?? ((loadedConfig) => runMgbaPreflight({ config: loadedConfig })))(config);
  io.stdout(formatPreflightReport(report));
  return report.ok ? 0 : 1;
}


async function handleStatus(options: CliOptions, io: CliIo, factories: CliFactories): Promise<number> {
  const config = loadCommandConfig(options, factories, true);
  io.stdout(formatConfigSummary(config));
  const report = await (factories.runPreflight ?? ((loadedConfig) => runMgbaPreflight({ config: loadedConfig })))(config);
  io.stdout(formatPreflightReport(report));
  return report.ok ? 0 : 1;
}

async function handleRun(options: CliOptions, io: CliIo, factories: CliFactories): Promise<number> {
  const config = loadCommandConfig(options, factories);
  const runner = await (factories.createRunner ?? createRunner)(config, { maxSteps: options.maxSteps, policyFile: options.policyFile });
  const result = await runner.run();
  io.stdout(redactSecrets({ command: "run", policyFile: options.policyFile, result }));
  return result.status === "completed" ? 0 : 1;
}


async function handleMapHeuristic(options: CliOptions, io: CliIo, factories: CliFactories): Promise<number> {
  const config = loadCommandConfig({
    ...options,
    policy: "heuristic",
    mode: options.mode ?? "stage1",
    runId: options.runId ?? `map-heuristic-${Date.now()}`
  }, factories);
  const dashboard = options.withDashboard
    ? await (factories.startDashboard ?? startDashboardFromConfig)(config, options.dashboardPort)
    : undefined;

  if (dashboard !== undefined) {
    io.stdout(`Dashboard listening at ${dashboard.url}`);
  }

  try {
    const runner = await (factories.createRunner ?? createRunner)(config, { maxSteps: options.maxSteps, policyFile: options.policyFile });
    const result = await runner.run();
    io.stdout(redactSecrets({ command: "map-heuristic", dashboardUrl: dashboard?.url, result }));
    return result.status === "completed" ? 0 : 1;
  } finally {
    await dashboard?.close();
  }
}

async function handleScout(options: CliOptions, io: CliIo, factories: CliFactories): Promise<number> {
  return handlePlay({ ...options, runId: options.runId ?? `scout-${Date.now()}` }, io, factories);
}

async function handleSynthesizePolicy(options: CliOptions, io: CliIo, factories: CliFactories): Promise<number> {
  const config = loadCommandConfig(options, factories, true);
  if (options.fromRun === undefined || options.policyId === undefined) {
    io.stderr("synthesize-policy requires --from-run RUN and --policy-id ID.");
    return 1;
  }

  const result = await synthesizeGeneratedPolicy({
    evidenceDir: config.evidenceDir,
    fromRun: options.fromRun,
    policyId: options.policyId,
    objective: options.objective,
    outputFile: options.policyFile
  });
  io.stdout(redactSecrets({ command: "synthesize-policy", result }));
  return 0;
}

async function handlePlayPolicy(options: CliOptions, io: CliIo, factories: CliFactories): Promise<number> {
  if (options.policyFile === undefined) {
    io.stderr("play-policy requires --policy-file policies/generated/<id>.json.");
    return 1;
  }

  const config = loadCommandConfig({
    ...options,
    policy: "heuristic",
    mode: options.mode ?? "stage1",
    runId: options.runId ?? `policy-${Date.now()}`
  }, factories);
  const runner = await (factories.createRunner ?? createRunner)(config, { maxSteps: options.maxSteps, policyFile: options.policyFile });
  const result = await runner.run();
  io.stdout(redactSecrets({ command: "play-policy", policyFile: options.policyFile, result }));
  return result.status === "completed" ? 0 : 1;
}

async function handleStrategyLoop(options: CliOptions, io: CliIo, factories: CliFactories): Promise<number> {
  const config = loadCommandConfig({
    ...options,
    policy: "heuristic",
    mode: options.mode ?? "stage1",
    runId: options.runId ?? `strategy-${Date.now()}`
  }, factories, true);
  const control = await getControlServer(config, options.dashboardPort, io, factories);
  const startedAt = new Date().toISOString().replace(/[:.]/g, "-");
  const result = await runStrategyLoop({
    baseUrl: control.url,
    maxIterations: options.iterations ?? 12,
    maxSteps: options.maxSteps ?? 80,
    pollMs: options.pollMs ?? 2000,
    llmEvery: options.llmEvery ?? 4,
    runIdPrefix: options.runIdPrefix ?? `strategy-${startedAt}`,
    policyIdPrefix: options.policyId ?? `strategy-policy-${startedAt}`,
    objective: options.objective,
    request: (baseUrl, pathName, body, method = "POST") => requestControl(baseUrl, pathName, body, factories, method),
    movementFeedback: () => readLatestMovementFeedback(config.evidenceDir),
    log: (event) => io.stdout(redactSecrets({ command: "strategy-loop", event }))
  });
  io.stdout(redactSecrets({ command: "strategy-loop", dashboardUrl: control.url, result }));
  return 0;
}

async function handleStrategyBackground(options: CliOptions, io: CliIo, factories: CliFactories): Promise<number> {
  if (factories.controlRequest !== undefined || factories.startDashboard !== undefined) {
    return handleStrategyLoop(options, io, factories);
  }

  const config = loadCommandConfig(options, factories, true);
  const logDir = path.join(config.evidenceDir, ".strategy");
  await mkdir(logDir, { recursive: true });
  const startedAt = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(logDir, `${options.runIdPrefix ?? "strategy"}-${startedAt}.log`);
  const logHandle = await open(logPath, "a");
  const childArgs = [
    "src/index.ts",
    "strategy-loop",
    "--iterations",
    String(options.iterations ?? 12),
    "--max-steps",
    String(options.maxSteps ?? 80),
    "--poll-ms",
    String(options.pollMs ?? 2000),
    "--llm-every",
    String(options.llmEvery ?? 4),
    "--port",
    String(options.dashboardPort ?? 3030),
    "--run-id-prefix",
    options.runIdPrefix ?? `strategy-${startedAt}`
  ];
  if (options.objective !== undefined) {
    childArgs.push("--objective", options.objective);
  }
  if (options.policyId !== undefined) {
    childArgs.push("--policy-id", options.policyId);
  }

  const child = spawn("./node_modules/.bin/tsx", childArgs, {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: ["ignore", logHandle.fd, logHandle.fd]
  });
  child.unref();
  await logHandle.close();
  io.stdout(redactSecrets({ command: "strategy-bg", pid: child.pid, logPath, args: childArgs }));
  return 0;
}


async function handleMovementMonitor(options: CliOptions, io: CliIo, factories: CliFactories): Promise<number> {
  const config = loadCommandConfig(options, factories, true);
  const baseUrl = controlBaseUrl(options.dashboardPort);
  const result = await runMovementMonitor({
    evidenceDir: config.evidenceDir,
    baseUrl,
    iterations: options.iterations ?? 120,
    pollMs: options.pollMs ?? 1000,
    request: factories.controlRequest === undefined ? undefined : (url, pathName) => factories.controlRequest!(url, pathName, undefined, "GET"),
    log: (event) => io.stdout(redactSecrets({ command: "movement-monitor", event }))
  });
  io.stdout(redactSecrets({ command: "movement-monitor", dashboardUrl: baseUrl, result }));
  return 0;
}

async function handleMovementMonitorBackground(options: CliOptions, io: CliIo, factories: CliFactories): Promise<number> {
  if (factories.controlRequest !== undefined) {
    return handleMovementMonitor(options, io, factories);
  }

  const config = loadCommandConfig(options, factories, true);
  const logDir = path.join(config.evidenceDir, ".movement-monitor");
  await mkdir(logDir, { recursive: true });
  const startedAt = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(logDir, `${options.runIdPrefix ?? "movement-monitor"}-${startedAt}.log`);
  const logHandle = await open(logPath, "a");
  const childArgs = [
    "src/index.ts",
    "movement-monitor",
    "--iterations",
    String(options.iterations ?? 3600),
    "--poll-ms",
    String(options.pollMs ?? 1000),
    "--port",
    String(options.dashboardPort ?? 3030)
  ];
  const child = spawn("./node_modules/.bin/tsx", childArgs, {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: ["ignore", logHandle.fd, logHandle.fd]
  });
  child.unref();
  await logHandle.close();
  io.stdout(redactSecrets({ command: "movement-monitor-bg", pid: child.pid, logPath, args: childArgs }));
  return 0;
}

async function handlePlay(options: CliOptions, io: CliIo, factories: CliFactories): Promise<number> {
  return startControlledRun("play", options, io, factories);
}

async function handleLlm(options: CliOptions, io: CliIo, factories: CliFactories): Promise<number> {
  return startControlledRun("llm", options, io, factories);
}

async function startControlledRun(kind: "play" | "llm", options: CliOptions, io: CliIo, factories: CliFactories): Promise<number> {
  const config = loadCommandConfig({
    ...options,
    policy: kind === "llm" ? "openai" : "heuristic",
    mode: options.mode ?? "stage1",
    runId: options.runId ?? `${kind}-${Date.now()}`
  }, factories);
  const control = await getControlServer(config, options.dashboardPort, io, factories);
  const response = await requestControl(control.url, `/api/control/${kind}`, {
    maxSteps: options.maxSteps,
    runId: config.harnessRunId,
    mode: config.harnessMode,
    policyFile: options.policyFile
  }, factories);
  io.stdout(redactSecrets({ command: kind, dashboardUrl: control.url, response: response.body }));

  if (response.status >= 400) {
    await control.startedHere?.close();
    return 1;
  }

  if (control.startedHere !== undefined) {
    await waitForControlledRun(control.url, factories);
    await control.startedHere.close();
  }

  return 0;
}

async function handleStop(options: CliOptions, io: CliIo, factories: CliFactories): Promise<number> {
  const baseUrl = controlBaseUrl(options.dashboardPort);
  try {
    const response = await requestControl(baseUrl, "/api/control/stop", {}, factories);
    if (response.status >= 400) {
      throw new Error("control server unavailable");
    }
    io.stdout(redactSecrets({ command: "stop", dashboardUrl: baseUrl, response: response.body, note: "mGBA and mGBA-http are left running" }));
    return 0;
  } catch {
    if (process.platform === "win32") {
      io.stderr("stop could not reach the control server and process fallback is only implemented for Unix-like shells.");
      return 1;
    }

    const patterns = ["tsx src/index.ts run", "tsx src/index.ts dashboard", "tsx src/index.ts map-heuristic"];
    const stopped = await stopRepoNodeProcesses(patterns);

    io.stdout(redactSecrets({ command: "stop", stopped, note: "control server unavailable; mGBA and mGBA-http are left running" }));
    return 0;
  }
}

async function handleCleanFailed(options: CliOptions, io: CliIo, factories: CliFactories): Promise<number> {
  if (!options.yes) {
    io.stderr("clean-failed deletes run directories. Re-run with --yes to confirm.");
    return 1;
  }

  const baseUrl = controlBaseUrl(options.dashboardPort);
  try {
    const response = await requestControl(baseUrl, "/api/control/clean-failed", {}, factories);
    if (response.status >= 400) {
      throw new Error("control server unavailable");
    }
    io.stdout(redactSecrets({ command: "clean-failed", dashboardUrl: baseUrl, response: response.body }));
    return 0;
  } catch {
    // Fall back to local filesystem cleanup when the control server is not running.
  }

  const config = loadCommandConfig(options, factories, true);
  const removed: Array<{ runId: string; status: string }> = [];
  const entries = await readdir(config.evidenceDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }

    const runDir = path.join(config.evidenceDir, entry.name);
    const status = await readRunStatus(runDir);
    if (status !== "completed") {
      await rm(runDir, { force: true, recursive: true });
      removed.push({ runId: entry.name, status });
    }
  }

  io.stdout(redactSecrets({ command: "clean-failed", removed }));
  return 0;
}

async function readRunStatus(runDir: string): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(path.join(runDir, "summary.json"), "utf8")) as { status?: unknown };
    return typeof parsed.status === "string" ? parsed.status : "unknown";
  } catch {
    return "missing_summary";
  }
}

async function handleDashboard(options: CliOptions, io: CliIo, factories: CliFactories): Promise<number> {
  const config = loadCommandConfig(options, factories);
  const handle = await (factories.startDashboard ?? startDashboardFromConfig)(config, options.dashboardPort);
  io.stdout(`Dashboard listening at ${handle.url}`);
  return await new Promise<number>(() => {});
}

async function handlePress(options: CliOptions, io: CliIo, factories: CliFactories): Promise<number> {
  const config = loadCommandConfig(options, factories);
  const frames = options.pressFrames ?? config.defaultTapFrames;
  const action = { type: "press", button: options.pressButton, frames };
  const parsed = HarnessActionSchema.safeParse(action);
  if (!parsed.success || parsed.data.type !== "press") {
    throw new HarnessError("ACTION_REJECTED", "press requires a safe Game Boy button and frame count", {
      context: { allowedButtons: MGBA_BUTTONS, frames }
    });
  }

  try {
    const baseUrl = controlBaseUrl(options.dashboardPort);
    const status = await requestControl(baseUrl, "/api/control/status", undefined, factories, "GET");
    if (status.status >= 400) {
      throw new Error("control server unavailable");
    }
    const response = await requestControl(baseUrl, "/api/control/press", { button: parsed.data.button, frames: parsed.data.frames }, factories);
    io.stdout(redactSecrets({ command: "press", dashboardUrl: baseUrl, response: response.body }));
    return response.status >= 400 ? 1 : 0;
  } catch {
    await (factories.executePress ?? executePress)(config, parsed.data);
    io.stdout(redactSecrets({ command: "press", action: parsed.data, status: "executed", transport: "direct" }));
    return 0;
  }
}

async function handleSmoke(options: CliOptions, io: CliIo): Promise<number> {
  if (process.env.RUN_MGBA_INTEGRATION !== "1" || process.env.MGBA_HTTP_BASE_URL === undefined || process.env.MGBA_HTTP_BASE_URL.trim().length === 0) {
    io.stdout("mGBA smoke skipped. Set RUN_MGBA_INTEGRATION=1 and MGBA_HTTP_BASE_URL to contact an already running mGBA-http service.");
    return 0;
  }

  const config = loadCommandConfig({ ...options, runId: options.runId ?? `smoke-mgba-${Date.now()}` }, {});
  const dependencies = createSmokeDependencies(config);
  const result = await runMgbaSmokeWorkflow({ config, dependencies });
  io.stdout(redactSecrets({ command: "smoke:mgba", result, evidenceDir: `${config.evidenceDir}/${config.harnessRunId}` }));
  return result.status === "completed" ? 0 : 1;
}

function createSmokeDependencies(config: HarnessConfig): MgbaSmokeWorkflowDependencies {
  const client = new MgbaHttpClient({ baseUrl: config.mgbaHttpBaseUrl });
  const evidence = new EvidenceRecorder({ evidenceDir: config.evidenceDir, runId: config.harnessRunId });
  const controller = new Controller({
    client,
    defaultTapFrames: config.defaultTapFrames,
    defaultHoldFrames: config.defaultHoldFrames
  });
  const runner = new HarnessRunner({
    config,
    client,
    stateReader: new PokemonStateReader({ client, version: config.pokemonVersion }),
    policy: new HeuristicPolicy(),
    controller,
    evidence,
    detector: createDetector(config),
    budgets: { maxSteps: 1 }
  });

  return {
    startEvidence: (startConfig) => evidence.startRun(startConfig),
    runPreflight: () => runMgbaPreflight({ config, client }),
    snapshot: () => runner.snapshot(),
    press: (action) => controller.execute(action),
    recordAction: (action) => evidence.recordAction(action),
    recordError: (error) => evidence.recordError(error),
    finishEvidence: (status, result) => evidence.finishRun(status, result)
  };
}

async function createRunner(config: HarnessConfig, options: RunnerCommandOptions): Promise<CliRunner> {
  const client = new MgbaHttpClient({ baseUrl: config.mgbaHttpBaseUrl });
  const heuristicPolicy = options.policyFile !== undefined
    ? await GeneratedHeuristicPolicy.fromFile(options.policyFile)
    : new HeuristicPolicy();
  const policy = isLlmProvider(config.aiProvider)
    ? LLMPolicy.fromConfig(config, heuristicPolicy, options.policyFile !== undefined && heuristicPolicy instanceof GeneratedHeuristicPolicy
      ? { guidePolicy: heuristicPolicy, guideDescription: heuristicPolicy.getDefinition() }
      : {})
    : heuristicPolicy;

  return new HarnessRunner({
    config,
    client,
    stateReader: new PokemonStateReader({ client, version: config.pokemonVersion }),
    policy,
    controller: new Controller({
      client,
      defaultTapFrames: config.defaultTapFrames,
      defaultHoldFrames: config.defaultHoldFrames
    }),
    evidence: new EvidenceRecorder({ evidenceDir: config.evidenceDir, runId: config.harnessRunId }),
    detector: createDetector(config),
    budgets: { maxSteps: options.maxSteps }
  });
}


function controlBaseUrl(port?: number): string {
  return `http://127.0.0.1:${port ?? 3030}`;
}

async function getControlServer(
  config: HarnessConfig,
  port: number | undefined,
  io: CliIo,
  factories: CliFactories
): Promise<{ url: string; startedHere?: DashboardHandle }> {
  const baseUrl = controlBaseUrl(port);
  try {
    await requestControl(baseUrl, "/api/control/status", undefined, factories, "GET");
    return { url: baseUrl };
  } catch {
    const handle = await startControlDashboard(config, port, factories);
    io.stdout(`Dashboard listening at ${handle.url}`);
    return { url: handle.url, startedHere: handle };
  }
}

async function requestControl(
  baseUrl: string,
  pathName: string,
  body: unknown,
  factories: CliFactories,
  method = "POST"
): Promise<{ status: number; body: unknown }> {
  if (factories.controlRequest !== undefined) {
    return factories.controlRequest(baseUrl, pathName, body, method as "GET" | "POST");
  }

  const response = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: method === "POST" ? { "content-type": "application/json" } : undefined,
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined
  });
  return { status: response.status, body: await response.json() };
}

async function waitForControlledRun(baseUrl: string, factories: CliFactories): Promise<void> {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const status = await requestControl(baseUrl, "/api/control/status", undefined, factories, "GET");
    if (objectField(status.body, "running") !== true) {
      return;
    }
  }
}


async function startControlDashboard(config: HarnessConfig, port: number | undefined, factories: CliFactories): Promise<DashboardHandle> {
  try {
    return await (factories.startDashboard ?? startDashboardFromConfig)(config, port);
  } catch (error) {
    if (!isAddressInUseError(error) || factories.startDashboard !== undefined || process.platform === "win32") {
      throw error;
    }

    await stopRepoNodeProcesses(["tsx src/index.ts dashboard"]);
    return await startDashboardFromConfig(config, port);
  }
}

async function stopRepoNodeProcesses(patterns: readonly string[]): Promise<string[]> {
  const stopped: string[] = [];
  for (const pattern of patterns) {
    try {
      await execFileAsync("pkill", ["-f", pattern]);
      stopped.push(pattern);
    } catch {
      // pkill exits nonzero when no process matched; that is fine.
    }
  }
  return stopped;
}

function isAddressInUseError(error: unknown): boolean {
  return error instanceof Error && (error.message.includes("EADDRINUSE") || ("code" in error && (error as NodeJS.ErrnoException).code === "EADDRINUSE"));
}

async function startDashboardFromConfig(config: HarnessConfig, port?: number): Promise<DashboardHandle> {
  return startDashboard({ config, port });
}

async function executePress(config: HarnessConfig, action: { type: "press"; button: MgbaButton; frames: number }): Promise<void> {
  const client = new MgbaHttpClient({ baseUrl: config.mgbaHttpBaseUrl });
  const controller = new Controller({
    client,
    defaultTapFrames: config.defaultTapFrames,
    defaultHoldFrames: config.defaultHoldFrames
  });
  await controller.execute(action);
}

function formatConfigSummary(config: HarnessConfig): string {
  return redactSecrets({
    mgbaHttpBaseUrl: config.mgbaHttpBaseUrl,
    pokemonVersion: config.pokemonVersion,
    harnessMode: config.harnessMode,
    hasPokemonRomPath: config.pokemonRomPath !== undefined,
    evidenceDir: config.evidenceDir,
    harnessRunId: config.harnessRunId,
    logLevel: config.logLevel,
    loopMaxSteps: config.loopMaxSteps,
    loopStepDelayMs: config.loopStepDelayMs,
    maxLlmCalls: config.maxLlmCalls,
    defaultTapFrames: config.defaultTapFrames,
    defaultHoldFrames: config.defaultHoldFrames,
    aiProvider: config.aiProvider,
    ...(config.aiProvider === "openai" ? {
      openaiBaseUrl: config.openaiBaseUrl,
      hasOpenaiApiKey: config.openaiApiKey !== undefined,
      openaiModel: config.openaiModel,
      openaiTemperature: config.openaiTemperature
    } : {})
  });
}

function formatPreflightReport(report: MgbaPreflightReport): string {
  const lines = [
    `mGBA preflight ${report.ok ? "passed" : "failed"}`,
    "",
    ...report.checks.map((check) => {
      const parts = [`[${check.status}] ${check.name}: ${check.message}`];
      if (check.guidance !== undefined) {
        parts.push(`  Guidance: ${check.guidance}`);
      }
      if (check.errorCode !== undefined) {
        parts.push(`  Code: ${check.errorCode}`);
      }
      return parts.join("\n");
    })
  ];

  if (!report.ok) {
    lines.push("", "Setup: start mGBA manually with mGBA-http enabled, load a Pokemon Red or Blue ROM that you provide, and check MGBA_HTTP_BASE_URL.");
  }

  return redactSecrets(lines.join("\n"));
}

function objectField(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function formatSafeError(error: unknown): string {
  if (error instanceof HarnessError) {
    return redactSecrets(`${error.code}: ${error.message}`);
  }
  if (error instanceof Error) {
    return redactSecrets(error.message);
  }

  return redactSecrets(inspect(error));
}

function parsePolicy(value: string | undefined, errors: string[]): AiProvider | undefined {
  if (value === "heuristic" || value === "openai") {
    return value;
  }
  errors.push("--policy must be heuristic or openai");
  return undefined;
}

function parseMode(value: string | undefined, errors: string[]): HarnessMode | undefined {
  if (value === "stage1" || value === "full-game") {
    return value;
  }
  errors.push("--mode must be stage1 or full-game");
  return undefined;
}

function createDetector(config: Pick<HarnessConfig, "harnessMode">): Stage1Detector | FullGameDetector {
  return config.harnessMode === "full-game" ? new FullGameDetector() : new Stage1Detector();
}

function isLlmProvider(value: string | undefined): value is Extract<AiProvider, "openai"> {
  return value === "openai";
}

function hasProviderApiKey(env: NodeJS.ProcessEnv): boolean {
  if (env.AI_PROVIDER === "openai") {
    return env.OPENAI_API_KEY !== undefined;
  }
  return true;
}

function parsePositiveInteger(value: string | undefined, name: string, errors: string[]): number | undefined {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    errors.push(`${name} must be a positive integer`);
    return undefined;
  }
  return parsed;
}

function parseNonEmpty(value: string | undefined, name: string, errors: string[]): string | undefined {
  if (value === undefined || value.trim().length === 0) {
    errors.push(`${name} must not be empty`);
    return undefined;
  }
  return value;
}

function isHarnessCommand(value: string): value is HarnessCommand {
  return value === "snapshot" || value === "preflight" || value === "run" || value === "press" || value === "smoke" || value === "dashboard" || value === "map-heuristic" || value === "scout" || value === "synthesize-policy" || value === "play-policy" || value === "strategy-loop" || value === "strategy-bg" || value === "movement-monitor" || value === "movement-monitor-bg" || value === "status" || value === "play" || value === "llm" || value === "ui" || value === "doctor" || value === "stop" || value === "clean-failed";
}

interface MutableCliOptions {
  command?: HarnessCommand;
  dryRun: boolean;
  help: boolean;
  policy?: AiProvider;
  mode?: HarnessMode;
  maxSteps?: number;
  runId?: string;
  pressButton?: string;
  pressFrames?: number;
  dashboardPort?: number;
  withDashboard: boolean;
  yes: boolean;
  fromRun?: string;
  policyId?: string;
  policyFile?: string;
  objective?: string;
  iterations?: number;
  pollMs?: number;
  llmEvery?: number;
  runIdPrefix?: string;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
