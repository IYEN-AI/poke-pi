import type { HarnessConfig } from "../config.js";
import type { PressAction } from "../control/ActionTypes.js";
import { HarnessError } from "../errors.js";
import type { MgbaPreflightReport } from "../mgba/preflight.js";
import type { HarnessStatus } from "../types.js";

export interface MgbaSmokeWorkflowDependencies {
  readonly startEvidence?: (config: unknown) => Promise<void>;
  readonly runPreflight: () => Promise<MgbaPreflightReport>;
  readonly snapshot: () => Promise<unknown>;
  readonly press: (action: PressAction) => Promise<void>;
  readonly recordAction?: (action: unknown) => Promise<void>;
  readonly recordError?: (error: unknown) => Promise<string>;
  readonly finishEvidence?: (status: HarnessStatus, result?: unknown) => Promise<unknown>;
}

export interface MgbaSmokeWorkflowOptions {
  readonly config: Pick<HarnessConfig, "harnessRunId" | "evidenceDir" | "defaultTapFrames" | "mgbaHttpBaseUrl" | "pokemonVersion" | "pokemonRomPath">;
  readonly dependencies: MgbaSmokeWorkflowDependencies;
}

export interface MgbaSmokeWorkflowResult {
  readonly status: HarnessStatus;
  readonly runId: string;
  readonly steps: readonly string[];
  readonly preflight: MgbaPreflightReport;
  readonly firstSnapshot?: unknown;
  readonly secondSnapshot?: unknown;
  readonly action?: PressAction;
  readonly summary?: unknown;
  readonly errorFile?: string;
}

export async function runMgbaSmokeWorkflow(options: MgbaSmokeWorkflowOptions): Promise<MgbaSmokeWorkflowResult> {
  const { config, dependencies } = options;
  const steps: string[] = [];
  const action: PressAction = { type: "press", button: "B", frames: config.defaultTapFrames };

  await dependencies.startEvidence?.({
    command: "smoke:mgba",
    runId: config.harnessRunId,
    evidenceDir: config.evidenceDir,
    mgbaHttpBaseUrl: config.mgbaHttpBaseUrl,
    pokemonVersion: config.pokemonVersion,
    hasPokemonRomPath: config.pokemonRomPath !== undefined,
    action
  });

  try {
    steps.push("preflight");
    const preflight = await dependencies.runPreflight();
    if (!preflight.ok) {
      const error = new HarnessError("MGBA_UNAVAILABLE", "mGBA smoke preflight failed", { context: { checks: preflight.checks } });
      const errorFile = await dependencies.recordError?.(error);
      const result = { status: "failed_mgba" as const, runId: config.harnessRunId, steps, preflight, action, errorFile };
      const summary = await dependencies.finishEvidence?.("failed_mgba", result);
      return { ...result, summary };
    }

    steps.push("snapshot");
    const firstSnapshot = await dependencies.snapshot();

    steps.push("press B");
    await dependencies.press(action);
    await dependencies.recordAction?.({ step: steps.length, action, rationale: "mGBA smoke uses B to minimize game-state mutation." });

    steps.push("snapshot");
    const secondSnapshot = await dependencies.snapshot();

    const result = { status: "completed" as const, runId: config.harnessRunId, steps, preflight, firstSnapshot, secondSnapshot, action };
    const summary = await dependencies.finishEvidence?.("completed", result);
    return { ...result, summary };
  } catch (error) {
    const harnessError = error instanceof HarnessError
      ? error
      : new HarnessError("MGBA_UNAVAILABLE", "mGBA smoke workflow dependency failed", { cause: error });
    const errorFile = await dependencies.recordError?.(harnessError);
    const preflight = emptyFailedPreflight(harnessError.message);
    const result = { status: "failed_mgba" as const, runId: config.harnessRunId, steps, preflight, action, errorFile };
    const summary = await dependencies.finishEvidence?.("failed_mgba", result);
    return { ...result, summary };
  }
}

function emptyFailedPreflight(message: string): MgbaPreflightReport {
  return {
    ok: false,
    checks: [
      {
        name: "current_frame",
        status: "fail",
        message,
        guidance: "Start mGBA manually with mGBA-http enabled and verify MGBA_HTTP_BASE_URL points to it.",
        errorCode: "MGBA_UNAVAILABLE"
      }
    ]
  };
}
