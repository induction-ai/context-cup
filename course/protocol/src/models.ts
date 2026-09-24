/** The files a turn exchanges (docs/protocol.md): `input.json`, written by
 *  the runner and read by an engine, and `output.json`, the reverse. The
 *  TypeScript twin of `context_cup_protocol/models.py`. */
import z from "zod";

export const PROTOCOL_VERSION = 2;

// Mirrors PROVIDERS in course/shared/src/provider.ts and Provider in
// models.py; tests/test_protocol_contract.py checks all three agree.
export const PROVIDERS = ["openai", "anthropic", "gemini"] as const;
export type Provider = (typeof PROVIDERS)[number];
export type ProviderApi = "responses" | "messages" | "generate_content";

/** The only key a trial container holds. Every call goes through the run's
 *  proxy, which injects the real one. */
export const PLACEHOLDER_KEY = "cc-proxy";

/** A provider request body or response object, as JSON. */
export type Payload = Record<string, any>;

const zTarget = z.looseObject({
  model: z.string().min(1),
  reasoning_effort: z.string().nullish(),
});

const zProviderInfo = z.object({
  name: z.enum(PROVIDERS),
  api_key: z.string().min(1),
  client: z.object({
    base_url: z.string().min(1),
    api: z.enum(["responses", "messages", "generate_content"]),
  }),
});

const zDirs = z.object({
  turn: z.string(),
  state: z.string(),
  workspace: z.string().nullish(),
});

const zTurnInput = z.looseObject({
  protocol: z.literal(PROTOCOL_VERSION).default(PROTOCOL_VERSION),
  trial_id: z.string(),
  turn_id: z.string(),
  turn_index: z.number().int(),
  first: z.boolean(),
  provider: zProviderInfo,
  target: zTarget,
  context_payload: z.record(z.string(), z.any()),
  original_payload: z.record(z.string(), z.any()),
  state: z.any().default(null),
  limits: z.record(z.string(), z.any()).default({}),
  dirs: zDirs,
});

/** The `target` object: the model the suite runs against. */
export type Target = z.infer<typeof zTarget>;
/** The `provider` object: family, placeholder key, and a client that points
 *  at the trial's proxy. */
export type ProviderInfo = z.infer<typeof zProviderInfo>;
export type Dirs = z.infer<typeof zDirs>;
/** The whole `input.json`, as the runner wrote it (snake_case, like the
 *  wire). */
export type TurnInput = z.infer<typeof zTurnInput>;

export function parseTurnInput(value: unknown): TurnInput {
  return zTurnInput.parse(value);
}

export type DriverInfo = {
  name: string;
  engine?: string | null;
  version?: string | null;
};

export type TurnOutput = {
  protocol: typeof PROTOCOL_VERSION;
  turn_id: string;
  /** The provider's response object for the turn, verbatim. */
  response: Payload;
  context_payload?: Payload | null;
  state?: unknown;
  driver?: DriverInfo;
};
