import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface MovementMonitorOptions {
  readonly evidenceDir: string;
  readonly baseUrl: string;
  readonly pollMs: number;
  readonly iterations: number;
  readonly outputDir?: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly request?: (baseUrl: string, path: string) => Promise<{ status: number; body: unknown }>;
  readonly log?: (event: MovementMonitorEvent) => void;
}

export interface MovementMonitorEvent {
  readonly type: string;
  readonly runId?: string;
  readonly feedback?: MovementFeedback;
  readonly detail?: unknown;
}

export interface MovementFeedback {
  readonly schema: "pokemon-movement-feedback.v1";
  readonly runId: string;
  readonly updatedAt: string;
  readonly counts: Record<string, number>;
  readonly movementQuality: "moving" | "blocked" | "idle" | "transitioning" | "unknown";
  readonly recommendation: string;
  readonly recentExperiences: readonly MovementExperience[];
}

export interface MovementExperience {
  readonly step?: number;
  readonly action?: unknown;
  readonly kind: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly delta?: unknown;
  readonly pixelChanged?: boolean;
}

const DEFAULT_SLEEP = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const DEFAULT_MOVEMENT_FEEDBACK_DIR = ".movement-feedback";

export async function runMovementMonitor(options: MovementMonitorOptions): Promise<MovementFeedback | undefined> {
  const sleep = options.sleep ?? DEFAULT_SLEEP;
  let lastFeedback: MovementFeedback | undefined;

  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    const status = await (options.request ?? defaultRequest)(options.baseUrl, "/api/control/status");
    const activeRun = objectField(status.body, "activeRun");
    const runId = typeof objectField(activeRun, "runId") === "string" ? objectField(activeRun, "runId") as string : undefined;

    if (runId !== undefined) {
      const feedback = await buildMovementFeedback(options.evidenceDir, runId);
      if (feedback !== undefined) {
        await writeMovementFeedback(options.evidenceDir, options.outputDir ?? DEFAULT_MOVEMENT_FEEDBACK_DIR, feedback);
        lastFeedback = feedback;
        options.log?.({ type: "movement_feedback", runId, feedback });
      }
    } else {
      options.log?.({ type: "idle", detail: status.body });
    }

    if (iteration < options.iterations - 1) {
      await sleep(options.pollMs);
    }
  }

  return lastFeedback;
}

export async function buildMovementFeedback(evidenceDir: string, runId: string, now: () => Date = () => new Date()): Promise<MovementFeedback | undefined> {
  const events = await readRunEvents(evidenceDir, runId);
  if (events.length === 0) {
    return undefined;
  }

  const experiences = events
    .map(toMovementExperience)
    .filter((entry): entry is MovementExperience => entry !== undefined)
    .slice(-30);
  const counts = countByKind(experiences);

  return {
    schema: "pokemon-movement-feedback.v1",
    runId,
    updatedAt: now().toISOString(),
    counts,
    movementQuality: classifyMovementQuality(counts),
    recommendation: recommendMovementAdjustment(counts),
    recentExperiences: experiences.slice(-12)
  };
}

export async function readLatestMovementFeedback(evidenceDir: string, outputDir: string = DEFAULT_MOVEMENT_FEEDBACK_DIR): Promise<MovementFeedback | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path.join(evidenceDir, outputDir, "latest.json"), "utf8")) as MovementFeedback;
    return parsed.schema === "pokemon-movement-feedback.v1" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writeMovementFeedback(evidenceDir: string, outputDir: string, feedback: MovementFeedback): Promise<void> {
  const dir = path.join(evidenceDir, outputDir);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${feedback.runId}.json`), `${JSON.stringify(feedback, null, 2)}\n`, "utf8");
  await writeFile(path.join(dir, "latest.json"), `${JSON.stringify(feedback, null, 2)}\n`, "utf8");
}

async function readRunEvents(evidenceDir: string, runId: string): Promise<unknown[]> {
  try {
    const text = await readFile(path.join(evidenceDir, runId, "events.jsonl"), "utf8");
    return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown);
  } catch {
    return [];
  }
}

function toMovementExperience(event: unknown): MovementExperience | undefined {
  const payload = objectField(event, "payload");
  if (objectField(payload, "schema") !== "pokemon-post-action-observation.v1") {
    return undefined;
  }

  const change = objectField(payload, "change");
  const kind = typeof objectField(change, "kind") === "string" ? objectField(change, "kind") as string : "unknown";
  return {
    step: typeof objectField(payload, "step") === "number" ? objectField(payload, "step") as number : undefined,
    action: objectField(payload, "action"),
    kind,
    before: objectField(payload, "before"),
    after: objectField(payload, "after"),
    delta: objectField(change, "delta"),
    pixelChanged: typeof objectField(change, "pixelChanged") === "boolean" ? objectField(change, "pixelChanged") as boolean : undefined
  };
}

function countByKind(experiences: readonly MovementExperience[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const experience of experiences) {
    counts[experience.kind] = (counts[experience.kind] ?? 0) + 1;
  }
  return counts;
}

function classifyMovementQuality(counts: Record<string, number>): MovementFeedback["movementQuality"] {
  if ((counts.map_transition ?? 0) > 0 || (counts.non_adjacent_position_jump ?? 0) > 0) return "transitioning";
  if ((counts.walk_step ?? 0) >= Math.max(1, (counts.no_change ?? 0) + (counts.blocked_with_visual_change ?? 0))) return "moving";
  if ((counts.no_change ?? 0) + (counts.blocked_with_visual_change ?? 0) >= 3) return "blocked";
  if (Object.keys(counts).length === 0) return "unknown";
  return "idle";
}

function recommendMovementAdjustment(counts: Record<string, number>): string {
  if ((counts.map_transition ?? 0) > 0) return "ask_llm_to_label_recent_map_transition_and_choose_next_local_macro";
  if ((counts.walk_step ?? 0) > 0 && (counts.no_change ?? 0) === 0) return "continue_current_route_macro_or_extend_it";
  if ((counts.no_change ?? 0) >= 3) return "avoid_repeating_last_direction_and_request_visual_reroute";
  if ((counts.blocked_with_visual_change ?? 0) >= 2) return "treat_recent_direction_as_blocked_probe_lateral_options";
  return "collect_more_movement_experience";
}

async function defaultRequest(baseUrl: string, pathName: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${pathName}`);
  return { status: response.status, body: await response.json() };
}

function objectField(value: unknown, field: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[field] : undefined;
}
