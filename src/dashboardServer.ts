import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readLatestMovementFeedback } from "./agent/MovementMonitor.js";
import { synthesizeGeneratedPolicy } from "./ai/generatedPolicy/PolicySynthesis.js";
import type { AiProvider, HarnessConfig, HarnessMode } from "./config.js";
import { evaluateAgentRun } from "./evaluation/RunEvaluation.js";
import { redactSecrets } from "./evidence/EvidenceRecorder.js";
import { MgbaHttpClient } from "./mgba/MgbaHttpClient.js";
import { wIsInBattle } from "./pokemon/memoryMap.js";
import { PokemonStateReader } from "./pokemon/PokemonStateReader.js";
import { validateWorldKnowledgeUpdate } from "./pokemon/WorldKnowledgeUpdate.js";

export type DashboardSpawnHarness = (args: readonly string[], env: NodeJS.ProcessEnv) => ChildProcess;

export interface DashboardOptions {
  readonly config: HarnessConfig;
  readonly port?: number;
  readonly host?: string;
  readonly spawnHarness?: DashboardSpawnHarness;
  readonly battleVisualSettleMs?: number;
}

export interface DashboardHandle {
  readonly url: string;
  close(): Promise<void>;
}

const DEFAULT_DASHBOARD_PORT = 3030;
const MAX_EVENTS = 200;
const DEFAULT_BATTLE_VISUAL_SETTLE_MS = 1_200;

export async function startDashboard(options: DashboardOptions): Promise<DashboardHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? DEFAULT_DASHBOARD_PORT;
  const client = new MgbaHttpClient({ baseUrl: options.config.mgbaHttpBaseUrl });
  const stateReader = new PokemonStateReader({ client, version: options.config.pokemonVersion });
  const evidenceDir = path.resolve(options.config.evidenceDir);
  const liveDir = path.join(evidenceDir, ".dashboard-live");
  const battleVisualSettler = new BattleVisualSettler(options.battleVisualSettleMs ?? DEFAULT_BATTLE_VISUAL_SETTLE_MS);
  await mkdir(liveDir, { recursive: true });

  const control = new DashboardControl({ config: { ...options.config, evidenceDir }, spawnHarness: options.spawnHarness });
  const server = createServer((request, response) => {
    void routeRequest({ request, response, config: { ...options.config, evidenceDir }, client, stateReader, liveDir, control, battleVisualSettler });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;

  return {
    url: `http://${host}:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      void control.stop().finally(() => server.close((error) => error === undefined ? resolve() : reject(error)));
    })
  };
}

async function routeRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  config: HarnessConfig;
  client: MgbaHttpClient;
  stateReader: PokemonStateReader;
  liveDir: string;
  control: DashboardControl;
  battleVisualSettler: BattleVisualSettler;
}): Promise<void> {
  const { request, response, config, client, stateReader, liveDir, control, battleVisualSettler } = input;
  const url = new URL(request.url ?? "/", "http://dashboard.local");

  try {
    if (url.pathname.startsWith("/api/control")) {
      await routeControlRequest({ request, response, url, config, control });
      return;
    }

    if (url.pathname.startsWith("/api/agent")) {
      await routeAgentRequest({ request, response, url, config, client, stateReader, control });
      return;
    }

    if (request.method !== "GET") {
      sendJson(response, 405, { error: "method_not_allowed" });
      return;
    }

    if (url.pathname === "/" || url.pathname === "/dashboard") {
      sendHtml(response, dashboardHtml());
      return;
    }

    if (url.pathname === "/favicon.ico") {
      sendFavicon(response);
      return;
    }

    if (url.pathname === "/api/config") {
      sendJson(response, 200, redactSecrets({
        mgbaHttpBaseUrl: config.mgbaHttpBaseUrl,
        pokemonVersion: config.pokemonVersion,
        harnessMode: config.harnessMode,
        evidenceDir: config.evidenceDir,
        aiProvider: config.aiProvider,
        openaiBaseUrl: config.aiProvider === "openai" ? config.openaiBaseUrl : undefined,
        openaiModel: config.aiProvider === "openai" ? config.openaiModel : undefined
      }));
      return;
    }

    if (url.pathname === "/api/live") {
      sendJson(response, 200, await readLiveState(client, stateReader));
      return;
    }

    if (url.pathname === "/api/screenshot" || url.pathname === "/api/screen") {
      const screenshotPath = path.join(liveDir, "latest.png");
      const servedPath = await captureLiveScreenshotOrLatestEvidence(client, screenshotPath, config.evidenceDir, {
        preferEvidence: control.isRunning(),
        battleVisualSettler
      });
      await sendFile(response, servedPath, "image/png");
      return;
    }

    if (url.pathname === "/api/runs") {
      sendJson(response, 200, await listRuns(config.evidenceDir));
      return;
    }

    const runMatch = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
    if (runMatch !== null) {
      sendJson(response, 200, await readRun(config.evidenceDir, decodeURIComponent(runMatch[1] ?? "")));
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    sendJson(response, 500, { error: "dashboard_error", detail: normalizeError(error) });
  }
}

function sendFavicon(response: ServerResponse): void {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#e7e0c7"/><rect x="10" y="14" width="44" height="34" rx="4" fill="#171b27"/><rect x="18" y="20" width="28" height="20" fill="#9bbc0f"/><circle cx="16" cy="54" r="4" fill="#d63d34"/><circle cx="28" cy="54" r="4" fill="#3d7edb"/></svg>`;
  response.writeHead(200, {
    "content-type": "image/svg+xml; charset=utf-8",
    "cache-control": "public, max-age=86400",
    "content-length": Buffer.byteLength(svg)
  });
  response.end(svg);
}


interface DashboardControlOptions {
  readonly config: HarnessConfig;
  readonly spawnHarness?: DashboardSpawnHarness;
}

type ControlRunKind = "play" | "llm" | "policy";

interface ControlRunOptions {
  readonly kind: ControlRunKind;
  readonly maxSteps?: number;
  readonly runId?: string;
  readonly mode?: HarnessMode;
  readonly policyFile?: string;
}

class DashboardControl {
  private readonly config: HarnessConfig;
  private readonly spawnHarness: DashboardSpawnHarness;
  private child: ChildProcess | undefined;
  private activeRun: { kind: ControlRunKind; runId: string; startedAt: string; pid?: number } | undefined;
  private lastRun: unknown;

  constructor(options: DashboardControlOptions) {
    this.config = options.config;
    this.spawnHarness = options.spawnHarness ?? defaultSpawnHarness;
  }

  async status(evidenceDir?: string): Promise<unknown> {
    const run = this.activeRun;
    const activeEvidence = run === undefined || evidenceDir === undefined ? undefined : await readRun(evidenceDir, run.runId);
    return buildControlStatus({ running: this.child !== undefined, activeRun: run, lastRun: this.lastRun, activeEvidence });
  }

  isRunning(): boolean {
    return this.child !== undefined;
  }

  start(options: ControlRunOptions): unknown {
    if (this.child !== undefined) {
      return { error: "run_already_active", activeRun: this.activeRun };
    }

    const policy: AiProvider = options.kind === "llm" ? "openai" : "heuristic";
    const runId = options.runId ?? `${options.kind}-${Date.now()}`;
    const args = [
      "src/index.ts",
      "run",
      "--policy",
      policy,
      "--mode",
      options.mode ?? "stage1",
      "--run-id",
      runId
    ];
    if (options.maxSteps !== undefined) {
      args.push("--max-steps", String(options.maxSteps));
    }
    if (options.policyFile !== undefined) {
      args.push("--policy-file", options.policyFile);
    }

    const env = {
      ...process.env,
      AI_PROVIDER: policy,
      HARNESS_MODE: options.mode ?? "stage1",
      HARNESS_RUN_ID: runId,
      EVIDENCE_DIR: this.config.evidenceDir,
      GENERATED_POLICY_FILE: options.policyFile
    };
    const child = this.spawnHarness(args, env);
    this.child = child;
    this.activeRun = { kind: options.kind, runId, startedAt: new Date().toISOString(), pid: child.pid };
    child.once("exit", (code, signal) => {
      this.lastRun = { ...this.activeRun, completedAt: new Date().toISOString(), code, signal };
      this.child = undefined;
      this.activeRun = undefined;
    });

    return { started: true, activeRun: this.activeRun };
  }

  async stop(): Promise<unknown> {
    const child = this.child;
    const activeRun = this.activeRun;
    if (child === undefined) {
      return { stopped: false, reason: "no_active_run" };
    }

    child.kill("SIGTERM");
    this.child = undefined;
    this.lastRun = { ...activeRun, completedAt: new Date().toISOString(), signal: "SIGTERM" };
    this.activeRun = undefined;
    return { stopped: true, run: activeRun };
  }

  async cleanFailed(): Promise<unknown> {
    const removed: Array<{ runId: string; status: string }> = [];
    const entries = await readdir(this.config.evidenceDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }
      const runDir = path.join(this.config.evidenceDir, entry.name);
      const summary = summaryObject(await readJsonIfExists(path.join(runDir, "summary.json")));
      const status = typeof summary.status === "string" ? summary.status : "missing_summary";
      if (status !== "completed") {
        await rm(runDir, { force: true, recursive: true });
        removed.push({ runId: entry.name, status });
      }
    }
    return { removed };
  }
}

function defaultSpawnHarness(args: readonly string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn("./node_modules/.bin/tsx", args, {
    cwd: process.cwd(),
    env,
    stdio: "ignore"
  });
}

async function routeControlRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  config: HarnessConfig;
  control: DashboardControl;
}): Promise<void> {
  const { request, response, url, config, control } = input;
  if (request.method === "GET" && url.pathname === "/api/control/status") {
    sendJson(response, 200, await control.status(config.evidenceDir));
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { error: "method_not_allowed" });
    return;
  }

  const body = await readJsonBody(request);
  if (url.pathname === "/api/control/play") {
    const result = control.start({ kind: "play", maxSteps: positiveNumberField(body, "maxSteps"), runId: stringField(body, "runId"), mode: modeField(body) });
    sendJson(response, objectField(result, "error") === undefined ? 202 : 409, result);
    return;
  }

  if (url.pathname === "/api/control/llm") {
    const result = control.start({ kind: "llm", maxSteps: positiveNumberField(body, "maxSteps"), runId: stringField(body, "runId"), mode: modeField(body), policyFile: stringField(body, "policyFile") });
    sendJson(response, objectField(result, "error") === undefined ? 202 : 409, result);
    return;
  }

  if (url.pathname === "/api/control/press") {
    const button = stringField(body, "button");
    const frames = positiveNumberField(body, "frames");
    if (button === undefined) {
      sendJson(response, 400, { error: "missing_button" });
      return;
    }
    const args = ["src/index.ts", "press", button];
    if (frames !== undefined) {
      args.push("--frames", String(frames));
    }
    const child = defaultSpawnHarness(args, process.env);
    sendJson(response, 202, { started: true, command: "press", pid: child.pid, button, frames });
    return;
  }

  if (url.pathname === "/api/control/stop") {
    sendJson(response, 200, await control.stop());
    return;
  }

  if (url.pathname === "/api/control/clean-failed") {
    sendJson(response, 200, await control.cleanFailed());
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

async function routeAgentRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  config: HarnessConfig;
  client: MgbaHttpClient;
  stateReader: PokemonStateReader;
  control: DashboardControl;
}): Promise<void> {
  const { request, response, url, config, client, stateReader, control } = input;

  if (request.method === "GET" && url.pathname === "/api/agent/observation") {
    const live = await readLiveState(client, stateReader);
    sendJson(response, 200, redactSecrets({ schema: "pokemon-agent-observation.v1", control: await control.status(config.evidenceDir), live }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/agent/movement-feedback") {
    sendJson(response, 200, await readLatestMovementFeedback(config.evidenceDir) ?? { schema: "pokemon-movement-feedback.v1", status: "missing" });
    return;
  }

  const evaluateMatch = /^\/api\/agent\/evaluate\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && evaluateMatch !== null) {
    sendJson(response, 200, summarizeRunForAgent(await readRun(config.evidenceDir, decodeURIComponent(evaluateMatch[1] ?? ""))));
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { error: "method_not_allowed" });
    return;
  }

  const body = await readJsonBody(request);
  if (url.pathname === "/api/agent/world-update") {
    const update = validateWorldKnowledgeUpdate(body);
    if (update === undefined) {
      sendJson(response, 400, { error: "invalid_world_update", schema: "pokemon-world-update.v1" });
      return;
    }
    sendJson(response, 200, await recordWorldKnowledgeUpdate(config.evidenceDir, update));
    return;
  }

  if (url.pathname === "/api/agent/run") {
    const requestedPolicy = stringField(body, "policy");
    const policyFile = stringField(body, "policyFile");
    if (requestedPolicy !== undefined && !["heuristic", "openai", "generated"].includes(requestedPolicy)) {
      sendJson(response, 400, { error: "unsupported_policy", allowed: ["heuristic", "openai", "generated"] });
      return;
    }
    if (requestedPolicy === "generated" && policyFile === undefined) {
      sendJson(response, 400, { error: "missing_policy_file" });
      return;
    }
    const kind: ControlRunKind = requestedPolicy === "openai" ? "llm" : policyFile !== undefined || requestedPolicy === "generated" ? "policy" : "play";
    const result = control.start({
      kind,
      maxSteps: positiveNumberField(body, "maxSteps"),
      runId: stringField(body, "runId"),
      mode: modeField(body),
      policyFile
    });
    sendJson(response, objectField(result, "error") === undefined ? 202 : 409, result);
    return;
  }

  if (url.pathname === "/api/agent/synthesize-policy") {
    const fromRun = stringField(body, "fromRun");
    const policyId = stringField(body, "policyId");
    if (fromRun === undefined || policyId === undefined) {
      sendJson(response, 400, { error: "missing_from_run_or_policy_id" });
      return;
    }
    sendJson(response, 200, await synthesizeGeneratedPolicy({
      evidenceDir: config.evidenceDir,
      fromRun,
      policyId,
      objective: stringField(body, "objective"),
      outputFile: stringField(body, "policyFile")
    }));
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

function buildControlStatus(input: { readonly running: boolean; readonly activeRun: unknown; readonly lastRun: unknown; readonly activeEvidence?: unknown }): unknown {
  const summary = summaryObject(objectField(input.activeEvidence, "summary"));
  const lastAction = summaryObject(objectField(input.activeEvidence, "lastAction"));
  const lastDecision = summaryObject(objectField(input.activeEvidence, "lastDecision"));
  const improvementLog = Array.isArray(objectField(input.activeEvidence, "improvementLog")) ? objectField(input.activeEvidence, "improvementLog") as unknown[] : [];
  const lastTelemetry = summaryObject(improvementLog.at(-1));
  const activeRun = input.activeRun === undefined ? undefined : {
    ...summaryObject(input.activeRun),
    summaryStatus: stringField(summary, "status"),
    counts: objectField(summary, "counts"),
    lastAction: objectField(lastAction, "payload") ?? lastAction,
    lastDecision: objectField(lastDecision, "payload") ?? lastDecision,
    latestTelemetry: lastTelemetry.step === undefined && lastTelemetry.frame === undefined ? undefined : lastTelemetry
  };

  return {
    schema: "pokemon-control-status.v1",
    running: input.running,
    activeRun,
    lastRun: input.lastRun
  };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text.length === 0) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function recordWorldKnowledgeUpdate(evidenceDir: string, update: unknown): Promise<unknown> {
  const now = new Date().toISOString();
  const dir = path.join(evidenceDir, ".world-updates");
  const event = redactSecrets({ type: "world_update", timestamp: now, payload: update });
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
  return { schema: "pokemon-world-update-ack.v1", accepted: true, stored: path.join(dir, "events.jsonl") };
}

function positiveNumberField(value: unknown, key: string): number | undefined {
  const field = objectField(value, key);
  return typeof field === "number" && Number.isInteger(field) && field > 0 ? field : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  const field = objectField(value, key);
  return typeof field === "string" && field.trim().length > 0 ? field : undefined;
}

function modeField(value: unknown): HarnessMode | undefined {
  const mode = stringField(value, "mode");
  return mode === "stage1" || mode === "full-game" ? mode : undefined;
}

async function captureLiveScreenshotOrLatestEvidence(
  client: MgbaHttpClient,
  liveScreenshotPath: string,
  evidenceDir: string,
  options: {
    readonly preferEvidence?: boolean;
    readonly battleVisualSettler?: BattleVisualSettler;
  } = {}
): Promise<string> {
  const shouldPreferEvidenceFirst = options.preferEvidence === true && options.battleVisualSettler === undefined;
  if (shouldPreferEvidenceFirst) {
    const latest = await findLatestEvidenceScreenshot(evidenceDir);
    if (latest !== undefined) {
      return latest;
    }
  }

  try {
    await options.battleVisualSettler?.settleBeforeScreenshot(client);
    return await client.screenshot(liveScreenshotPath);
  } catch (error) {
    const latest = await findLatestEvidenceScreenshot(evidenceDir);
    if (latest !== undefined) {
      return latest;
    }

    throw error;
  }
}

class BattleVisualSettler {
  private wasInBattle = false;

  constructor(private readonly settleMs: number) {}

  async settleBeforeScreenshot(client: MgbaHttpClient): Promise<void> {
    if (this.settleMs <= 0) {
      return;
    }

    const battleFlag = await client.read8(wIsInBattle).catch(() => undefined);
    if (battleFlag === undefined) {
      return;
    }

    const inBattle = battleFlag !== 0;

    if (!inBattle) {
      this.wasInBattle = false;
      return;
    }

    if (this.wasInBattle) {
      return;
    }

    this.wasInBattle = true;
    await sleep(this.settleMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findLatestEvidenceScreenshot(evidenceDir: string): Promise<string | undefined> {
  const runEntries = await readdir(evidenceDir, { withFileTypes: true }).catch(() => []);
  const metadataFiles: Array<{ file: string; mtimeMs: number }> = [];

  await Promise.all(runEntries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map(async (entry) => {
      const screenshotsDir = path.join(evidenceDir, entry.name, "screenshots");
      const files = await readdir(screenshotsDir, { withFileTypes: true }).catch(() => []);
      await Promise.all(files
        .filter((file) => file.isFile() && file.name.endsWith(".json"))
        .map(async (file) => {
          const metadataFile = path.join(screenshotsDir, file.name);
          const stats = await stat(metadataFile).catch(() => undefined);
          if (stats !== undefined) {
            metadataFiles.push({ file: metadataFile, mtimeMs: stats.mtimeMs });
          }
        }));
    }));

  for (const candidate of metadataFiles.sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    const metadata = await readJsonIfExists(candidate.file);
    const screenshotPath = summaryObject(metadata).path;
    if (typeof screenshotPath === "string" && await fileExists(screenshotPath)) {
      return screenshotPath;
    }
  }

  return undefined;
}

async function fileExists(file: string): Promise<boolean> {
  return stat(file).then((stats) => stats.isFile(), () => false);
}

async function readLiveState(client: MgbaHttpClient, stateReader: PokemonStateReader): Promise<unknown> {
  const [frame, state] = await Promise.all([
    client.currentFrame(),
    stateReader.readState()
  ]);

  return { frame, state, readAt: new Date().toISOString() };
}

async function listRuns(evidenceDir: string): Promise<unknown> {
  const entries = await readdir(evidenceDir, { withFileTypes: true }).catch(() => []);
  const runs = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map(async (entry) => {
      const runDir = path.join(evidenceDir, entry.name);
      const summary = await readJsonIfExists(path.join(runDir, "summary.json"));
      const eventsFile = path.join(runDir, "events.jsonl");
      const stats = await stat(eventsFile).catch(() => undefined);
      return {
        runId: entry.name,
        status: summaryObject(summary).status,
        startedAt: summaryObject(summary).startedAt,
        finishedAt: summaryObject(summary).finishedAt,
        counts: summaryObject(summary).counts,
        eventsMtimeMs: stats?.mtimeMs ?? 0
      };
    }));

  return runs.sort((a, b) => b.eventsMtimeMs - a.eventsMtimeMs);
}

async function readRun(evidenceDir: string, runId: string): Promise<unknown> {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    return { error: "invalid_run_id" };
  }

  const runDir = path.join(evidenceDir, runId);
  const summary = await readJsonIfExists(path.join(runDir, "summary.json"));
  const config = await readJsonIfExists(path.join(runDir, "config.json"));
  const events = await readJsonlTail(path.join(runDir, "events.jsonl"), MAX_EVENTS);
  const lastStateEvent = [...events].reverse().find((event) => objectField(event, "type") === "state");
  const lastDecision = [...events].reverse().find((event) => objectField(event, "type") === "decision");
  const lastAction = [...events].reverse().find((event) => objectField(event, "type") === "action");
  const telemetry = events.filter((event) => objectField(event, "type") === "pokemon_telemetry");
  const improvementLog = telemetry.map(toImprovementLogEntry).filter((entry) => entry !== undefined);

  return redactSecrets({ runId, config, summary, events, lastStateEvent, lastDecision, lastAction, telemetry, improvementLog });
}

function summarizeRunForAgent(run: unknown): unknown {
  const summary = summaryObject(objectField(run, "summary"));
  const improvementLog = Array.isArray(objectField(run, "improvementLog")) ? objectField(run, "improvementLog") as unknown[] : [];

  return redactSecrets(evaluateAgentRun({
    runId: objectField(run, "runId"),
    summary,
    lastDecision: objectField(run, "lastDecision"),
    lastAction: objectField(run, "lastAction"),
    improvementLog
  }));
}

async function readJsonIfExists(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

async function readJsonlTail(file: string, limit: number): Promise<unknown[]> {
  try {
    const text = await readFile(file, "utf8");
    return text.trim().split("\n").filter(Boolean).slice(-limit).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { type: "invalid_jsonl", line };
      }
    });
  } catch {
    return [];
  }
}

function toImprovementLogEntry(event: unknown): unknown {
  const payload = objectField(event, "payload");
  if (payload === undefined) {
    return undefined;
  }

  return {
    step: objectField(payload, "step"),
    frame: objectField(payload, "frame"),
    categories: objectField(payload, "categories"),
    route: objectField(payload, "route"),
    location: objectField(payload, "location"),
    action: objectField(objectField(payload, "decision"), "action"),
    confidence: objectField(objectField(payload, "decision"), "confidence"),
    progress: objectField(payload, "progress"),
    improvementSignals: objectField(payload, "improvementSignals"),
    text: objectField(payload, "text"),
    battle: objectField(payload, "battle")
  };
}

function summaryObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function objectField(value: unknown, field: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[field] : undefined;
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(body);
}

function sendHtml(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(body);
}

async function sendFile(response: ServerResponse, file: string, contentType: string): Promise<void> {
  await stat(file);
  response.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  await new Promise<void>((resolve, reject) => {
    createReadStream(file).once("error", reject).once("end", resolve).pipe(response);
  });
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Poke Pi mGBA Console</title>
  <style>
    :root {
      color-scheme: dark;
      --shell: #e7e0c7;
      --shell-shadow: #9f977c;
      --bezel: #171b27;
      --bezel-deep: #070913;
      --screen-glow: #b8f986;
      --lcd: #9bbc0f;
      --lcd-dark: #0f380f;
      --pokedex: #d63d34;
      --link-blue: #3d7edb;
      --cart-yellow: #f4c542;
      --ink: #f7f0d5;
      --muted: #b8ad8d;
      --panel: #262b3b;
      --panel-2: #1b2030;
      --line: #5b6174;
      --line-soft: #363b4b;
      --ok: #79d86b;
      --warn: #ffd166;
      --danger: #ff665c;
      font-family: "Trebuchet MS", "Avenir Next", Verdana, sans-serif;
      background: #080a12;
      color: var(--ink);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at 16% 10%, rgb(155 188 15 / 0.16), transparent 24%),
        radial-gradient(circle at 84% 0%, rgb(214 61 52 / 0.14), transparent 25%),
        linear-gradient(135deg, #111523 0%, #070912 52%, #13100c 100%);
      overflow: hidden;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      opacity: 0.18;
      background-image: linear-gradient(rgb(255 255 255 / 0.09) 1px, transparent 1px), linear-gradient(90deg, rgb(255 255 255 / 0.07) 1px, transparent 1px);
      background-size: 18px 18px;
      mask-image: radial-gradient(circle at center, #000 0%, transparent 76%);
    }
    header {
      height: 64px;
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: center;
      padding: 0 22px;
      border-bottom: 4px solid #06070b;
      background: linear-gradient(180deg, #f5ecd1, var(--shell));
      color: #1c2030;
      box-shadow: inset 0 -1px 0 #fff6d6, 0 10px 28px rgb(0 0 0 / 0.34);
    }
    h1 { font-size: 18px; margin: 0; letter-spacing: 0.08em; text-transform: uppercase; }
    .muted { color: var(--muted); }
    header .muted { color: #6d644d; }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 2px solid #182011;
      padding: 6px 12px;
      border-radius: 999px;
      color: var(--lcd-dark);
      background: linear-gradient(180deg, #c6f36d, var(--lcd));
      box-shadow: inset 0 -2px 0 rgb(15 56 15 / 0.22), 0 2px 0 var(--shell-shadow);
      font: 700 12px/1.1 ui-monospace, SFMono-Regular, Menlo, monospace;
      text-transform: uppercase;
    }
    .console { height: calc(100vh - 64px); display: grid; grid-template-columns: minmax(640px, 1fr) 450px; gap: 18px; padding: 18px; }
    .viewport {
      min-width: 0;
      display: flex;
      flex-direction: column;
      padding: 20px;
      gap: 14px;
      background: linear-gradient(145deg, #ded4b7, #bdb292);
      border: 4px solid #0a0c12;
      border-radius: 28px 28px 48px 28px;
      box-shadow: inset 0 3px 0 #fff4cf, inset -8px -10px 0 rgb(87 81 62 / 0.25), 0 28px 80px rgb(0 0 0 / 0.42);
    }
    .screenWrap {
      position: relative;
      flex: 1;
      min-height: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: radial-gradient(circle at center, #252b38, var(--bezel-deep));
      border: 12px solid var(--bezel);
      border-bottom-width: 26px;
      border-radius: 22px 22px 44px 22px;
      box-shadow: inset 0 0 0 2px #343a4a, inset 0 0 34px rgb(0 0 0 / 0.65), 0 14px 0 rgb(81 76 60 / 0.38);
      overflow: hidden;
    }
    .screenWrap::before {
      content: "DOT MATRIX WITH STEREO SOUND";
      position: absolute;
      top: 10px;
      left: 18px;
      color: #8b91a7;
      font: 700 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: 0.16em;
      z-index: 1;
    }
    .screenWrap::after {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: linear-gradient(rgb(255 255 255 / 0.05) 50%, transparent 50%);
      background-size: 100% 4px;
      mix-blend-mode: screen;
    }
    .screen {
      width: min(calc(100vh * 1.142 - 170px), 94%);
      max-height: 84%;
      aspect-ratio: 256 / 224;
      object-fit: contain;
      image-rendering: pixelated;
      image-rendering: crisp-edges;
      background: #061006;
      border: 4px solid #050706;
      border-radius: 6px;
      box-shadow: 0 0 0 8px #7d9855, 0 0 34px rgb(184 249 134 / 0.22);
    }
    .hud { display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); gap: 9px; }
    .metric {
      background: linear-gradient(180deg, #fbf0ca, #d8cca8);
      border: 2px solid #171a24;
      border-radius: 10px;
      padding: 10px;
      min-width: 0;
      color: #171a24;
      box-shadow: inset 0 -3px 0 rgb(64 56 38 / 0.12), 0 3px 0 rgb(0 0 0 / 0.22);
    }
    .metric .label { color: #6f653f; font: 700 10px/1.1 ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; letter-spacing: 0.08em; }
    .metric strong { display: block; margin-top: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; }
    aside {
      min-width: 0;
      background: linear-gradient(180deg, #202638, #151a29);
      border: 4px solid #090b11;
      border-radius: 22px;
      padding: 14px;
      overflow: auto;
      box-shadow: inset 0 0 0 2px var(--line-soft), 0 24px 70px rgb(0 0 0 / 0.38);
    }
    section {
      position: relative;
      background: linear-gradient(180deg, var(--panel), var(--panel-2));
      border: 2px solid var(--line);
      border-radius: 14px;
      padding: 13px;
      margin-bottom: 12px;
      box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.06), 0 5px 0 rgb(0 0 0 / 0.22);
    }
    section::before {
      content: "";
      position: absolute;
      top: 12px;
      right: 12px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--pokedex);
      box-shadow: -14px 0 0 var(--cart-yellow), -28px 0 0 var(--link-blue);
      opacity: 0.8;
    }
    h2, h3 { margin: 0 0 10px; font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: #fff3cb; }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      overflow: auto;
      max-height: 260px;
      background: linear-gradient(180deg, #13240f, #071107);
      border: 2px solid #071007;
      border-radius: 10px;
      padding: 10px;
      color: #c8f18d;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
      box-shadow: inset 0 0 0 2px rgb(155 188 15 / 0.18);
    }
    input, select, button {
      background: #eee2bd;
      color: #171a24;
      border: 2px solid #11141d;
      border-radius: 9px;
      padding: 8px 10px;
      max-width: 100%;
      box-shadow: inset 0 -2px 0 rgb(65 58 40 / 0.18), 0 2px 0 rgb(0 0 0 / 0.22);
    }
    input { min-width: 0; }
    button { cursor: pointer; font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em; transition: transform 120ms ease, box-shadow 120ms ease, filter 120ms ease; }
    button:hover { transform: translateY(-1px); filter: brightness(1.06); box-shadow: inset 0 -2px 0 rgb(65 58 40 / 0.18), 0 4px 0 rgb(0 0 0 / 0.24); }
    button:active { transform: translateY(1px); box-shadow: inset 0 2px 0 rgb(0 0 0 / 0.2); }
    button.danger { background: linear-gradient(180deg, #ff8a82, var(--pokedex)); color: #210706; }
    button.ok { background: linear-gradient(180deg, #c7f390, var(--lcd)); color: var(--lcd-dark); }
    .field { display: grid; gap: 4px; flex: 1 1 120px; }
    .field label { color: #d6ca9b; font: 700 10px/1.1 ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; letter-spacing: 0.08em; }
    .events { max-height: 360px; overflow: auto; display: flex; flex-direction: column; gap: 8px; }
    .event { border-left: 5px solid var(--link-blue); padding: 8px 10px; background: #111827; border-radius: 8px; font-size: 12px; box-shadow: inset 0 0 0 1px var(--line-soft); }
    .event.action { border-color: var(--ok); }
    .event.decision { border-color: var(--warn); }
    .event.error { border-color: var(--danger); }
    .toolbar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    ::selection { background: var(--lcd); color: var(--lcd-dark); }
    @media (max-width: 1100px) { body { overflow: auto; } .console { height: auto; grid-template-columns: 1fr; padding: 12px; } .viewport { min-height: 620px; } .hud { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  </style>
</head>
<body>
  <header>
    <div><h1>mGBA Web Console</h1><span class="muted">live game viewport with RAM + LLM harness telemetry</span></div>
    <div class="pill" id="status">starting</div>
  </header>
  <main class="console">
    <div class="viewport">
      <div class="screenWrap"><img id="screen" class="screen" alt="mGBA live screen" /></div>
      <div class="hud" id="quickState"></div>
      <div class="muted" id="screenMeta"></div>
    </div>
    <aside>
      <section>
        <h2>Control server</h2>
        <div class="toolbar">
          <div class="field"><label for="controlRunId">Run ID</label><input id="controlRunId" placeholder="auto timestamp" /></div>
          <div class="field"><label for="controlMaxSteps">Max steps</label><input id="controlMaxSteps" type="number" min="1" step="1" value="100" /></div>
          <div class="field"><label for="controlMode">Mode</label><select id="controlMode"><option value="stage1">stage1</option><option value="full-game">full-game</option></select></div>
        </div>
        <div class="toolbar" style="margin-top: 10px;">
          <button class="ok" id="controlPlay">Play heuristic</button>
          <button class="ok" id="controlLlm">LLM run</button>
          <button class="danger" id="controlStop">Stop active</button>
          <button id="controlCleanFailed">Clean failed</button>
        </div>
        <div class="hud" id="controlSummary" style="grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 10px;"></div>
        <pre id="controlResponse">ready</pre>
      </section>
      <section>
        <h2>Agent orchestration</h2>
        <p class="muted">Hermes should observe and launch policies here; it should not send direct gamepad input.</p>
        <pre>GET /api/agent/observation
GET /api/agent/evaluate/:runId
GET /api/agent/movement-feedback
POST /api/agent/synthesize-policy
POST /api/agent/run</pre>
      </section>
      <section>
        <h2>Harness run</h2>
        <div class="toolbar">
          <select id="runs"></select>
          <button id="refreshRuns">Refresh</button>
        </div>
        <div class="hud" id="runSummary" style="grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 10px;"></div>
      </section>
      <section><h3>Last LLM decision</h3><pre id="lastDecision">none</pre></section>
      <section><h3>Last button action</h3><pre id="lastAction">none</pre></section>
      <section><h3>Movement monitor feedback</h3><div class="hud" id="movementFeedbackSummary" style="grid-template-columns: repeat(2, minmax(0, 1fr));"></div><pre id="movementFeedbackDetails">waiting for external monitor...</pre></section>
      <section><h3>Improvement log</h3><div class="events" id="improvementLog"></div></section>
      <section><h3>Map structure</h3><div class="hud" id="mapSummary" style="grid-template-columns: repeat(2, minmax(0, 1fr));"></div><pre id="mapCandidates">waiting for RAM...</pre></section>
      <section><h3>Live RAM snapshot</h3><pre id="liveState">loading...</pre></section>
      <section><h3>Recent events</h3><div class="events" id="events"></div></section>
    </aside>
  </main>
<script>
const $ = (id) => document.getElementById(id);
let selectedRun = null;
let config = null;
let lastScreenOkAt = null;
let screenInFlight = false;

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(url + ' -> ' + res.status);
  return res.json();
}
async function postJson(url, body = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(url + ' -> ' + res.status + ' ' + j(data));
  return data;
}
function j(value) { return JSON.stringify(value ?? null, null, 2); }
function setStatus(text, ok = true) { $('status').textContent = text; $('status').style.borderColor = ok ? '#3c8f66' : '#a34b4b'; }
function compactState(s) {
  return {
    frame: s?.frame,
    map: s?.state?.wCurMap,
    x: s?.state?.wXCoord,
    y: s?.state?.wYCoord,
    facing: s?.state?.playerFacingDirection,
    battle: s?.state?.battle?.kind,
    party: s?.state?.wPartyCount,
    text: s?.state?.screenTextKind
  };
}
function renderMetrics(id, obj) {
  $(id).innerHTML = Object.entries(obj ?? {}).map(([k,v]) => '<div class="metric"><div class="label">' + escapeHtml(k) + '</div><strong>' + escapeHtml(String(v ?? '')) + '</strong></div>').join('');
}
function runRequestBody(kind) {
  const runId = $('controlRunId').value.trim() || kind + '-' + Date.now();
  const maxSteps = Number($('controlMaxSteps').value || 100);
  return { runId, maxSteps, mode: $('controlMode').value };
}
async function refreshControl() {
  const control = await getJson('/api/control/status');
  const active = control.activeRun;
  renderMetrics('controlSummary', {
    running: control.running ? 'yes' : 'no',
    active: active?.runId ?? 'none',
    kind: active?.kind ?? control.lastRun?.kind ?? 'none',
    pid: active?.pid ?? 'none',
    status: active?.summaryStatus ?? (control.running ? 'running' : 'idle'),
    states: active?.counts?.states ?? 'none',
    actions: active?.counts?.actions ?? 'none',
    step: active?.latestTelemetry?.step ?? 'none',
    last: control.lastRun?.runId ?? 'none',
    signal: control.lastRun?.signal ?? control.lastRun?.code ?? 'none'
  });
  if (active?.runId !== undefined && selectedRun !== active.runId) {
    selectedRun = active.runId;
  }
  return control;
}
async function controlStart(kind) {
  const body = runRequestBody(kind);
  $('controlResponse').textContent = 'starting ' + kind + '...';
  const result = await postJson('/api/control/' + kind, body);
  selectedRun = body.runId;
  $('controlResponse').textContent = j(result);
  await refreshControl();
  await refreshRuns();
}
async function controlStop() {
  $('controlResponse').textContent = 'stopping...';
  const result = await postJson('/api/control/stop');
  $('controlResponse').textContent = j(result);
  await refreshControl();
  await refreshRuns();
}
async function controlCleanFailed() {
  $('controlResponse').textContent = 'cleaning failed runs...';
  const result = await postJson('/api/control/clean-failed');
  $('controlResponse').textContent = j(result);
  await refreshRuns();
}
function renderMapStructure(live) {
  const map = live?.state?.mapStructure;
  if (!map) {
    renderMetrics('mapSummary', { available: 'no' });
    $('mapCandidates').textContent = 'map RAM unavailable';
    return;
  }
  renderMetrics('mapSummary', {
    available: 'yes',
    size: String(map.width ?? '?') + 'x' + String(map.height ?? '?'),
    tileset: map.tileset ?? '?',
    block: map.currentBlockId ?? map.currentBlock?.id ?? '?',
    semantic: map.currentBlockSemantic?.kind ?? '?',
    walkability: map.currentBlockSemantic?.walkability ?? '?',
    row: map.currentBlockRow ?? map.currentBlock?.row ?? '?',
    col: map.currentBlockCol ?? map.currentBlock?.col ?? '?',
    pointer: map.currentViewPointer ?? '?'
  });
  $('mapCandidates').textContent = j({
    currentBlock: { id: map.currentBlockId, row: map.currentBlockRow, col: map.currentBlockCol, semantic: map.currentBlockSemantic },
    directionCandidates: map.directionCandidates,
    semanticVisibleBlocks: map.semanticVisibleBlocks,
    visibleBlocks: map.visibleBlocks
  });
}
async function refreshConfig() { config = await getJson('/api/config'); }
function refreshScreen() {
  if (screenInFlight) return;
  screenInFlight = true;
  const img = $('screen');
  img.onload = () => { screenInFlight = false; lastScreenOkAt = new Date(); $('screenMeta').textContent = 'screen refreshed · ' + lastScreenOkAt.toLocaleTimeString(); };
  img.onerror = () => { screenInFlight = false; setStatus('screen unavailable', false); };
  img.src = '/api/screen?t=' + Date.now();
}
async function refreshLive() {
  const live = await getJson('/api/live');
  renderMetrics('quickState', compactState(live));
  renderMapStructure(live);
  $('liveState').textContent = j(live.state);
  if (lastScreenOkAt) $('screenMeta').textContent = 'frame ' + live.frame + ' · screen ' + lastScreenOkAt.toLocaleTimeString() + ' · state ' + live.readAt;
}
async function refreshMovementFeedback() {
  const feedback = await getJson('/api/agent/movement-feedback');
  renderMetrics('movementFeedbackSummary', {
    status: feedback.status ?? 'available',
    run: feedback.runId ?? 'none',
    quality: feedback.movementQuality ?? 'unknown',
    recommendation: feedback.recommendation ?? 'none'
  });
  $('movementFeedbackDetails').textContent = j({ counts: feedback.counts, recentExperiences: feedback.recentExperiences });
}
async function refreshRuns() {
  const runs = await getJson('/api/runs');
  if (!selectedRun && runs[0]) selectedRun = runs[0].runId;
  $('runs').innerHTML = runs.map(r => '<option value="' + escapeHtml(r.runId) + '" ' + (r.runId === selectedRun ? 'selected' : '') + '>' + escapeHtml(r.runId + ' · ' + (r.status ?? 'running/unknown')) + '</option>').join('');
  if (selectedRun) await refreshRun();
}
async function refreshRun() {
  if (!selectedRun) return;
  const run = await getJson('/api/runs/' + encodeURIComponent(selectedRun));
  renderMetrics('runSummary', { status: run.summary?.status ?? 'running/unknown', states: run.summary?.counts?.states, decisions: run.summary?.counts?.decisions, actions: run.summary?.counts?.actions });
  $('lastDecision').textContent = j(run.lastDecision?.payload ?? run.lastDecision);
  $('lastAction').textContent = j(run.lastAction?.payload ?? run.lastAction);
  $('improvementLog').innerHTML = (run.improvementLog ?? []).slice(-80).reverse().map(e => '<div class="event ' + escapeHtml((e.improvementSignals ?? [])[0] ?? 'pokemon_telemetry') + '"><strong>step ' + escapeHtml(e.step ?? '') + ' · ' + escapeHtml(e.route ?? '') + '</strong><div class="muted">' + escapeHtml((e.categories ?? []).join(', ')) + '</div><pre>' + escapeHtml(j({location:e.location, action:e.action, confidence:e.confidence, signals:e.improvementSignals, progress:e.progress, text:e.text, battle:e.battle}).slice(0, 1400)) + '</pre></div>').join('');
  $('events').innerHTML = (run.events ?? []).slice(-80).reverse().map(e => '<div class="event ' + escapeHtml(e.type ?? '') + '"><strong>' + escapeHtml(e.type ?? 'event') + '</strong> <span class="muted">' + escapeHtml(String(e.sequence ?? '')) + ' ' + escapeHtml(e.timestamp ?? '') + '</span><pre>' + escapeHtml(j(e.payload).slice(0, 1400)) + '</pre></div>').join('');
}
function escapeHtml(text) { return String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
$('runs').addEventListener('change', () => { selectedRun = $('runs').value; void refreshRun(); });
$('refreshRuns').addEventListener('click', () => void refreshRuns());
$('controlPlay').addEventListener('click', () => void controlStart('play').catch(e => { setStatus(String(e), false); $('controlResponse').textContent = String(e); }));
$('controlLlm').addEventListener('click', () => void controlStart('llm').catch(e => { setStatus(String(e), false); $('controlResponse').textContent = String(e); }));
$('controlStop').addEventListener('click', () => void controlStop().catch(e => { setStatus(String(e), false); $('controlResponse').textContent = String(e); }));
$('controlCleanFailed').addEventListener('click', () => void controlCleanFailed().catch(e => { setStatus(String(e), false); $('controlResponse').textContent = String(e); }));
(async function main() {
  try { await refreshConfig(); await refreshControl(); await refreshMovementFeedback(); await refreshRuns(); refreshScreen(); setStatus('connected to ' + config.mgbaHttpBaseUrl); }
  catch (e) { setStatus(String(e), false); }
  setInterval(refreshScreen, 1000);
  setInterval(() => refreshLive().then(() => setStatus('live')).catch(e => setStatus('RAM unavailable; screen may use latest frame', false)), 2500);
  setInterval(() => refreshControl().catch(e => setStatus(String(e), false)), 2000);
  setInterval(() => refreshMovementFeedback().catch(e => setStatus(String(e), false)), 2000);
  setInterval(() => refreshRuns().catch(e => setStatus(String(e), false)), 3500);
})();
</script>
</body>
</html>`;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // This module is normally started through src/index.ts.
}
