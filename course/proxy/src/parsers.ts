/** Turn raw provider traffic into call records. Keyed on the request path;
 *  bodies come in as bytes so streamed (SSE) and plain JSON replies share
 *  one entry point. Mirrors engines/python/src/context_cup_engine/parsers.py. */

import type { Provider } from "@context-cup/shared/provider.js";

export type Wire = "responses" | "completions" | "anthropic" | "gemini";

export type Usage = {
  input: number;
  cached_input: number;
  cache_write_input: number;
  output: number;
  reasoning_output: number;
};

export type ParsedCall = {
  provider: Provider;
  host: string;
  model: string | null;
  wire: Wire;
  usage: Usage | null;
  service_tier: string | null;
  streamed: boolean;
};

const PROVIDER_HOSTS: Array<[string, Provider]> = [
  ["api.openai.com", "openai"],
  ["api.anthropic.com", "anthropic"],
  ["generativelanguage.googleapis.com", "gemini"],
];

/** The provider family each wire belongs to, for hosts we do not recognise
 *  (a gateway, a compatible endpoint). */
const WIRE_PROVIDER: Record<Wire, Provider> = {
  responses: "openai",
  completions: "openai",
  anthropic: "anthropic",
  gemini: "gemini",
};

export function providerForHost(host: string): Provider | null {
  for (const [suffix, provider] of PROVIDER_HOSTS) {
    if (host === suffix || host.endsWith("." + suffix)) return provider;
  }
  return null;
}

export function wireForPath(path: string): Wire | null {
  const bare = path.split("?")[0] ?? path;
  if (bare.endsWith("/responses")) return "responses";
  if (bare.endsWith("/chat/completions")) return "completions";
  if (bare.endsWith("/messages")) return "anthropic";
  if (
    bare.includes(":generateContent") ||
    bare.includes(":streamGenerateContent")
  )
    return "gemini";
  return null;
}

type Json = Record<string, unknown>;

function int(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function obj(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function jsonOrNull(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
}

/** Every `data:` payload in an SSE body that parses as a JSON object. */
export function sseJsonEvents(body: Buffer): Json[] {
  const events: Json[] = [];
  for (const block of body.toString("utf8").split("\n\n")) {
    const lines = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    if (lines.length === 0) continue;
    const payload = lines.join("\n");
    if (payload === "[DONE]") continue;
    try {
      const parsed: unknown = JSON.parse(payload);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      )
        events.push(parsed as Json);
    } catch {
      // not JSON: a comment or keepalive
    }
  }
  return events;
}

export function usageFromOpenaiResponses(usage: Json): Usage {
  return {
    input: int(usage.input_tokens),
    cached_input: int(obj(usage.input_tokens_details).cached_tokens),
    cache_write_input: 0,
    output: int(usage.output_tokens),
    reasoning_output: int(obj(usage.output_tokens_details).reasoning_tokens),
  };
}

export function usageFromOpenaiCompletions(usage: Json): Usage {
  return {
    input: int(usage.prompt_tokens),
    cached_input: int(obj(usage.prompt_tokens_details).cached_tokens),
    cache_write_input: 0,
    output: int(usage.completion_tokens),
    reasoning_output: int(
      obj(usage.completion_tokens_details).reasoning_tokens
    ),
  };
}

export function usageFromAnthropic(usage: Json): Usage {
  // Anthropic's input_tokens excludes cache reads and writes; ours includes them.
  const fresh = int(usage.input_tokens);
  const cached = int(usage.cache_read_input_tokens);
  const written = int(usage.cache_creation_input_tokens);
  return {
    input: fresh + cached + written,
    cached_input: cached,
    cache_write_input: written,
    output: int(usage.output_tokens),
    reasoning_output: 0,
  };
}

export function usageFromGemini(usage: Json): Usage {
  const thoughts = int(usage.thoughtsTokenCount);
  return {
    input: int(usage.promptTokenCount),
    cached_input: int(usage.cachedContentTokenCount),
    cache_write_input: 0,
    output: int(usage.candidatesTokenCount) + thoughts,
    reasoning_output: thoughts,
  };
}

type Extract = {
  usage: Usage | null;
  model: string | null;
  tier: string | null;
};
const NONE: Extract = { usage: null, model: null, tier: null };

function parseResponses(body: Buffer, streamed: boolean): Extract {
  if (streamed) {
    for (const event of sseJsonEvents(body).reverse()) {
      const response = obj(event.response);
      if (
        event.type === "response.completed" &&
        Object.keys(response).length > 0
      ) {
        return {
          usage: usageFromOpenaiResponses(obj(response.usage)),
          model: str(response.model),
          tier: str(response.service_tier),
        };
      }
    }
    return NONE;
  }
  const data = jsonOrNull(body);
  if (data === null || typeof data !== "object" || Array.isArray(data))
    return NONE;
  const d = data as Json;
  return {
    usage:
      typeof d.usage === "object" && d.usage
        ? usageFromOpenaiResponses(obj(d.usage))
        : null,
    model: str(d.model),
    tier: str(d.service_tier),
  };
}

function parseCompletions(body: Buffer, streamed: boolean): Extract {
  if (streamed) {
    let model: string | null = null;
    let tier: string | null = null;
    for (const event of sseJsonEvents(body)) {
      model = str(event.model) ?? model;
      tier = str(event.service_tier) ?? tier;
      const usage = obj(event.usage);
      if (Object.keys(usage).length > 0)
        return { usage: usageFromOpenaiCompletions(usage), model, tier };
    }
    return { usage: null, model, tier };
  }
  const data = jsonOrNull(body);
  if (data === null || typeof data !== "object" || Array.isArray(data))
    return NONE;
  const d = data as Json;
  return {
    usage:
      typeof d.usage === "object" && d.usage
        ? usageFromOpenaiCompletions(obj(d.usage))
        : null,
    model: str(d.model),
    tier: str(d.service_tier),
  };
}

function parseAnthropic(body: Buffer, streamed: boolean): Extract {
  if (streamed) {
    const merged: Json = {};
    let model: string | null = null;
    for (const event of sseJsonEvents(body)) {
      if (event.type === "message_start") {
        const message = obj(event.message);
        model = str(message.model) ?? model;
        Object.assign(merged, obj(message.usage));
      } else if (event.type === "message_delta") {
        // Cumulative for output; newer API versions repeat the input counts.
        Object.assign(merged, obj(event.usage));
      }
    }
    if (Object.keys(merged).length === 0)
      return { usage: null, model, tier: null };
    return { usage: usageFromAnthropic(merged), model, tier: null };
  }
  const data = jsonOrNull(body);
  if (data === null || typeof data !== "object" || Array.isArray(data))
    return NONE;
  const d = data as Json;
  return {
    usage:
      typeof d.usage === "object" && d.usage
        ? usageFromAnthropic(obj(d.usage))
        : null,
    model: str(d.model),
    tier: null,
  };
}

function parseGemini(body: Buffer, streamed: boolean): Extract {
  let chunks: Json[];
  if (streamed) {
    chunks = sseJsonEvents(body);
    if (chunks.length === 0) {
      const data = jsonOrNull(body);
      chunks = Array.isArray(data)
        ? data.filter((c): c is Json => c !== null && typeof c === "object")
        : [];
    }
  } else {
    const data = jsonOrNull(body);
    chunks =
      data !== null && typeof data === "object" && !Array.isArray(data)
        ? [data as Json]
        : [];
  }
  let usage: Usage | null = null;
  let model: string | null = null;
  for (const chunk of chunks) {
    model = str(chunk.modelVersion) ?? model;
    if (typeof chunk.usageMetadata === "object" && chunk.usageMetadata)
      usage = usageFromGemini(obj(chunk.usageMetadata));
  }
  return { usage, model, tier: null };
}

function geminiModelFromPath(path: string): string | null {
  const marker = "/models/";
  const i = path.indexOf(marker);
  if (i === -1) return null;
  const rest = path.slice(i + marker.length);
  return rest.split(":", 1)[0] || null;
}

/** Parse one call. Returns null for a path that is not a model call. */
export function parseCall(input: {
  host: string;
  path: string;
  requestBody: Buffer;
  responseBody: Buffer;
  contentType: string;
}): ParsedCall | null {
  const wire = wireForPath(input.path);
  if (wire === null) return null;
  const provider = providerForHost(input.host) ?? WIRE_PROVIDER[wire];
  const request = obj(jsonOrNull(input.requestBody));
  const streamed =
    input.contentType.includes("text/event-stream") || request.stream === true;

  let out: Extract;
  if (wire === "responses") out = parseResponses(input.responseBody, streamed);
  else if (wire === "completions")
    out = parseCompletions(input.responseBody, streamed);
  else if (wire === "anthropic")
    out = parseAnthropic(input.responseBody, streamed);
  else {
    out = parseGemini(input.responseBody, streamed);
    out = { ...out, model: out.model ?? geminiModelFromPath(input.path) };
  }
  return {
    provider,
    host: input.host,
    model: out.model ?? str(request.model),
    wire,
    usage: out.usage,
    service_tier: out.tier ?? str(request.service_tier),
    streamed,
  };
}
