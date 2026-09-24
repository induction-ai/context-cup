/**
 * A provider-neutral view of a native payload, and the way back. The
 * TypeScript twin of `context_cup_protocol/view.py`; the two read every
 * payload the same way (tests/test_protocol_contract.py).
 *
 * `view(provider, payload)` reads a request body into a `Conversation`:
 * system text, messages (user, assistant, tool), and function tools.
 * Whatever the view does not model (reasoning items, thinking blocks, thought
 * parts, images, provider-only keys) rides along untouched: as `opaque`
 * fragments on the message it belongs to, or as keys on a native object the
 * view patches instead of rebuilding.
 *
 * `write(provider, payload, conversation)` returns a new payload with the
 * conversation's edits applied. Anything left unedited comes back exactly as
 * it was, so `write(p, payload, view(p, payload))` equals `payload`. An edited
 * message is rebuilt by patching its native form in place: changing one tool
 * result's text changes that text and nothing else.
 *
 * Messages are plain objects. Each one the view returns carries a hidden
 * record of where it came from, which a spread copy (`{ ...m, text }`) keeps,
 * so editing through a copy patches the original just as assigning
 * `m.text` does. A message built from scratch is new material.
 */
import type { Payload, Provider } from "./models.ts";

type Native = Record<string, any>;

export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type Message = {
  role: "user" | "assistant" | "tool";
  text?: string | null;
  toolCalls?: ToolCall[];
  /** For a tool message: the call it answers. */
  toolCallId?: string | null;
  /** Native fragments the view does not model, kept with this message. */
  opaque?: Native[];
};

export type Tool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type Conversation = {
  system: string | null;
  messages: Message[];
  tools: Tool[];
};

const SEAL: unique symbol = Symbol("context-cup.view");

type Seal = { unit: number; pos: number; snapshot: Dump };
type Sealed = Message & { [SEAL]?: Seal };
type Dump = {
  role: string;
  text: string | null;
  toolCalls: ToolCall[];
  toolCallId: string | null;
  opaque: Native[];
};

type Snapshot = { system: string | null; tools: Tool[] };
const SNAPSHOTS = new WeakMap<Conversation, Snapshot>();

function dump(message: Message): Dump {
  return {
    role: message.role,
    text: message.text ?? null,
    toolCalls: (message.toolCalls ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      arguments: c.arguments,
    })),
    toolCallId: message.toolCallId ?? null,
    opaque: message.opaque ?? [],
  };
}

function sealOf(message: Message): Seal | undefined {
  return (message as Sealed)[SEAL];
}

function edited(message: Message): boolean {
  const seal = sealOf(message);
  return seal === undefined || !equal(dump(message), seal.snapshot);
}

function textChanged(message: Message): boolean {
  const seal = sealOf(message);
  return seal === undefined || (message.text ?? null) !== seal.snapshot.text;
}

function seal(message: Message, unit: number, pos: number): Message {
  // Enumerable, so a spread copy keeps it; JSON never sees a symbol key.
  (message as Sealed)[SEAL] = {
    unit,
    pos,
    snapshot: structuredClone(dump(message)),
  };
  return message;
}

function message(
  role: Message["role"],
  fields: Partial<Message> = {}
): Required<Message> {
  return {
    role,
    text: fields.text ?? null,
    toolCalls: fields.toolCalls ?? [],
    toolCallId: fields.toolCallId ?? null,
    opaque: fields.opaque ?? [],
  };
}

export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((v, i) => equal(v, other[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every(
      (k) => Object.hasOwn(b, k) && equal((a as Native)[k], (b as Native)[k])
    )
  );
}

function isObject(value: unknown): value is Native {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Tool arguments as an object; a string is parsed as JSON. Anything that is
 *  not an object comes back under `_raw` so the call still reaches the
 *  environment and the model sees the error. */
export function parseArguments(raw: unknown): Record<string, unknown> {
  if (isObject(raw)) return raw;
  if (raw === null || raw === undefined || raw === "") return {};
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return isObject(parsed) ? parsed : { _raw: raw };
    } catch {
      return { _raw: raw };
    }
  }
  return { _raw: raw };
}

/** `json.dumps(value, ensure_ascii=False)`: Python's separators, so both
 *  views give a structured Gemini result the same text. */
function pythonJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
  if (isObject(value)) {
    const entries = Object.entries(value).map(
      ([k, v]) => `${JSON.stringify(k)}: ${pythonJson(v)}`
    );
    return `{${entries.join(", ")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Joined text of the text-like parts, and the other parts as opaque. */
function textParts(
  parts: unknown,
  kinds: readonly string[]
): [string | null, Native[]] {
  if (typeof parts === "string") return [parts, []];
  const texts: string[] = [];
  const other: Native[] = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    if (
      isObject(part) &&
      kinds.includes(part.type) &&
      typeof part.text === "string"
    ) {
      texts.push(part.text);
    } else if (isObject(part)) {
      other.push(structuredClone(part));
    }
  }
  return [texts.length ? texts.join("\n") : null, other];
}

/** Whether the edited message still holds `fragment`; consumes it. */
function keepOpaque(fragment: Native, pool: Native[]): boolean {
  const index = pool.findIndex((candidate) => equal(candidate, fragment));
  if (index < 0) return false;
  pool.splice(index, 1);
  return true;
}

/** Text blocks collapse to one carrying `text` (based on the first one);
 *  other blocks stay where they were if the message still holds them. */
function patchedTextList(
  blocks: unknown[],
  text: string | null,
  pool: Native[],
  kinds: readonly string[],
  fresh: Native
): unknown[] {
  const out: unknown[] = [];
  let placed = false;
  for (const block of blocks) {
    if (isObject(block) && kinds.includes(block.type)) {
      if (!placed && text) out.push({ ...block, text });
      placed = true;
    } else if (isObject(block) && keepOpaque(block, pool)) {
      out.push(block);
    }
  }
  if (text && !placed) out.unshift({ ...fresh, text });
  out.push(...pool);
  return out;
}

/** Function tools patched in place by name, removed ones dropped, new ones
 *  appended; other native tools stay where they were. */
function mergeTools(
  old: Native[],
  tools: Tool[],
  isFunction: (entry: Native) => boolean,
  render: (base: Native, tool: Tool) => Native
): Native[] {
  const wanted = new Map(tools.map((tool) => [tool.name, tool]));
  const out: Native[] = [];
  for (const entry of old) {
    if (!isFunction(entry)) {
      out.push(entry);
    } else if (wanted.has(entry.name)) {
      out.push(render(entry, wanted.get(entry.name)!));
      wanted.delete(entry.name);
    }
  }
  for (const tool of wanted.values()) out.push(render({}, tool));
  return out;
}

function callNames(conversation: Conversation): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of conversation.messages) {
    for (const call of m.toolCalls ?? []) names.set(call.id, call.name);
  }
  return names;
}

function toolById(messages: Message[]): Map<string, Message> {
  const tools = new Map<string, Message>();
  for (const m of messages) {
    if (m.role === "tool") tools.set(m.toolCallId ?? "", m);
  }
  return tools;
}

function take<K, V>(map: Map<K, V>, key: K): V | undefined {
  const value = map.get(key);
  map.delete(key);
  return value;
}

interface Codec {
  listKey: string;
  getSystem(payload: Payload): string | null;
  setSystem(payload: Payload, text: string | null): void;
  getTools(payload: Payload): Tool[];
  setTools(payload: Payload, tools: Tool[]): void;
  units(payload: Payload): unknown[];
  read(index: number, unit: unknown, before: Message[]): Message[];
  build(
    original: any,
    messages: Message[],
    names: Map<string, string>
  ): Native[];
}

// -- OpenAI Responses -------------------------------------------------------

const OPENAI_TEXT = ["output_text", "input_text", "text"] as const;

function openaiAssistantSide(item: Native): boolean {
  const kind = item.type;
  const userSide =
    (kind === undefined || kind === null || kind === "message") &&
    ["user", "system", "developer"].includes(item.role);
  return kind !== "function_call_output" && !userSide;
}

function openaiCall(base: Native, call: ToolCall): Native {
  let args = base.arguments;
  if (!equal(parseArguments(args), call.arguments)) {
    args = JSON.stringify(call.arguments);
  }
  return {
    ...base,
    call_id: call.id,
    name: call.name,
    arguments: args || "{}",
  };
}

const openai: Codec = {
  listKey: "input",

  getSystem(payload) {
    const value = payload.instructions;
    return typeof value === "string" ? value : null;
  },

  setSystem(payload, text) {
    if (text === null) delete payload.instructions;
    else payload.instructions = text;
  },

  getTools(payload) {
    return (payload.tools ?? [])
      .filter((t: unknown) => isObject(t) && t.type === "function")
      .map((t: Native) => ({
        name: String(t.name),
        description: String(t.description || ""),
        parameters: t.parameters || {},
      }));
  },

  setTools(payload, tools) {
    payload.tools = mergeTools(
      payload.tools ?? [],
      tools,
      (t) => t.type === "function",
      (base, tool) => ({
        type: "function",
        ...base,
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })
    );
  },

  units(payload) {
    const units: unknown[][] = [];
    for (const item of payload.input ?? []) {
      const last = units.at(-1);
      if (
        isObject(item) &&
        openaiAssistantSide(item) &&
        last &&
        last.every((i) => isObject(i) && openaiAssistantSide(i))
      ) {
        last.push(item);
      } else {
        units.push([item]);
      }
    }
    return units;
  },

  read(_index, unit) {
    const items = unit as unknown[];
    const first = items[0];
    if (!isObject(first)) return [];
    if (first.type === "function_call_output") {
      const [text, opaque] = textParts(first.output, OPENAI_TEXT);
      return [
        message("tool", {
          toolCallId: String(first.call_id || ""),
          text,
          opaque,
        }),
      ];
    }
    if (!openaiAssistantSide(first)) {
      const [text, opaque] = textParts(first.content, OPENAI_TEXT);
      return [message("user", { text, opaque })];
    }
    const texts: string[] = [];
    const calls: ToolCall[] = [];
    const opaque: Native[] = [];
    for (const item of items as Native[]) {
      const kind = item.type;
      if (kind === undefined || kind === null || kind === "message") {
        const [text] = textParts(item.content, OPENAI_TEXT);
        if (text) texts.push(text);
      } else if (kind === "function_call") {
        calls.push({
          id: String(item.call_id || item.id || ""),
          name: String(item.name || ""),
          arguments: parseArguments(item.arguments),
        });
      } else {
        opaque.push(structuredClone(item));
      }
    }
    return [
      message("assistant", {
        text: texts.length ? texts.join("\n") : null,
        toolCalls: calls,
        opaque,
      }),
    ];
  },

  build(original, messages) {
    const [m] = messages as [Message];
    if (m.role === "tool") {
      const base: Native = original
        ? original[0]
        : { type: "function_call_output" };
      const old = base.output;
      let output: unknown = m.text || "";
      if (Array.isArray(old)) {
        output = patchedTextList(
          old,
          m.text ?? null,
          [...(m.opaque ?? [])],
          OPENAI_TEXT,
          { type: "input_text" }
        );
      } else if (m.opaque?.length) {
        output = [{ type: "input_text", text: m.text || "" }, ...m.opaque];
      }
      return [{ ...base, call_id: m.toolCallId, output }];
    }
    if (m.role === "user") {
      const base: Native = original ? original[0] : { role: "user" };
      const content = base.content;
      let fresh: unknown;
      if (Array.isArray(content)) {
        fresh = patchedTextList(
          content,
          m.text ?? null,
          [...(m.opaque ?? [])],
          OPENAI_TEXT,
          { type: "input_text" }
        );
      } else if (m.opaque?.length) {
        fresh = [{ type: "input_text", text: m.text || "" }, ...m.opaque];
      } else {
        fresh = m.text || "";
      }
      return [{ ...base, content: fresh }];
    }
    return openaiAssistant(original ?? [], m);
  },
};

function openaiAssistant(original: Native[], m: Message): Native[] {
  const pool = [...(m.opaque ?? [])];
  const calls = new Map((m.toolCalls ?? []).map((c) => [c.id, c]));
  const changed = textChanged(m);
  const text = m.text ?? null;
  let out: Native[] = [];
  let placed = false;
  for (const item of original) {
    const kind = item.type;
    if (kind === undefined || kind === null || kind === "message") {
      if (!changed) {
        out.push(item);
      } else if (!placed && text) {
        const content = item.content;
        const fresh = Array.isArray(content)
          ? patchedTextList(content, text, [], OPENAI_TEXT, {
              type: "output_text",
              annotations: [],
            })
          : text;
        out.push({ ...item, content: fresh });
      }
      placed = placed || changed;
    } else if (kind === "function_call") {
      const call = take(calls, String(item.call_id || item.id || ""));
      if (call !== undefined) out.push(openaiCall(item, call));
    } else if (keepOpaque(item, pool)) {
      out.push(item);
    }
  }
  if (changed && !placed && text) {
    const firstCall = out.findIndex((x) => x.type === "function_call");
    out.splice(firstCall < 0 ? out.length : firstCall, 0, {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }
  out = [...pool, ...out];
  for (const call of calls.values()) {
    out.push(openaiCall({ type: "function_call" }, call));
  }
  return out;
}

// -- Anthropic Messages -----------------------------------------------------

const ANTHROPIC_TEXT = ["text"] as const;

function toolResult(base: Native, m: Message): Native {
  const old = base.content;
  let content: unknown = m.text || "";
  if (Array.isArray(old)) {
    content = patchedTextList(
      old,
      m.text ?? null,
      [...(m.opaque ?? [])],
      ANTHROPIC_TEXT,
      { type: "text" }
    );
  } else if (m.opaque?.length) {
    content = [{ type: "text", text: m.text || "" }, ...m.opaque];
  }
  return { ...base, tool_use_id: m.toolCallId, content };
}

/** A user-side unit rebuilt around its original: tool results patched by
 *  call id, the user's text and opaque blocks kept in place. Shared by
 *  Anthropic (blocks, `tool_result`) and Gemini (parts, `functionResponse`). */
function userText(messages: Message[]) {
  const user = messages.find((m) => m.role === "user");
  return {
    user,
    pool: user ? [...(user.opaque ?? [])] : [],
    changed: user !== undefined && textChanged(user),
    text: user?.text ?? null,
  };
}

const anthropic: Codec = {
  listKey: "messages",

  getSystem(payload) {
    const system = payload.system;
    if (Array.isArray(system)) return textParts(system, ANTHROPIC_TEXT)[0];
    return typeof system === "string" ? system : null;
  },

  setSystem(payload, text) {
    const system = payload.system;
    if (text === null) {
      delete payload.system;
    } else if (Array.isArray(system)) {
      const others = system.filter(
        (b: Native) => !ANTHROPIC_TEXT.includes(b.type)
      );
      payload.system = patchedTextList(system, text, others, ANTHROPIC_TEXT, {
        type: "text",
      });
    } else {
      payload.system = text;
    }
  },

  getTools(payload) {
    return (payload.tools ?? [])
      .filter((t: unknown) => isObject(t) && "input_schema" in t)
      .map((t: Native) => ({
        name: String(t.name),
        description: String(t.description || ""),
        parameters: t.input_schema || {},
      }));
  },

  setTools(payload, tools) {
    payload.tools = mergeTools(
      payload.tools ?? [],
      tools,
      (t) => "input_schema" in t,
      (base, tool) => ({
        ...base,
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      })
    );
  },

  units(payload) {
    return [...(payload.messages ?? [])];
  },

  read(_index, unit) {
    if (!isObject(unit)) return [];
    const content = unit.content;
    if (unit.role === "assistant") {
      const texts: string[] = [];
      const calls: ToolCall[] = [];
      const opaque: Native[] = [];
      for (const block of Array.isArray(content) ? content : []) {
        if (block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        } else if (block.type === "tool_use") {
          calls.push({
            id: String(block.id || ""),
            name: String(block.name || ""),
            arguments: parseArguments(block.input),
          });
        } else {
          opaque.push(structuredClone(block));
        }
      }
      if (typeof content === "string") texts.push(content);
      return [
        message("assistant", {
          text: texts.length ? texts.join("\n") : null,
          toolCalls: calls,
          opaque,
        }),
      ];
    }
    if (!Array.isArray(content)) {
      return [
        message("user", {
          text: typeof content === "string" ? content : null,
        }),
      ];
    }
    const messages: Message[] = [];
    let user: Required<Message> | undefined;
    for (const block of content) {
      if (!isObject(block)) continue;
      if (block.type === "tool_result") {
        const [text, opaque] = textParts(block.content, ANTHROPIC_TEXT);
        messages.push(
          message("tool", {
            toolCallId: String(block.tool_use_id || ""),
            text,
            opaque,
          })
        );
        continue;
      }
      if (user === undefined) {
        user = message("user");
        messages.push(user);
      }
      if (block.type === "text" && typeof block.text === "string") {
        user.text =
          user.text === null ? block.text : `${user.text}\n${block.text}`;
      } else {
        user.opaque.push(structuredClone(block));
      }
    }
    return messages;
  },

  build(original, messages) {
    if (messages[0]!.role === "assistant") {
      return [anthropicAssistant(original, messages[0]!)];
    }
    if (original === null) {
      const blocks: Native[] = [];
      for (const m of messages) {
        if (m.role === "tool") {
          blocks.push(toolResult({ type: "tool_result" }, m));
        } else {
          if (m.text) blocks.push({ type: "text", text: m.text });
          blocks.push(...(m.opaque ?? []));
        }
      }
      return [{ role: "user", content: blocks }];
    }
    const content = original.content;
    if (!Array.isArray(content)) {
      return [{ ...original, content: messages[0]!.text || "" }];
    }
    const tools = toolById(messages);
    const { user, pool, changed, text } = userText(messages);
    const out: unknown[] = [];
    let placed = false;
    for (const block of content) {
      const kind = isObject(block) ? block.type : undefined;
      if (kind === "tool_result") {
        const answer = take(tools, String(block.tool_use_id || ""));
        if (answer !== undefined) {
          out.push(edited(answer) ? toolResult(block, answer) : block);
        }
      } else if (kind === "text") {
        if (user === undefined) continue;
        if (!changed) out.push(block);
        else if (!placed && text) out.push({ ...block, text });
        placed = placed || changed;
      } else if (keepOpaque(block, pool)) {
        out.push(block);
      }
    }
    if (user !== undefined && changed && !placed && text) {
      out.push({ type: "text", text });
    }
    out.push(...pool);
    for (const m of tools.values()) {
      out.push(toolResult({ type: "tool_result" }, m));
    }
    return [{ ...original, content: out }];
  },
};

function anthropicAssistant(original: Native | null, m: Message): Native {
  const raw = original?.content;
  const blocks: Native[] = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? [{ type: "text", text: raw }]
      : [];
  const pool = [...(m.opaque ?? [])];
  const calls = new Map((m.toolCalls ?? []).map((c) => [c.id, c]));
  const changed = textChanged(m);
  const text = m.text ?? null;
  let out: Native[] = [];
  let placed = false;
  for (const block of blocks) {
    const kind = block.type;
    if (kind === "text") {
      if (!changed) out.push(block);
      else if (!placed && text) out.push({ ...block, text });
      placed = placed || changed;
    } else if (kind === "tool_use") {
      const call = take(calls, String(block.id || ""));
      if (call !== undefined) {
        out.push({
          ...block,
          id: call.id,
          name: call.name,
          input: call.arguments,
        });
      }
    } else if (keepOpaque(block, pool)) {
      out.push(block);
    }
  }
  if (changed && !placed && text) {
    const firstCall = out.findIndex((b) => b.type === "tool_use");
    out.splice(firstCall < 0 ? out.length : firstCall, 0, {
      type: "text",
      text,
    });
  }
  out = [...pool, ...out];
  for (const c of calls.values()) {
    out.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments });
  }
  return { ...(original ?? { role: "assistant" }), content: out };
}

// -- Gemini generateContent -------------------------------------------------

/** Calls without an API id get a minted one, used only inside the view;
 *  responses go back by name, as the API expects. */
export const MINTED_PREFIX = "gemini-call-";

function geminiText(part: unknown): boolean {
  return isObject(part) && typeof part.text === "string" && !part.thought;
}

function geminiCall(base: Native, call: ToolCall): Native {
  const out: Native = { ...base, name: call.name, args: call.arguments };
  if (!call.id.startsWith(MINTED_PREFIX)) out.id = call.id;
  return out;
}

function functionResponse(
  part: Native,
  m: Message,
  names: Map<string, string>
): Native {
  const base: Native = part.functionResponse ?? {};
  const result = base.response;
  const response = isObject(result)
    ? { ...result, result: m.text || "" }
    : { result: m.text || "" };
  const callId = m.toolCallId || "";
  const fresh: Native = {
    ...base,
    name: base.name || names.get(callId) || "",
    response,
  };
  if (callId && !callId.startsWith(MINTED_PREFIX)) fresh.id = callId;
  return { ...part, functionResponse: fresh };
}

function declarations(payload: Payload): Native[] {
  return (payload.tools ?? []).flatMap((entry: unknown) =>
    isObject(entry) ? (entry.functionDeclarations ?? []) : []
  );
}

const gemini: Codec = {
  listKey: "contents",

  getSystem(payload) {
    const system = payload.systemInstruction;
    if (!isObject(system)) return null;
    const texts = (system.parts ?? [])
      .filter(geminiText)
      .map((p: Native) => p.text as string);
    return texts.length ? texts.join("\n") : null;
  },

  setSystem(payload, text) {
    if (text === null) {
      delete payload.systemInstruction;
      return;
    }
    const system = payload.systemInstruction;
    const base: Native = isObject(system) ? system : {};
    const others = (base.parts ?? []).filter((p: unknown) => !geminiText(p));
    payload.systemInstruction = { ...base, parts: [{ text }, ...others] };
  },

  getTools(payload) {
    return declarations(payload).map((d) => ({
      name: String(d.name),
      description: String(d.description || ""),
      parameters: d.parameters || {},
    }));
  },

  setTools(payload, tools) {
    const merged = mergeTools(
      declarations(payload),
      tools,
      () => true,
      (base, tool) => ({
        ...base,
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })
    );
    const entries: unknown[] = [];
    let placed = false;
    for (const entry of payload.tools ?? []) {
      if (isObject(entry) && "functionDeclarations" in entry) {
        if (!placed && merged.length) {
          entries.push({ ...entry, functionDeclarations: merged });
        }
        placed = true;
      } else {
        entries.push(entry);
      }
    }
    if (!placed && merged.length) {
      entries.unshift({ functionDeclarations: merged });
    }
    payload.tools = entries;
  },

  units(payload) {
    return [...(payload.contents ?? [])];
  },

  read(index, unit, before) {
    if (!isObject(unit)) return [];
    const parts: unknown[] = unit.parts ?? [];
    if (unit.role === "model") {
      const texts: string[] = [];
      const calls: ToolCall[] = [];
      const opaque: Native[] = [];
      parts.forEach((part, position) => {
        const call = isObject(part) ? part.functionCall : undefined;
        if (isObject(call)) {
          calls.push({
            id: String(call.id || `${MINTED_PREFIX}${index}-${position}`),
            name: String(call.name || ""),
            arguments: parseArguments(call.args),
          });
        } else if (geminiText(part)) {
          texts.push((part as Native).text);
        } else if (isObject(part)) {
          opaque.push(structuredClone(part));
        }
      });
      return [
        message("assistant", {
          text: texts.length ? texts.join("\n") : null,
          toolCalls: calls,
          opaque,
        }),
      ];
    }
    const previous = before.findLast((m) => m.role === "assistant");
    let pending = [...(previous?.toolCalls ?? [])];
    const messages: Message[] = [];
    let user: Required<Message> | undefined;
    for (const part of parts) {
      if (!isObject(part)) continue;
      const response = part.functionResponse;
      if (isObject(response)) {
        let callId = response.id;
        if (!callId) {
          const match = pending.find((c) => c.name === response.name);
          callId = match ? match.id : "";
        }
        pending = pending.filter((c) => c.id !== callId);
        const result = response.response;
        const text =
          isObject(result) && typeof result.result === "string"
            ? result.result
            : pythonJson(result);
        messages.push(message("tool", { toolCallId: String(callId), text }));
        continue;
      }
      if (user === undefined) {
        user = message("user");
        messages.push(user);
      }
      if (geminiText(part)) {
        user.text =
          user.text === null ? part.text : `${user.text}\n${part.text}`;
      } else {
        user.opaque.push(structuredClone(part));
      }
    }
    return messages;
  },

  build(original, messages, names) {
    if (messages[0]!.role === "assistant") {
      return [geminiModel(original, messages[0]!)];
    }
    const tools = toolById(messages);
    const { user, pool, changed, text } = userText(messages);
    const out: unknown[] = [];
    let placed = false;
    for (const part of original?.parts ?? []) {
      const response = isObject(part) ? part.functionResponse : undefined;
      if (isObject(response)) {
        const callId = response.id;
        let answer = callId ? take(tools, String(callId)) : undefined;
        if (answer === undefined && !callId) {
          for (const [key, m] of tools) {
            if (names.get(key) === response.name) {
              answer = m;
              tools.delete(key);
              break;
            }
          }
        }
        if (answer !== undefined) {
          out.push(
            edited(answer) ? functionResponse(part, answer, names) : part
          );
        }
      } else if (geminiText(part)) {
        if (user === undefined) continue;
        if (!changed) out.push(part);
        else if (!placed && text) out.push({ ...part, text });
        placed = placed || changed;
      } else if (keepOpaque(part, pool)) {
        out.push(part);
      }
    }
    if (user !== undefined && changed && !placed && text) out.push({ text });
    out.push(...pool);
    for (const m of tools.values()) out.push(functionResponse({}, m, names));
    return [{ ...(original ?? { role: "user" }), parts: out }];
  },
};

function geminiModel(original: Native | null, m: Message): Native {
  const pool = [...(m.opaque ?? [])];
  const calls = new Map((m.toolCalls ?? []).map((c) => [c.id, c]));
  const changed = textChanged(m);
  const text = m.text ?? null;
  const unit = sealOf(m)?.unit;
  let out: Native[] = [];
  let placed = false;
  (original?.parts ?? []).forEach((part: Native, position: number) => {
    const call = isObject(part) ? part.functionCall : undefined;
    if (isObject(call)) {
      const key = String(call.id || `${MINTED_PREFIX}${unit}-${position}`);
      const found = take(calls, key);
      if (found !== undefined) {
        out.push({ ...part, functionCall: geminiCall(call, found) });
      }
    } else if (geminiText(part)) {
      if (!changed) out.push(part);
      else if (!placed && text) out.push({ ...part, text });
      placed = placed || changed;
    } else if (keepOpaque(part, pool)) {
      out.push(part);
    }
  });
  if (changed && !placed && text) {
    const firstCall = out.findIndex((p) => "functionCall" in p);
    out.splice(firstCall < 0 ? out.length : firstCall, 0, { text });
  }
  out = [...pool, ...out];
  for (const c of calls.values()) out.push({ functionCall: geminiCall({}, c) });
  return { ...(original ?? { role: "model" }), parts: out };
}

// -- entry points -------------------------------------------------------------

const CODECS: Record<Provider, Codec> = { openai, anthropic, gemini };

/** The payload as a provider-neutral conversation. */
export function view(provider: Provider, payload: Payload): Conversation {
  const codec = CODECS[provider];
  const conversation: Conversation = {
    system: codec.getSystem(payload),
    messages: [],
    tools: codec.getTools(payload),
  };
  codec.units(payload).forEach((unit, index) => {
    const read = codec.read(index, unit, conversation.messages);
    read.forEach((m, pos) => conversation.messages.push(seal(m, index, pos)));
  });
  SNAPSHOTS.set(conversation, {
    system: conversation.system,
    tools: structuredClone(conversation.tools),
  });
  return conversation;
}

type Run = { unit: number | null; messages: Message[] };

/** Consecutive messages from one native unit, in conversation order. A unit
 *  that shows up again later is new material there. */
function runs(messages: Message[]): Run[] {
  const out: Run[] = [];
  const used = new Set<number>();
  for (const m of messages) {
    let unit: number | null = sealOf(m)?.unit ?? null;
    const last = out.at(-1);
    if (unit !== null && last && last.unit === unit) {
      last.messages.push(m);
      continue;
    }
    if (unit !== null && used.has(unit)) unit = null;
    if (unit !== null) used.add(unit);
    out.push({ unit, messages: [m] });
  }
  return out;
}

function originalCounts(codec: Codec, payload: Payload): number[] {
  const seen: Message[] = [];
  return codec.units(payload).map((unit, index) => {
    const read = codec.read(index, unit, seen);
    seen.push(...read);
    return read.length;
  });
}

/** A new payload carrying the conversation's edits; `payload` is not
 *  modified. */
export function write(
  provider: Provider,
  payload: Payload,
  conversation: Conversation
): Payload {
  const codec = CODECS[provider];
  const out = structuredClone(payload);
  const snapshot = SNAPSHOTS.get(conversation);
  if (conversation.system !== (snapshot ? snapshot.system : null)) {
    codec.setSystem(out, conversation.system);
  }
  if (!equal(conversation.tools, snapshot ? snapshot.tools : [])) {
    codec.setTools(out, conversation.tools);
  }
  const units = codec.units(payload);
  const counts = originalCounts(codec, payload);
  const names = callNames(conversation);
  const rebuilt: unknown[] = [];
  for (const run of runs(conversation.messages)) {
    const original =
      run.unit !== null ? structuredClone(units[run.unit]) : null;
    const whole =
      run.unit !== null &&
      equal(
        run.messages.map((m) => sealOf(m)!.pos),
        [...Array(counts[run.unit]).keys()]
      );
    if (whole && !run.messages.some(edited)) {
      if (Array.isArray(original)) rebuilt.push(...original);
      else rebuilt.push(original);
      continue;
    }
    if (run.unit === null) {
      for (const m of run.messages)
        rebuilt.push(...codec.build(null, [m], names));
    } else {
      rebuilt.push(...codec.build(original, run.messages, names));
    }
  }
  if (rebuilt.length || codec.listKey in out) out[codec.listKey] = rebuilt;
  return out;
}
