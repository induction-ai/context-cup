/** The AI SDK engine: the course's payloads as AI SDK messages, and
 *  `ctx.llm` against a stand-in provider on a local port. */
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Payload, Provider } from "@context-cup/protocol/models.js";
import { view } from "@context-cup/protocol/view.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AisdkContext,
  CONTEXT_SNAPSHOT,
  finish,
  route,
  targetSettings,
} from "../src/context.ts";
import { modelMessages, modelTools } from "../src/messages.ts";

const FIXTURES = JSON.parse(
  readFileSync(
    path.join(
      import.meta.dirname,
      "../../../course/protocol/tests/view_fixtures.json"
    ),
    "utf8"
  )
) as Record<Provider, Payload>;

function messagesOf(provider: Provider) {
  const payload = FIXTURES[provider];
  return modelMessages(provider, payload, view(provider, payload));
}

describe("modelMessages", () => {
  it("carries OpenAI's encrypted reasoning as reasoning parts", () => {
    const messages = messagesOf("openai");
    expect(messages.some((m) => m.role === "system")).toBe(false);
    const calls = messages.find(
      (m) => m.role === "assistant" && JSON.stringify(m).includes("tool-call")
    )!;
    expect(calls.content).toEqual([
      {
        type: "reasoning",
        text: "",
        providerOptions: {
          openai: { itemId: "rs_1", reasoningEncryptedContent: "enc==" },
        },
      },
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "get_balance",
        input: { acct: "A-1" },
      },
      {
        type: "tool-call",
        toolCallId: "call_2",
        toolName: "get_limits",
        input: {},
      },
    ]);
  });

  it("answers one turn's calls in one tool message", () => {
    const tools = messagesOf("anthropic").filter((m) => m.role === "tool");
    expect(tools).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "toolu_1",
            toolName: "get_balance",
            output: { type: "text", value: "balance 12 USD" },
          },
          {
            type: "tool-result",
            toolCallId: "toolu_2",
            toolName: "get_limits",
            output: { type: "text", value: "x".repeat(40) },
          },
        ],
      },
    ]);
  });

  it("carries Anthropic's signed thinking", () => {
    const assistant = messagesOf("anthropic").filter(
      (m) => m.role === "assistant"
    )[1]!;
    expect((assistant.content as unknown[])[0]).toEqual({
      type: "reasoning",
      text: "look it up",
      providerOptions: { anthropic: { signature: "sig==" } },
    });
  });

  it("puts Gemini's thought signatures back on their calls", () => {
    const assistant = messagesOf("gemini").filter(
      (m) => m.role === "assistant"
    )[1]!;
    const calls = (assistant.content as any[]).filter(
      (p) => p.type === "tool-call"
    );
    expect(calls.map((c) => c.providerOptions)).toEqual([
      { google: { thoughtSignature: "sig==" } },
      undefined,
    ]);
    expect((assistant.content as any[])[0]).toEqual({
      type: "reasoning",
      text: "planning",
    });
  });

  it("offers the course's function tools only", () => {
    const tools = modelTools(view("openai", FIXTURES.openai));
    expect(Object.keys(tools)).toEqual(["get_balance"]);
    expect(tools.get_balance!.execute).toBeUndefined();
  });
});

describe("targetSettings", () => {
  it("reads each provider's reasoning settings from its payload", () => {
    expect(targetSettings("openai", FIXTURES.openai)).toEqual({
      providerOptions: {
        openai: { reasoningEffort: "medium", reasoningSummary: null },
      },
    });
    expect(targetSettings("anthropic", FIXTURES.anthropic)).toEqual({
      providerOptions: {
        anthropic: { thinking: { type: "enabled", budgetTokens: 8192 } },
      },
      maxOutputTokens: 16384 - 8192,
    });
    expect(targetSettings("gemini", FIXTURES.gemini)).toEqual({
      providerOptions: {
        google: { thinkingConfig: { thinkingBudget: 8192 } },
      },
    });
  });
});

it("routes a model name to a provider", () => {
  expect(route("gpt-5.4-mini", "openai")).toEqual(["openai", "gpt-5.4-mini"]);
  expect(route("anthropic/claude-haiku-4-5", "openai")).toEqual([
    "anthropic",
    "claude-haiku-4-5",
  ]);
});

// -- ctx.llm against a stand-in provider ------------------------------------

type Seen = { url: string; headers: IncomingHttpHeaders; body: Payload };
const seen: Seen[] = [];

const OPENAI_RESPONSE = {
  id: "resp_1",
  object: "response",
  created_at: 1,
  model: "gpt-5.5",
  status: "completed",
  output: [
    {
      type: "function_call",
      id: "fc_9",
      call_id: "call_9",
      name: "get_balance",
      arguments: '{"acct":"A-1"}',
      status: "completed",
    },
  ],
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
};

const ANTHROPIC_RESPONSE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-haiku-4-5",
  content: [{ type: "text", text: "short" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 3, output_tokens: 1 },
};

const server = createServer((req, res) => {
  let data = "";
  req.on("data", (chunk) => (data += chunk));
  req.on("end", () => {
    seen.push({ url: req.url!, headers: req.headers, body: JSON.parse(data) });
    const body = req.url!.includes("/anthropic/")
      ? ANTHROPIC_RESPONSE
      : OPENAI_RESPONSE;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
});

let base: string;
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/t/trial`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function openaiTurn(state: string, first: boolean, payload: Payload) {
  return {
    protocol: 2 as const,
    trial_id: "trial",
    turn_id: first ? "001_aaaaaa" : "002_bbbbbb",
    turn_index: first ? 1 : 2,
    first,
    provider: {
      name: "openai" as const,
      api_key: "cc-proxy",
      client: { base_url: `${base}/openai/v1`, api: "responses" as const },
    },
    target: { model: "gpt-5.5", reasoning_effort: "medium" },
    context_payload: payload,
    original_payload: payload,
    state: {},
    limits: {},
    dirs: { turn: state, state },
  };
}

describe("ctx.llm", () => {
  it("sends the working conversation to the target and returns its raw body", async () => {
    const state = mkdtempSync(path.join(tmpdir(), "cc-aisdk-"));
    seen.length = 0;
    const ctx = new AisdkContext(openaiTurn(state, true, FIXTURES.openai));
    const result = await ctx.llm.generateText();
    expect(result.toolCalls.map((c) => c.toolName)).toEqual(["get_balance"]);
    expect(finish(ctx, result)).toEqual(OPENAI_RESPONSE);

    const [call] = seen;
    expect(call!.url).toBe("/t/trial/openai/v1/responses");
    expect(call!.headers["x-cc-purpose"]).toBe("turn");
    expect(call!.headers.authorization).toBe("Bearer cc-proxy");
    expect(call!.body).toMatchObject({
      model: "gpt-5.5",
      store: false,
      reasoning: { effort: "medium" },
    });
    expect(call!.body.reasoning.summary).toBeUndefined();
    expect(call!.body.input[0]).toEqual({
      role: "developer",
      content: "You are a bank agent.",
    });
    expect(call!.body.input).toContainEqual({
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "enc==",
      summary: [],
    });
    expect(call!.body.tools.map((t: Payload) => t.name)).toEqual([
      "get_balance",
    ]);

    // Next turn: the saved working copy, plus only what came in since.
    const kept = JSON.parse(
      readFileSync(path.join(state, CONTEXT_SNAPSHOT, "1.json"), "utf8")
    );
    expect(kept.instructions).toBe("You are a bank agent.");
    const next = structuredClone(FIXTURES.openai);
    next.input.push(...OPENAI_RESPONSE.output, {
      type: "function_call_output",
      call_id: "call_9",
      output: "12",
    });
    const second = new AisdkContext(openaiTurn(state, false, next));
    expect(second.contextMessages.slice(0, -2)).toEqual(kept.messages);
    expect(second.contextMessages.slice(-2).map((m) => m.role)).toEqual([
      "assistant",
      "tool",
    ]);

    // An attempt the runner throws away leaves nothing for its retry: the
    // retry starts again from the last accepted turn.
    second.contextMessages = [];
    finish(second, await second.llm.generateText({ prompt: "hi" }));
    const retry = new AisdkContext(openaiTurn(state, false, next));
    expect(retry.contextMessages).toEqual(
      new AisdkContext(openaiTurn(state, false, next)).contextMessages
    );
    expect(retry.contextMessages.slice(0, -2)).toEqual(kept.messages);
  });

  it("labels auxiliary calls and routes them to other providers", async () => {
    const state = mkdtempSync(path.join(tmpdir(), "cc-aisdk-"));
    seen.length = 0;
    const ctx = new AisdkContext(openaiTurn(state, true, FIXTURES.openai));
    const summary = await ctx.llm.generateText({
      model: "anthropic/claude-haiku-4-5",
      prompt: "Summarise: hello",
      tools: {},
      purpose: "summarize",
    });
    expect(summary.text).toBe("short");
    const [call] = seen;
    expect(call!.url).toBe("/t/trial/anthropic/v1/messages");
    expect(call!.headers["x-cc-purpose"]).toBe("summarize");
    expect(call!.headers["x-api-key"]).toBe("cc-proxy");
    // The target's thinking and effort are the target's alone.
    expect(call!.body.thinking).toBeUndefined();
    expect(call!.body.system).toBeUndefined();
    expect(() => finish(ctx, summary)).toThrow(/run's provider \(openai\)/);
    expect(() => finish(ctx, { text: "hi" })).toThrow(
      /must return a result of ctx.llm.generateText/
    );
  });
});
