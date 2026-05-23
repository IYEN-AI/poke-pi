import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GeneratedPolicySchema, type GeneratedPolicyDefinition } from "./GeneratedPolicyTypes.js";

export interface SynthesizeGeneratedPolicyOptions {
  readonly evidenceDir: string;
  readonly fromRun: string;
  readonly policyId: string;
  readonly objective?: string;
  readonly outputFile?: string;
  readonly now?: () => Date;
}

export interface SynthesizeGeneratedPolicyResult {
  readonly policy: GeneratedPolicyDefinition;
  readonly outputFile: string;
  readonly sourceEvents: number;
  readonly telemetryEvents: number;
}

export async function synthesizeGeneratedPolicy(options: SynthesizeGeneratedPolicyOptions): Promise<SynthesizeGeneratedPolicyResult> {
  const runDir = path.join(options.evidenceDir, options.fromRun);
  const events = await readJsonl(path.join(runDir, "events.jsonl"));
  const telemetry = events.filter((event) => objectField(event, "type") === "pokemon_telemetry").map((event) => objectField(event, "payload"));
  const routes = topStrings(telemetry.map((entry) => stringField(entry, "route")));
  const repeatedSignals = telemetry.filter((entry) => arrayField(entry, "improvementSignals").some((signal) => typeof signal === "string" && signal.includes("repeated"))).length;
  const boldProbeAfterRepeats = repeatedSignals > 1 ? 2 : 3;
  const policy = GeneratedPolicySchema.parse({
    schema: "pokemon-generated-policy.v1",
    id: options.policyId,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    sourceRunId: options.fromRun,
    objective: options.objective ?? `Use scout run ${options.fromRun} to execute map exploration with safe generated heuristics.`,
    base: "map-heuristic",
    tuning: {
      avoidRecentDirections: true,
      preferDifferentBlock: true,
      interactionCandidatePatience: repeatedSignals > 0 ? 2 : 3,
      fallbackToBaseHeuristic: true,
      boldProbeAfterRepeats
    },
    rules: [
      {
        id: "battle-advance",
        description: "Advance active battles with the selected safe action.",
        when: { battle: true },
        action: { type: "press", button: "A", frames: 5 },
        confidence: 0.72
      },
      {
        id: "text-advance",
        description: "Advance active text, menu, and prompt screens before overworld movement.",
        when: { textActive: true },
        action: { type: "press", button: "A", frames: 5 },
        confidence: 0.68
      },
      {
        id: "candidate-interact",
        description: "Interact only after repeated movement when RAM says the facing block is an interaction candidate.",
        when: { textActive: false, sameCoordRepeatsGte: repeatedSignals > 0 ? 2 : 3, facingInteractionCandidate: true },
        action: { type: "press", button: "A", frames: 5 },
        confidence: 0.64
      },
      ...(repeatedSignals > 0 ? [{
        id: "critic-bold-route-probe",
        description: "Critic observed repeated-state stagnation, so try a longer route-changing probe instead of the normal greedy direction.",
        when: { textActive: false, sameCoordRepeatsGte: boldProbeAfterRepeats },
        explorationStrategy: "bold-route-probe" as const,
        confidence: 0.56
      }] : []),
      ...routes.slice(0, 4).map((route) => ({
        id: `explore-${route.replace(/[^A-Za-z0-9_-]/g, "-")}`,
        description: `Explore ${route} with map RAM direction candidates from scout telemetry.`,
        when: { route, textActive: false, sameCoordRepeatsGte: 1 },
        preferMapDirection: true,
        confidence: 0.62
      })),
      {
        id: "generic-map-explore",
        description: "Use map RAM direction candidates when no route-specific generated rule matches.",
        when: { textActive: false, sameCoordRepeatsGte: 1 },
        preferMapDirection: true,
        confidence: 0.58
      }
    ],
    notes: [
      `Synthesized from ${events.length} events and ${telemetry.length} telemetry entries.`,
      routes.length > 0 ? `Observed routes: ${routes.join(", ")}.` : "No route telemetry was found; generic map exploration rule is used.",
      repeatedSignals > 0 ? `Critic found ${repeatedSignals} repeated-state signals; bold route probes are enabled after ${boldProbeAfterRepeats} repeats.` : "Critic did not find repeated-state stagnation; normal map exploration remains primary.",
      "Generated policies are JSON DSL artifacts; harness schema validation rejects unsafe or malformed actions."
    ]
  });

  const outputFile = options.outputFile ?? path.join("policies", "generated", `${options.policyId}.json`);
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  return { policy, outputFile, sourceEvents: events.length, telemetryEvents: telemetry.length };
}

async function readJsonl(file: string): Promise<unknown[]> {
  const text = await readFile(file, "utf8");
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown);
}

function topStrings(values: readonly (string | undefined)[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value !== undefined && value !== "unknown") counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).map(([value]) => value);
}

function objectField(value: unknown, field: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[field] : undefined;
}

function stringField(value: unknown, field: string): string | undefined {
  const entry = objectField(value, field);
  return typeof entry === "string" ? entry : undefined;
}

function arrayField(value: unknown, field: string): unknown[] {
  const entry = objectField(value, field);
  return Array.isArray(entry) ? entry : [];
}
