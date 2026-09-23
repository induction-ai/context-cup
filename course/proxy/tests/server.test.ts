import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import {
  createServer,
  request,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startProxy, type RunningProxy } from "../src/server.ts";

type Seen = {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
};

/** A fake provider: records what it received and answers per path. */
function fakeUpstream(): Promise<{
  server: Server;
  url: string;
  seen: Seen[];
}> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body,
      });
      route(req, res, body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${port}`, seen });
    });
  });
}

function route(req: IncomingMessage, res: ServerResponse, body: string): void {
  const url = req.url ?? "";
  if (url.startsWith("/v1/responses")) {
    const request = JSON.parse(body || "{}") as {
      stream?: boolean;
      model?: string;
    };
    if (request.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        'data: {"type":"response.created","response":{"model":"gpt-5.5"}}\n\n'
      );
      setTimeout(() => {
        res.write(
          'data: {"type":"response.completed","response":{"model":"gpt-5.5","usage":{"input_tokens":11,"output_tokens":4}}}\n\ndata: [DONE]\n\n'
        );
        res.end();
      }, 150);
      return;
    }
    if (request.model === "boom") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "upstream exploded" }));
      return;
    }
    res.writeHead(200, {
      "content-type": "application/json",
      "x-request-id": "req_1",
    });
    res.end(
      JSON.stringify({
        id: "resp_1",
        model: "gpt-5.5-2026-04-23",
        service_tier: "default",
        usage: { input_tokens: 9, output_tokens: 2 },
      })
    );
    return;
  }
  if (url.startsWith("/v1/messages")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 5, output_tokens: 1 },
      })
    );
    return;
  }
  if (url.includes(":generateContent")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 },
      })
    );
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ data: [] }));
}

let upstream: Awaited<ReturnType<typeof fakeUpstream>>;
let proxy: RunningProxy;
let callsFile: string;
let bodiesDir: string;

beforeAll(async () => {
  upstream = await fakeUpstream();
  const dir = mkdtempSync(path.join(tmpdir(), "cc-proxy-"));
  callsFile = path.join(dir, "calls.jsonl");
  bodiesDir = path.join(dir, "bodies");
  proxy = await startProxy({
    callsFile,
    bodiesDir,
    env: {
      OPENAI_API_KEY: "sk-real",
      ANTHROPIC_API_KEY: "ak-real",
      GEMINI_API_KEY: "gk-real",
      CC_UPSTREAM_OPENAI: upstream.url,
      CC_UPSTREAM_ANTHROPIC: upstream.url,
      CC_UPSTREAM_GEMINI: upstream.url,
    },
  });
});

afterAll(async () => {
  await proxy.close();
  upstream.server.close();
});

beforeEach(() => {
  upstream.seen.length = 0;
});

function records(): Array<Record<string, unknown>> {
  if (!existsSync(callsFile)) return [];
  return readFileSync(callsFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("proxy", () => {
  it("answers healthz", async () => {
    const r = await fetch(`${proxy.url}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it("injects the real key, strips the placeholder, and records an openai call", async () => {
    const r = await fetch(`${proxy.url}/t/trial-a/openai/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer cc-local",
      },
      body: JSON.stringify({ model: "gpt-5.5", input: "hi" }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-request-id")).toBe("req_1");
    expect(((await r.json()) as { id: string }).id).toBe("resp_1");
    const seen = upstream.seen[0]!;
    expect(seen.url).toBe("/v1/responses");
    expect(seen.headers.authorization).toBe("Bearer sk-real");
    expect(seen.body).toContain('"model":"gpt-5.5"');
    const rec = records().at(-1)!;
    expect(rec).toMatchObject({
      trial_id: "trial-a",
      turn_id: null,
      sequence: 1,
      purpose: "turn",
      provider: "openai",
      model: "gpt-5.5-2026-04-23",
      wire: "responses",
      usage: {
        input: 9,
        cached_input: 0,
        cache_write_input: 0,
        output: 2,
        reasoning_output: 0,
      },
      status: 200,
      service_tier: "default",
      streamed: false,
    });
    expect(typeof rec.duration_ms).toBe("number");
    expect(typeof rec.started_at).toBe("string");
    expect(readdirSync(path.join(bodiesDir, "trial-a"))).toContain(
      "001_request.json"
    );
  });

  it("maps anthropic and gemini paths with their own key headers", async () => {
    await fetch(`${proxy.url}/t/trial-b/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "placeholder",
      },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });
    await fetch(
      `${proxy.url}/t/trial-b/gemini/v1beta/models/gemini-3.1-pro:generateContent?alt=x`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [] }),
      }
    );
    const [a, g] = upstream.seen;
    expect(a!.headers["x-api-key"]).toBe("ak-real");
    expect(a!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(g!.url).toBe("/v1beta/models/gemini-3.1-pro:generateContent?alt=x");
    expect(g!.headers["x-goog-api-key"]).toBe("gk-real");
    const last2 = records().slice(-2);
    expect(last2.map((r) => [r.provider, r.wire, r.sequence])).toEqual([
      ["anthropic", "anthropic", 1],
      ["gemini", "gemini", 2],
    ]);
    expect(last2[1]!.model).toBe("gemini-3.1-pro");
  });

  it("relays a stream incrementally and still parses it", async () => {
    const started = Date.now();
    const r = await fetch(`${proxy.url}/t/trial-c/openai/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", input: "hi", stream: true }),
    });
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const reader = r.body!.getReader();
    const arrivals: number[] = [];
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
      arrivals.push(Date.now() - started);
    }
    expect(arrivals.length).toBeGreaterThanOrEqual(2);
    expect(arrivals.at(-1)! - arrivals[0]!).toBeGreaterThanOrEqual(100);
    const rec = records().at(-1)!;
    expect(rec.streamed).toBe(true);
    expect(rec.usage).toMatchObject({ input: 11, output: 4 });
  });

  it("tags calls with the current turn and honours x-cc-purpose", async () => {
    const t = await fetch(`${proxy.url}/t/trial-d/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turn_id: "003_abc123" }),
    });
    expect(t.status).toBe(204);
    await fetch(`${proxy.url}/t/trial-d/openai/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cc-purpose": "summarize",
      },
      body: JSON.stringify({ model: "gpt-5.5", input: "x" }),
    });
    const rec = records().at(-1)!;
    expect(rec.turn_id).toBe("003_abc123");
    expect(rec.purpose).toBe("summarize");
    expect(upstream.seen[0]!.headers["x-cc-purpose"]).toBeUndefined();
    const bad = await fetch(`${proxy.url}/t/trial-d/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(bad.status).toBe(400);
  });

  it("forwards unrecognised paths without recording", async () => {
    const before = records().length;
    const r = await fetch(`${proxy.url}/t/trial-e/openai/v1/models`);
    expect(r.status).toBe(200);
    expect(upstream.seen[0]!.url).toBe("/v1/models");
    expect(records().length).toBe(before);
  });

  it("relays an upstream 500 with its status and records it", async () => {
    const r = await fetch(`${proxy.url}/t/trial-f/openai/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "boom", input: "x" }),
    });
    expect(r.status).toBe(500);
    expect(((await r.json()) as { error: string }).error).toBe(
      "upstream exploded"
    );
    const rec = records().at(-1)!;
    expect(rec.status).toBe(500);
    expect(rec.model).toBe("boom");
    expect(rec.usage).toBeNull();
  });

  it("records a call that names no model with an error, not by dropping it", async () => {
    await fetch(`${proxy.url}/t/trial-g/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    // The fake answers with a model, so force the no-model case via a body the
    // fake cannot answer with one: chat completions echo nothing.
    await fetch(`${proxy.url}/t/trial-g/openai/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const rec = records().at(-1)!;
    expect(rec.wire).toBe("completions");
    expect(rec.model).toBeNull();
    expect(rec.error).toBe("no model");
  });

  it("refuses a provider it has no key for and unknown routes", async () => {
    const noKey = await startProxy({
      callsFile: path.join(tmpdir(), "cc-nokey.jsonl"),
      env: {},
    });
    try {
      const r = await fetch(`${noKey.url}/t/x/openai/v1/responses`, {
        method: "POST",
        body: "{}",
      });
      expect(r.status).toBe(503);
    } finally {
      await noKey.close();
    }
    const r = await fetch(`${proxy.url}/nope`);
    expect(r.status).toBe(404);
  });
});

describe("websocket upgrades", () => {
  it("are refused with 426 and never forwarded or recorded", async () => {
    const before = records().length;
    // fetch refuses to send an Upgrade header, so go through node:http.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        `${proxy.url}/t/trial-ws/openai/v1/responses`,
        {
          method: "POST",
          headers: { upgrade: "websocket", connection: "Upgrade" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        }
      );
      req.on("error", reject);
      req.end("{}");
    });
    expect(status).toBe(426);
    expect(upstream.seen).toHaveLength(0);
    expect(records()).toHaveLength(before);
  });
});
