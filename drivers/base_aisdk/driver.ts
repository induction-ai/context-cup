/** base_aisdk: clip any tool result larger than `config.max_bytes` before it
 *  reaches the model. base_python, on the AI SDK: copy this to write one
 *  strategy for OpenAI, Anthropic, and Gemini over AI SDK messages: edit
 *  `ctx.contextMessages`, call `ctx.llm.generateText()`, return its result.
 *  See engines/aisdk/README.md for everything `ctx` holds. */
import type { AisdkContext } from "@context-cup/engine-aisdk";

const MARKER_PREFIX = "\n\n[truncated by base_aisdk:";

export function clip(text: string, maxBytes: number): string {
  const raw = Buffer.from(text, "utf8");
  // Clipped edits persist in contextMessages, so a result clipped on an
  // earlier turn comes back with its marker; leave it as it is.
  if (raw.length <= maxBytes || text.includes(MARKER_PREFIX)) return text;
  // A cut through a multi-byte character decodes to U+FFFD; drop it.
  const kept = raw
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD$/, "");
  return `${kept}${MARKER_PREFIX} ${raw.length - maxBytes} bytes removed]`;
}

export async function run(ctx: AisdkContext) {
  // Tunables live in package.json's contextCup.config, so a variant is a
  // manifest edit.
  const maxBytes = Number(ctx.config.max_bytes ?? 100_000);
  // `ctx.contextMessages` is AI SDK ModelMessages: turn one, the whole
  // conversation; after that, last turn's list as this driver left it plus
  // the model's reply and the new tool results or user text. Tool results
  // are `tool-result` parts of `tool` messages. The clip persists: next
  // turn starts from the clipped list.
  for (const message of ctx.contextMessages) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      const output = part.output;
      if (output.type === "text" || output.type === "error-text") {
        part.output = { ...output, value: clip(output.value, maxBytes) };
      }
    }
  }
  // With no options, ctx.llm sends ctx.instructions, ctx.contextMessages, and
  // ctx.tools to the target through the trial's proxy. The engine emits the
  // raw provider body behind this result as the turn's answer.
  return ctx.llm.generateText();
}
