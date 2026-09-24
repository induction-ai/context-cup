/** base_typescript: clip any tool result larger than `config.max_bytes`
 *  before it reaches the model. base_python, in TypeScript: copy this to
 *  write one strategy that works on every provider through the
 *  provider-neutral view, with the provider SDKs from npm. See
 *  engines/typescript/README.md for everything `ctx` holds. */
import Anthropic from "@anthropic-ai/sdk";
import type { TypeScriptContext } from "@context-cup/engine-typescript";
import OpenAI from "openai";

const MARKER_PREFIX = "\n\n[truncated by base_typescript:";

export function clip(text: string, maxBytes: number): string {
  const raw = Buffer.from(text, "utf8");
  // Clipped edits persist in contextPayload, so a result clipped on an
  // earlier turn comes back with its marker; leave it as it is.
  if (raw.length <= maxBytes || text.includes(MARKER_PREFIX)) return text;
  // A cut through a multi-byte character decodes to U+FFFD; drop it.
  const kept = raw
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD$/, "");
  return `${kept}${MARKER_PREFIX} ${raw.length - maxBytes} bytes removed]`;
}

/** Send `contextPayload` to the run's provider. Each SDK already points at
 *  the trial's proxy (base URL and placeholder key set by the runner), so
 *  none needs configuring; the proxy adds the real key and records the
 *  call. */
async function call(ctx: TypeScriptContext): Promise<unknown> {
  const payload = ctx.contextPayload;
  if (ctx.provider.name === "openai") {
    return new OpenAI().responses.create(payload as any);
  }
  if (ctx.provider.name === "anthropic") {
    return new Anthropic().messages.create(payload as any);
  }
  // Gemini: the model goes in the path, the rest of the payload is the body.
  const { model, ...body } = payload;
  const response = await fetch(
    `${ctx.provider.client.base_url}/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": ctx.provider.api_key,
      },
      body: JSON.stringify(body),
    }
  );
  if (!response.ok) {
    throw new Error(`Gemini ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

export async function run(ctx: TypeScriptContext): Promise<unknown> {
  // Tunables live in package.json's contextCup.config, so a variant is a
  // manifest edit.
  const maxBytes = Number(ctx.config.max_bytes ?? 100_000);
  // The view reads the native payload as system text, messages, and tools,
  // the same for OpenAI, Anthropic, and Gemini. What it doesn't model
  // (reasoning items, thinking blocks, thought signatures) rides along.
  const conversation = ctx.view();
  for (const message of conversation.messages) {
    if (message.role === "tool" && message.text) {
      message.text = clip(message.text, maxBytes);
    }
  }
  // Write the edits back: only the clipped results change in the payload.
  // The clip persists, since the course keeps this payload for next turn
  // and appends to it.
  ctx.write(conversation);
  return call(ctx);
}
