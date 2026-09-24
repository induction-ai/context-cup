/** The TypeScript engine's shape in the AI SDK's terms:
 *  `ctx.originalMessages` (the whole record) and `ctx.contextMessages` (the
 *  working copy, kept across turns with the driver's edits) are AI SDK
 *  `ModelMessage`s instead of native payloads, with the system prompt beside
 *  them as `ctx.instructions`. `ctx.llm.generateText(...)`
 *  calls the AI SDK with the engine's connection: the target model on the
 *  run's provider, pointed at the proxy with the placeholder key, the
 *  course's tools, and the target's reasoning settings as the course set
 *  them. A driver may override any of it, call as often as it likes, and
 *  returns the result of the call that is its turn; the course gets that
 *  call's raw provider body. OpenAI goes over the Responses API, the wire the
 *  course speaks. */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { EngineContext } from "@context-cup/protocol/engine.js";
import {
  PROVIDERS,
  type Dirs,
  type Payload,
  type Provider,
  type ProviderInfo,
  type Target,
  type TurnInput,
} from "@context-cup/protocol/models.js";
import { loadSnapshot, saveSnapshot } from "@context-cup/protocol/snapshot.js";
import { view } from "@context-cup/protocol/view.js";
import {
  generateText,
  type GenerateTextResult,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { modelMessages, modelTools } from "./messages.ts";

/** The engine's own bookkeeping in the state dir: the driver's instructions
 *  and context messages, and how many conversation messages they account
 *  for, saved per accepted turn (see `@context-cup/protocol/snapshot.js`).
 *  `ctx.state` stays the driver's. */
export const CONTEXT_SNAPSHOT = "aisdk_context";

type Kept = {
  seen: number;
  instructions?: Instructions;
  messages: ModelMessage[];
};

/** Appended to `<proxy>/t/<trial>/<provider>`: where each AI SDK provider
 *  expects its API version in the base URL. */
const VERSION: Record<Provider, string> = {
  openai: "/v1",
  anthropic: "/v1",
  gemini: "/v1beta",
};

type ProviderOptions = Record<string, Record<string, any>>;

/** Call settings the course put in the target's native payload, as AI SDK
 *  options: OpenAI's reasoning effort and summary, Anthropic's thinking
 *  budget and max_tokens, Gemini's thinking config. */
export type TargetSettings = {
  providerOptions: ProviderOptions;
  maxOutputTokens?: number;
};

export function targetSettings(
  provider: Provider,
  payload: Payload
): TargetSettings {
  if (provider === "openai") {
    const reasoning = payload.reasoning ?? {};
    return {
      providerOptions: {
        openai: {
          ...(reasoning.effort ? { reasoningEffort: reasoning.effort } : {}),
          // The AI SDK asks for detailed summaries unless told otherwise.
          reasoningSummary: reasoning.summary ?? null,
        },
      },
    };
  }
  if (provider === "anthropic") {
    const thinking = payload.thinking;
    const budget: number =
      thinking?.type === "enabled" ? Number(thinking.budget_tokens ?? 0) : 0;
    // The AI SDK adds the thinking budget to maxOutputTokens, so the request
    // carries the payload's own max_tokens.
    return {
      providerOptions: thinking
        ? {
            anthropic: {
              thinking: {
                type: thinking.type,
                budgetTokens: budget || undefined,
              },
            },
          }
        : {},
      ...(payload.max_tokens
        ? { maxOutputTokens: Number(payload.max_tokens) - budget }
        : {}),
    };
  }
  const thinkingConfig = payload.generationConfig?.thinkingConfig;
  return {
    providerOptions: thinkingConfig ? { google: { thinkingConfig } } : {},
  };
}

/** A model name and its provider. A bare name is the run's provider; a name
 *  with a provider prefix (`openai/`, `anthropic/`, `gemini/`) picks another,
 *  still through the proxy. */
export function route(model: string, fallback: Provider): [Provider, string] {
  for (const provider of PROVIDERS) {
    if (model.startsWith(`${provider}/`)) {
      return [provider, model.slice(provider.length + 1)];
    }
  }
  return [fallback, model];
}

type Call = { result: unknown; raw: Payload; provider: Provider };

type GenerateTextOptions = Parameters<typeof generateText>[0];
/** A system prompt: a string, or system messages with provider options. */
export type Instructions = GenerateTextOptions["instructions"];

/** `generateText`'s own options, all optional, with `model` as a name (see
 *  {@link route}) and `purpose`, the call's label in the accounting. */
export type CallOptions = Omit<
  Partial<GenerateTextOptions>,
  "model" | "prompt" | "messages"
> & {
  model?: string;
  purpose?: string;
  prompt?: string | ModelMessage[];
  messages?: ModelMessage[];
};

function mergeOptions(...all: (ProviderOptions | undefined)[]) {
  const out: ProviderOptions = {};
  for (const options of all) {
    for (const [key, value] of Object.entries(options ?? {})) {
      out[key] = { ...out[key], ...value };
    }
  }
  return out;
}

/** The handle a driver calls: `generateText` is the AI SDK's with the
 *  engine's connection filled in. */
export class LLM {
  readonly calls: Call[] = [];

  private readonly ctx: AisdkContext;

  constructor(ctx: AisdkContext) {
    this.ctx = ctx;
  }

  private base(provider: Provider): string {
    const { name, client } = this.ctx.provider;
    const root = client.base_url.replace(/\/+$/, "");
    const cut = root.lastIndexOf(`/${name}`);
    return `${cut < 0 ? root : root.slice(0, cut)}/${provider}${VERSION[provider]}`;
  }

  /** An AI SDK model on the proxy, for calls a driver makes with the AI SDK
   *  directly (`generateObject`, `streamText`, an agent). `name` defaults to
   *  the target; `purpose` labels its calls in the accounting. Only
   *  `generateText` below can make the turn's call. */
  model(
    name: string = this.ctx.target.model,
    options: { purpose?: string; fetch?: typeof fetch } = {}
  ): LanguageModel {
    const [provider, id] = route(name, this.ctx.provider.name);
    const settings = {
      baseURL: this.base(provider),
      apiKey: this.ctx.provider.api_key,
      headers: { "x-cc-purpose": options.purpose ?? "turn" },
      ...(options.fetch ? { fetch: options.fetch } : {}),
    };
    if (provider === "openai") return createOpenAI(settings).responses(id);
    if (provider === "anthropic") return createAnthropic(settings)(id);
    return createGoogleGenerativeAI(settings)(id);
  }

  /** `generateText` with the run's defaults: `ctx.instructions` and
   *  `ctx.contextMessages` (unless a `prompt` or `messages` is given),
   *  `ctx.tools`, the target model, and,
   *  on the target, the reasoning settings the course chose for it. Every
   *  option can be overridden. */
  async generateText(
    options: CallOptions = {}
  ): Promise<GenerateTextResult<ToolSet, any, any>> {
    const ctx = this.ctx;
    const {
      model: name = ctx.target.model,
      purpose = "turn",
      ...rest
    } = options;
    const [provider, id] = route(name, ctx.provider.name);
    const onTarget = provider === ctx.provider.name && id === ctx.target.model;
    const settings: TargetSettings = onTarget
      ? targetSettings(provider, ctx.contextPayload)
      : { providerOptions: {} };
    const raws: Payload[] = [];
    const capture: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const type = response.headers.get("content-type") ?? "";
      if (response.ok && type.includes("json")) {
        raws.push((await response.clone().json()) as Payload);
      }
      return response;
    };
    const conversation =
      rest.prompt === undefined && rest.messages === undefined
        ? { instructions: ctx.instructions, messages: ctx.contextMessages }
        : {};
    const result = await generateText({
      ...conversation,
      ...(Object.keys(ctx.tools).length ? { tools: ctx.tools } : {}),
      ...(settings.maxOutputTokens
        ? { maxOutputTokens: settings.maxOutputTokens }
        : {}),
      ...rest,
      model: this.model(name, { purpose, fetch: capture }),
      providerOptions: mergeOptions(
        // Nothing kept server-side, as for every other driver.
        provider === "openai" ? { openai: { store: false } } : {},
        settings.providerOptions,
        rest.providerOptions as ProviderOptions | undefined
      ),
    } as GenerateTextOptions);
    const raw = raws.at(-1);
    if (!raw) throw new Error(`no response body was captured for ${name}`);
    this.calls.push({ result, raw, provider });
    return result;
  }
}

/** What an AI SDK driver's `run(ctx)` receives: the conversation as AI SDK
 *  messages and `llm`, an AI SDK handle on the trial's proxy. It returns the
 *  result of the `llm.generateText(...)` call that is its turn.
 *
 *  - `instructions`, `contextMessages`: the working copy of the system
 *    prompt and the conversation; both persist (see below).
 *  - `originalInstructions`, `originalMessages`, `tools`: the record and the
 *    course's tools in AI SDK form, read only.
 *  - `llm`: `llm.generateText()` sends `instructions`, `contextMessages`, and
 *    `tools` to the target; every option can be overridden.
 *  - `state`: the driver's, any JSON, `{}` on turn one; persists.
 *  - `first`, `provider`, `target`, `dirs`, `turnId`, `config` (the
 *    manifest's `contextCup.config`), and `turn`, the whole `input.json`:
 *    read only.
 *  - `contextPayload`, `originalPayload`: the native bodies the messages are
 *    built from; informational.
 *
 *  The engine's own bookkeeping (`instructions`, `contextMessages`, and
 *  `seen`) is kept in
 *  `dirs.state/aisdk_context.json`. engines/aisdk/README.md has the full
 *  table and examples. */
export class AisdkContext implements EngineContext {
  contextPayload: Payload;
  state: any;
  /** The course's system prompt; read only. */
  readonly originalInstructions: string | undefined;
  /** The whole record as AI SDK messages; read only. */
  readonly originalMessages: ModelMessage[];
  /** The working system prompt, kept across turns like `contextMessages`;
   *  what `ctx.llm` sends by default. */
  instructions: Instructions;
  /** The working copy: last turn's (with the driver's edits) plus what came
   *  in since. What the driver leaves here is kept for the next turn, and it
   *  is what `ctx.llm` sends by default. */
  contextMessages: ModelMessage[];
  /** The course's tools, without `execute`: the default `ctx.llm` offers. */
  readonly tools: ToolSet;
  readonly llm: LLM;
  /** Conversation messages `contextMessages` accounts for. */
  readonly seen: number;

  /** The whole `input.json`, as the runner wrote it. */
  readonly turn: TurnInput;
  /** The manifest's `contextCup.config`. */
  readonly config: Record<string, any>;

  constructor(turn: TurnInput, config: Record<string, any> = {}) {
    this.turn = turn;
    this.config = config;
    this.contextPayload = structuredClone(turn.context_payload);
    this.state = structuredClone(turn.state);
    const provider = turn.provider.name;
    const original = view(provider, turn.original_payload);
    this.originalInstructions = original.system ?? undefined;
    this.originalMessages = modelMessages(
      provider,
      turn.original_payload,
      original
    );
    const conversation = view(provider, this.contextPayload);
    const kept = loadSnapshot<Kept>(turn, CONTEXT_SNAPSHOT);
    if (kept === undefined) {
      this.instructions = conversation.system ?? undefined;
      this.contextMessages = modelMessages(
        provider,
        this.contextPayload,
        conversation
      );
    } else {
      this.instructions = kept.instructions;
      this.contextMessages = [
        ...kept.messages,
        ...modelMessages(
          provider,
          this.contextPayload,
          conversation,
          kept.seen
        ),
      ];
    }
    this.seen = conversation.messages.length;
    this.tools = modelTools(conversation);
    this.llm = new LLM(this);
  }

  get first(): boolean {
    return this.turn.first;
  }

  get provider(): ProviderInfo {
    return this.turn.provider;
  }

  get target(): Target {
    return this.turn.target;
  }

  get dirs(): Dirs {
    return this.turn.dirs;
  }

  get turnId(): string {
    return this.turn.turn_id;
  }

  get originalPayload(): Payload {
    return this.turn.original_payload;
  }
}

/** The raw provider body of the call whose result `run` returned. */
export function finish(ctx: AisdkContext, result: unknown): Payload {
  const call = ctx.llm.calls.findLast((c) => c.result === result);
  if (call === undefined) {
    const kind =
      result === null || typeof result !== "object"
        ? String(result)
        : (result.constructor?.name ?? "object");
    throw new TypeError(
      `run(ctx) must return a result of ctx.llm.generateText(...), not ${kind}`
    );
  }
  if (call.provider !== ctx.provider.name) {
    throw new TypeError(
      `the turn's response must come from the run's provider ` +
        `(${ctx.provider.name}), not ${call.provider}`
    );
  }
  // Read by the next turn only if the runner accepts this one.
  saveSnapshot(ctx.turn, CONTEXT_SNAPSHOT, {
    seen: ctx.seen,
    instructions: ctx.instructions,
    messages: ctx.contextMessages,
  } satisfies Kept);
  return structuredClone(call.raw);
}
