/** The course's conversation in the AI SDK's terms: `ModelMessage`s, and a
 *  `ToolSet` of the course's tools with no `execute`, so a call stops at the
 *  model's tool calls and the course runs them.
 *
 *  Each provider's reasoning rides along where the AI SDK reads it back:
 *  OpenAI's encrypted reasoning items and Anthropic's signed thinking blocks
 *  as reasoning parts, Gemini's thought signatures on its function calls.
 *  Without them a reasoning model starts every turn cold (Gemini 3 rejects
 *  function calls replayed without their signatures). */
import type { Payload, Provider } from "@context-cup/protocol/models.js";
import type { Conversation, Message } from "@context-cup/protocol/view.js";
import {
  jsonSchema,
  tool,
  type AssistantContent,
  type ModelMessage,
  type ToolSet,
} from "ai";

type Native = Record<string, any>;
type AssistantPart = Exclude<AssistantContent, string>[number];

/** Gemini's thought signatures by the view's call id, which the view leaves
 *  out. Native function-call parts and the view's calls are in the same
 *  order, and Gemini does not always send call ids, so they pair by
 *  position. */
function geminiSignatures(
  payload: Payload,
  conversation: Conversation
): Map<string, string> {
  const signatures: (string | undefined)[] = (payload.contents ?? [])
    .flatMap((c: Native) => c.parts ?? [])
    .filter((p: Native) => p?.functionCall)
    .map((p: Native) => p.thoughtSignature);
  const calls = conversation.messages.flatMap((m) => m.toolCalls ?? []);
  return new Map(
    calls.flatMap((call, i) => {
      const signature = signatures[i];
      return signature ? [[call.id, signature] as const] : [];
    })
  );
}

function reasoning(provider: Provider, fragment: Native): AssistantPart[] {
  if (provider === "openai" && fragment.type === "reasoning") {
    const summaries: string[] = (fragment.summary ?? []).map(
      (s: Native) => s.text ?? ""
    );
    const itemId = fragment.id as string | undefined;
    // One part per summary, all under the item's id; the AI SDK rebuilds the
    // item from them.
    return (summaries.length ? summaries : [""]).map((text, i) => ({
      type: "reasoning",
      text,
      providerOptions: {
        openai: {
          ...(itemId ? { itemId } : {}),
          ...(i === 0 && fragment.encrypted_content
            ? { reasoningEncryptedContent: fragment.encrypted_content }
            : {}),
        },
      },
    }));
  }
  if (provider === "anthropic" && fragment.type === "thinking") {
    return [
      {
        type: "reasoning",
        text: fragment.thinking ?? "",
        providerOptions: { anthropic: { signature: fragment.signature } },
      },
    ];
  }
  if (provider === "anthropic" && fragment.type === "redacted_thinking") {
    return [
      {
        type: "reasoning",
        text: "",
        providerOptions: { anthropic: { redactedData: fragment.data } },
      },
    ];
  }
  if (provider === "gemini" && fragment.thought && fragment.text) {
    return [
      {
        type: "reasoning",
        text: fragment.text,
        ...(fragment.thoughtSignature
          ? {
              providerOptions: {
                google: { thoughtSignature: fragment.thoughtSignature },
              },
            }
          : {}),
      },
    ];
  }
  // No AI SDK form (hosted tool calls, images): not carried.
  return [];
}

function assistant(
  provider: Provider,
  m: Message,
  signatures: Map<string, string>
): ModelMessage | null {
  const content: AssistantPart[] = (m.opaque ?? []).flatMap((o) =>
    reasoning(provider, o)
  );
  if (m.text) content.push({ type: "text", text: m.text });
  for (const call of m.toolCalls ?? []) {
    const thoughtSignature = signatures.get(call.id);
    content.push({
      type: "tool-call",
      toolCallId: call.id,
      toolName: call.name,
      input: call.arguments,
      ...(thoughtSignature
        ? { providerOptions: { google: { thoughtSignature } } }
        : {}),
    });
  }
  return content.length ? { role: "assistant", content } : null;
}

/** The conversation from message `start` on as AI SDK messages. The system
 *  prompt is not among them: the AI SDK takes it as `instructions`.
 *  Consecutive tool results share one tool message, which is how a provider
 *  expects the answers to one turn's calls. */
export function modelMessages(
  provider: Provider,
  payload: Payload,
  conversation: Conversation,
  start = 0
): ModelMessage[] {
  const names = new Map(
    conversation.messages.flatMap((m) =>
      (m.toolCalls ?? []).map((c) => [c.id, c.name] as const)
    )
  );
  const signatures =
    provider === "gemini"
      ? geminiSignatures(payload, conversation)
      : new Map<string, string>();
  const out: ModelMessage[] = [];
  for (const m of conversation.messages.slice(start)) {
    if (m.role === "tool") {
      const id = m.toolCallId ?? "";
      const part = {
        type: "tool-result" as const,
        toolCallId: id,
        toolName: names.get(id) ?? "",
        output: { type: "text" as const, value: m.text ?? "" },
      };
      const last = out.at(-1);
      if (last?.role === "tool") last.content.push(part);
      else out.push({ role: "tool", content: [part] });
    } else if (m.role === "user") {
      if (m.text) out.push({ role: "user", content: m.text });
    } else {
      const message = assistant(provider, m, signatures);
      if (message) out.push(message);
    }
  }
  return out;
}

/** The course's tools, without `execute`. */
export function modelTools(conversation: Conversation): ToolSet {
  return Object.fromEntries(
    conversation.tools.map((t) => [
      t.name,
      tool({
        description: t.description,
        inputSchema: jsonSchema(
          t.parameters?.type
            ? t.parameters
            : { type: "object", properties: {}, ...t.parameters }
        ),
      }),
    ])
  );
}
