/** The provider-neutral view: unedited payloads round-trip byte for byte, and
 *  an edit changes only what it names. The same cases as test_view.py, on the
 *  same fixtures. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Payload, Provider } from "../src/models.ts";
import { view, write, type Message } from "../src/view.ts";

const FIXTURES = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "view_fixtures.json"), "utf8")
) as Record<Provider, Payload>;
const PROVIDERS = Object.keys(FIXTURES) as Provider[];
const { openai: OPENAI, anthropic: ANTHROPIC, gemini: GEMINI } = FIXTURES;

const dumps = (payload: unknown) => JSON.stringify(payload);

describe.each(PROVIDERS)("%s", (provider) => {
  const payload = FIXTURES[provider];

  it("round-trips an unedited view byte for byte", () => {
    const before = dumps(payload);
    const conversation = view(provider, payload);
    expect(dumps(write(provider, payload, conversation))).toBe(before);
    expect(dumps(payload)).toBe(before);
  });

  it("reads the conversation", () => {
    const conversation = view(provider, payload);
    expect(conversation.system).toBe("You are a bank agent.");
    expect(conversation.tools.map((t) => t.name)).toEqual(["get_balance"]);
    const tools = conversation.messages.filter((m) => m.role === "tool");
    expect(tools).toHaveLength(2);
    const calls = conversation.messages.flatMap((m) => m.toolCalls ?? []);
    expect(calls.slice(0, 2).map((c) => c.name)).toEqual([
      "get_balance",
      "get_limits",
    ]);
    expect(calls[0]!.arguments).toEqual({ acct: "A-1" });
    expect(tools.map((m) => m.text)).toEqual([
      "balance 12 USD",
      "x".repeat(40),
    ]);
    expect(new Set(tools.map((m) => m.toolCallId))).toEqual(
      new Set(calls.slice(0, 2).map((c) => c.id))
    );
    expect(
      conversation.messages.some(
        (m) => m.role === "assistant" && m.opaque?.length
      )
    ).toBe(true);
  });

  it("changes only the text of the one tool result edited", () => {
    const conversation = view(provider, payload);
    conversation.messages.filter((m) => m.role === "tool")[1]!.text = "clipped";
    const after = dumps(write(provider, payload, conversation));
    expect(after.includes("x".repeat(40))).toBe(false);
    expect(after.split("clipped")).toHaveLength(2);
    expect(after.replace("clipped", "x".repeat(40))).toBe(dumps(payload));
  });

  it("patches through a spread copy as through assignment", () => {
    const conversation = view(provider, payload);
    conversation.messages = conversation.messages.map((m) =>
      m.role === "tool" && m.text === "x".repeat(40)
        ? { ...m, text: "clipped" }
        : m
    );
    const after = dumps(write(provider, payload, conversation));
    expect(after.replace("clipped", "x".repeat(40))).toBe(dumps(payload));
  });
});

it("keeps OpenAI reasoning and ids around an edit", () => {
  const conversation = view("openai", OPENAI);
  conversation.messages.filter((m) => m.role === "assistant").at(-1)!.text =
    "You have 12 US dollars.";
  const out = write("openai", OPENAI, conversation);
  const items = out.input as Payload[];
  const message = items.find((i) => i.id === "msg_1")!;
  expect(message.content[0].text).toBe("You have 12 US dollars.");
  expect(items.some((i) => i.id === "rs_2")).toBe(true);
  expect(out.tools[1]).toEqual({ type: "web_search" });
});

it("drops opaque blocks and adds messages", () => {
  const conversation = view("anthropic", ANTHROPIC);
  for (const m of conversation.messages) {
    m.opaque = (m.opaque ?? []).filter((o) => o.type !== "thinking");
  }
  conversation.messages.push({ role: "user", text: "One more thing." });
  const out = write("anthropic", ANTHROPIC, conversation);
  expect(dumps(out.messages)).not.toContain("thinking");
  expect(dumps(out)).not.toContain("sig==");
  expect(out.messages.at(-1)).toEqual({
    role: "user",
    content: [{ type: "text", text: "One more thing." }],
  });
  expect(out.system).toEqual(ANTHROPIC.system);
});

it("sends a new Gemini tool result back by name", () => {
  const payload = structuredClone(GEMINI);
  payload.contents = payload.contents.slice(0, 4);
  const conversation = view("gemini", payload);
  const calls = conversation.messages.at(-1)!.toolCalls!;
  const answer: Message = {
    role: "tool",
    toolCallId: calls[0]!.id,
    text: "balance 12 USD",
  };
  conversation.messages.push(answer);
  const out = write("gemini", payload, conversation);
  expect(out.contents.at(-1).parts[0].functionResponse).toEqual({
    name: "get_balance",
    response: { result: "balance 12 USD" },
  });
  expect(out.contents[3]).toEqual(payload.contents[3]);
});

it("edits the system prompt, tools, and calls", () => {
  const conversation = view("openai", OPENAI);
  conversation.system = "Be terse.";
  conversation.tools[0]!.description = "Account balance";
  conversation.messages[2]!.toolCalls![0] = {
    id: "call_1",
    name: "get_balance",
    arguments: { acct: "B-2" },
  };
  const out = write("openai", OPENAI, conversation);
  expect(out.instructions).toBe("Be terse.");
  expect(out.tools[0].description).toBe("Account balance");
  expect(out.tools[1]).toEqual({ type: "web_search" });
  const call = (out.input as Payload[]).find(
    (i) => i.call_id === "call_1" && i.type === "function_call"
  )!;
  expect(JSON.parse(call.arguments)).toEqual({ acct: "B-2" });
  expect(call.id).toBe("fc_1");
});

it("reads a Gemini tool's JSON Schema and keeps it where it was", () => {
  const payload = structuredClone(GEMINI);
  const declaration = payload.tools[0].functionDeclarations[0];
  declaration.parametersJsonSchema = declaration.parameters;
  delete declaration.parameters;
  const conversation = view("gemini", payload);
  expect(conversation.tools[0]!.parameters).toEqual({
    type: "object",
    properties: {},
  });
  conversation.tools[0]!.description = "Account balance";
  const edited = write("gemini", payload, conversation).tools[0]
    .functionDeclarations[0];
  expect(edited.parameters).toBeUndefined();
  expect(edited.parametersJsonSchema).toEqual(declaration.parametersJsonSchema);
});
