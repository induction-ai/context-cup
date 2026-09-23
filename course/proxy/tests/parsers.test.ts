import { describe, expect, it } from "vitest";
import { parseCall, sseJsonEvents, wireForPath } from "../src/parsers.ts";

const sse = (...events: object[]) =>
  Buffer.from(
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") +
      "data: [DONE]\n\n"
  );

function call(
  host: string,
  path: string,
  request: object,
  body: Buffer | string,
  contentType = "application/json"
) {
  return parseCall({
    host,
    path,
    requestBody: Buffer.from(JSON.stringify(request)),
    responseBody: Buffer.isBuffer(body) ? body : Buffer.from(body),
    contentType,
  });
}

describe("wireForPath", () => {
  it("recognises the four model-call paths and nothing else", () => {
    expect(wireForPath("/v1/responses")).toBe("responses");
    expect(wireForPath("/v1/chat/completions?x=1")).toBe("completions");
    expect(wireForPath("/v1/messages")).toBe("anthropic");
    expect(wireForPath("/v1beta/models/gemini-3.1-pro:generateContent")).toBe(
      "gemini"
    );
    expect(wireForPath("/v1beta/models/g:streamGenerateContent?alt=sse")).toBe(
      "gemini"
    );
    expect(wireForPath("/v1/models")).toBeNull();
  });
});

describe("parseCall", () => {
  it("openai responses, plain", () => {
    const c = call(
      "api.openai.com",
      "/v1/responses",
      { model: "gpt-5.5" },
      JSON.stringify({
        model: "gpt-5.5-2026-01-01",
        service_tier: "default",
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 60 },
          output_tokens: 30,
          output_tokens_details: { reasoning_tokens: 10 },
        },
      })
    )!;
    expect(c.provider).toBe("openai");
    expect(c.wire).toBe("responses");
    expect(c.model).toBe("gpt-5.5-2026-01-01");
    expect(c.usage).toEqual({
      input: 100,
      cached_input: 60,
      cache_write_input: 0,
      output: 30,
      reasoning_output: 10,
    });
    expect(c.streamed).toBe(false);
    expect(c.service_tier).toBe("default");
  });

  it("openai responses, streamed: takes the completed event", () => {
    const body = sse(
      { type: "response.created", response: { model: "gpt-5.5" } },
      { type: "response.output_text.delta", delta: "hi" },
      {
        type: "response.completed",
        response: {
          model: "gpt-5.5",
          usage: { input_tokens: 5, output_tokens: 7 },
        },
      }
    );
    const c = call(
      "api.openai.com",
      "/v1/responses",
      { model: "gpt-5.5", stream: true },
      body,
      "text/event-stream"
    )!;
    expect(c.streamed).toBe(true);
    expect(c.usage?.input).toBe(5);
    expect(c.usage?.output).toBe(7);
  });

  it("chat completions streamed without usage is recorded without usage", () => {
    const body = sse({
      model: "gpt-5.5",
      choices: [{ delta: { content: "x" } }],
    });
    const c = call(
      "api.openai.com",
      "/v1/chat/completions",
      { model: "gpt-5.5", stream: true },
      body,
      "text/event-stream"
    )!;
    expect(c.wire).toBe("completions");
    expect(c.usage).toBeNull();
    expect(c.model).toBe("gpt-5.5");
  });

  it("chat completions plain", () => {
    const c = call(
      "api.openai.com",
      "/v1/chat/completions",
      { model: "gpt-5.5" },
      JSON.stringify({
        model: "gpt-5.5",
        usage: {
          prompt_tokens: 40,
          completion_tokens: 8,
          prompt_tokens_details: { cached_tokens: 16 },
          completion_tokens_details: { reasoning_tokens: 2 },
        },
      })
    )!;
    expect([
      c.usage?.input,
      c.usage?.cached_input,
      c.usage?.output,
      c.usage?.reasoning_output,
    ]).toEqual([40, 16, 8, 2]);
  });

  it("anthropic plain counts cache in input", () => {
    const c = call(
      "api.anthropic.com",
      "/v1/messages",
      { model: "claude-sonnet-4-6" },
      JSON.stringify({
        model: "claude-sonnet-4-6",
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 90,
          cache_creation_input_tokens: 5,
          output_tokens: 3,
        },
      })
    )!;
    expect(c.provider).toBe("anthropic");
    expect(c.wire).toBe("anthropic");
    expect(c.usage).toEqual({
      input: 105,
      cached_input: 90,
      cache_write_input: 5,
      output: 3,
      reasoning_output: 0,
    });
  });

  it("anthropic streamed merges message_start and message_delta", () => {
    const body = Buffer.from(
      'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":20,"cache_read_input_tokens":4,"output_tokens":1}}}\n\n' +
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n'
    );
    const c = call(
      "api.anthropic.com",
      "/v1/messages",
      { model: "claude-sonnet-4-6", stream: true },
      body,
      "text/event-stream"
    )!;
    expect(c.model).toBe("claude-sonnet-4-6");
    expect(c.usage).toEqual({
      input: 24,
      cached_input: 4,
      cache_write_input: 0,
      output: 42,
      reasoning_output: 0,
    });
  });

  it("gemini plain, model from the path", () => {
    const c = call(
      "generativelanguage.googleapis.com",
      "/v1beta/models/gemini-3.1-pro:generateContent",
      {},
      JSON.stringify({
        usageMetadata: {
          promptTokenCount: 50,
          candidatesTokenCount: 9,
          thoughtsTokenCount: 4,
          cachedContentTokenCount: 20,
        },
      })
    )!;
    expect(c.provider).toBe("gemini");
    expect(c.model).toBe("gemini-3.1-pro");
    expect(c.usage).toEqual({
      input: 50,
      cached_input: 20,
      cache_write_input: 0,
      output: 13,
      reasoning_output: 4,
    });
  });

  it("gemini streamed takes the last usage and the modelVersion", () => {
    const body = sse(
      { usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 1 } },
      {
        modelVersion: "gemini-3.1-pro-001",
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 9 },
      }
    );
    const c = call(
      "generativelanguage.googleapis.com",
      "/v1beta/models/gemini-3.1-pro:streamGenerateContent?alt=sse",
      {},
      body,
      "text/event-stream"
    )!;
    expect(c.model).toBe("gemini-3.1-pro-001");
    expect(c.usage?.output).toBe(9);
  });

  it("unknown host takes the provider from the wire and keeps the host", () => {
    const c = call(
      "gateway.example.invalid",
      "/v1/chat/completions",
      { model: "x" },
      JSON.stringify({
        model: "some-model",
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      })
    )!;
    expect(c.provider).toBe("openai");
    expect(c.host).toBe("gateway.example.invalid");
  });

  it("a call with no model anywhere has model null", () => {
    const c = call("api.openai.com", "/v1/chat/completions", {}, "{}")!;
    expect(c.model).toBeNull();
  });

  it("non-model paths are not calls", () => {
    expect(call("api.openai.com", "/v1/models", {}, "{}")).toBeNull();
  });

  it("sseJsonEvents skips comments, keepalives, and [DONE]", () => {
    const events = sseJsonEvents(
      Buffer.from(
        ': keepalive\n\ndata: {"a":1}\n\ndata: nope\n\ndata: [DONE]\n\n'
      )
    );
    expect(events).toEqual([{ a: 1 }]);
  });
});
