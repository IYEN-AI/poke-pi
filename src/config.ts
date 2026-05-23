import { z } from "zod";

const pokemonVersionSchema = z.enum(["red", "blue"], {
  error: "POKEMON_VERSION must be one of: red, blue"
});

const logLevelSchema = z.enum(["debug", "info", "warn", "error"], {
  error: "LOG_LEVEL must be one of: debug, info, warn, error"
});

const aiProviderSchema = z.enum(["heuristic", "openai"], {
  error: "AI_PROVIDER must be one of: heuristic, openai"
});

const harnessModeSchema = z.enum(["stage1", "full-game"], {
  error: "HARNESS_MODE must be one of: stage1, full-game"
});

const optionalNonEmptyString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().optional()
);

const urlString = (name: string) =>
  z.url({ error: `${name} must be a valid URL` });

const integerFromEnv = (name: string, defaultValue: number, minimum: number) =>
  z.coerce
    .number({ error: `${name} must be a number` })
    .int(`${name} must be an integer`)
    .min(minimum, `${name} must be at least ${minimum}`)
    .default(defaultValue);

const numberFromEnv = (name: string, defaultValue: number, minimum: number, maximum?: number) => {
  const schema = z.coerce
    .number({ error: `${name} must be a number` })
    .min(minimum, `${name} must be at least ${minimum}`);

  return (maximum === undefined ? schema : schema.max(maximum, `${name} must be at most ${maximum}`)).default(defaultValue);
};

const rawConfigSchema = z
  .object({
    MGBA_HTTP_BASE_URL: urlString("MGBA_HTTP_BASE_URL").default("http://127.0.0.1:5000"),
    POKEMON_VERSION: pokemonVersionSchema.default("red"),
    POKEMON_ROM_PATH: optionalNonEmptyString,
    EVIDENCE_DIR: z.string().min(1, "EVIDENCE_DIR must not be empty").default("runs"),
    HARNESS_RUN_ID: optionalNonEmptyString,
    HARNESS_MODE: harnessModeSchema.default("stage1"),
    LOG_LEVEL: logLevelSchema.default("info"),
    LOOP_MAX_STEPS: integerFromEnv("LOOP_MAX_STEPS", 1000, 1),
    LOOP_STEP_DELAY_MS: integerFromEnv("LOOP_STEP_DELAY_MS", 250, 0),
    MAX_LLM_CALLS: integerFromEnv("MAX_LLM_CALLS", 400, 0),
    LLM_TIMEOUT_MS: integerFromEnv("LLM_TIMEOUT_MS", 20000, 1),
    LLM_MAX_RETRIES: integerFromEnv("LLM_MAX_RETRIES", 1, 0),
    DEFAULT_TAP_FRAMES: integerFromEnv("DEFAULT_TAP_FRAMES", 5, 1),
    DEFAULT_HOLD_FRAMES: integerFromEnv("DEFAULT_HOLD_FRAMES", 15, 1),
    AI_PROVIDER: aiProviderSchema.default("heuristic"),
    OPENAI_BASE_URL: urlString("OPENAI_BASE_URL").default("https://api.openai.com/v1"),
    OPENAI_API_KEY: optionalNonEmptyString,
    OPENAI_MODEL: z.string().min(1, "OPENAI_MODEL must not be empty").default("gpt-5.5"),
    OPENAI_TEMPERATURE: numberFromEnv("OPENAI_TEMPERATURE", 0.2, 0, 2)
  })
  .superRefine((config, context) => {
    if (config.AI_PROVIDER === "openai" && config.OPENAI_API_KEY === undefined) {
      context.addIssue({
        code: "custom",
        path: ["OPENAI_API_KEY"],
        message: "OPENAI_API_KEY is required when AI_PROVIDER=openai"
      });
    }
  });

type RawHarnessConfig = z.infer<typeof rawConfigSchema>;

export type PokemonVersion = RawHarnessConfig["POKEMON_VERSION"];
export type LogLevel = RawHarnessConfig["LOG_LEVEL"];
export type AiProvider = RawHarnessConfig["AI_PROVIDER"];
export type HarnessMode = RawHarnessConfig["HARNESS_MODE"];

export interface HarnessConfig {
  mgbaHttpBaseUrl: string;
  pokemonVersion: PokemonVersion;
  pokemonRomPath?: string;
  evidenceDir: string;
  harnessRunId: string;
  harnessMode: HarnessMode;
  logLevel: LogLevel;
  loopMaxSteps: number;
  loopStepDelayMs: number;
  maxLlmCalls: number;
  llmTimeoutMs: number;
  llmMaxRetries: number;
  defaultTapFrames: number;
  defaultHoldFrames: number;
  aiProvider: AiProvider;
  openaiBaseUrl: string;
  openaiApiKey?: string;
  openaiModel: string;
  openaiTemperature: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HarnessConfig {
  const result = rawConfigSchema.safeParse(env);

  if (!result.success) {
    const messages = result.error.issues.map((issue) => {
      const path = issue.path.join(".") || "config";
      return `${path}: ${issue.message}`;
    });

    throw new Error(`Invalid harness configuration: ${messages.join("; ")}`);
  }

  return toHarnessConfig(result.data);
}

function toHarnessConfig(config: RawHarnessConfig): HarnessConfig {
  return {
    mgbaHttpBaseUrl: config.MGBA_HTTP_BASE_URL,
    pokemonVersion: config.POKEMON_VERSION,
    pokemonRomPath: config.POKEMON_ROM_PATH,
    evidenceDir: config.EVIDENCE_DIR,
    harnessRunId: config.HARNESS_RUN_ID ?? createDefaultRunId(),
    harnessMode: config.HARNESS_MODE,
    logLevel: config.LOG_LEVEL,
    loopMaxSteps: config.LOOP_MAX_STEPS,
    loopStepDelayMs: config.LOOP_STEP_DELAY_MS,
    maxLlmCalls: config.MAX_LLM_CALLS,
    llmTimeoutMs: config.LLM_TIMEOUT_MS,
    llmMaxRetries: config.LLM_MAX_RETRIES,
    defaultTapFrames: config.DEFAULT_TAP_FRAMES,
    defaultHoldFrames: config.DEFAULT_HOLD_FRAMES,
    aiProvider: config.AI_PROVIDER,
    openaiBaseUrl: config.OPENAI_BASE_URL,
    openaiApiKey: config.OPENAI_API_KEY,
    openaiModel: config.OPENAI_MODEL,
    openaiTemperature: config.OPENAI_TEMPERATURE
  };
}

function createDefaultRunId(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}
