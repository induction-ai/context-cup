import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  retryableReply,
  retryDelayMs,
  startProxy,
  type RunningProxy,
} from "../src/server.ts";

type Reply = { status: number; body: string; headers?: Record<string, string> };

const OK: Reply = {
  status: 200,
  body: JSON.stringify({
    model: "gpt-5.5",
    usage: { input_tokens: 5, output_tokens: 2 },
  }),
  headers: { "content-type": "application/json" },
};

/** An upstream that answers with each scripted reply in turn. */
async function scripted(
  replies: Reply[]
): Promise<{ server: Server; url: string; hits: () => number }> {
  let hits = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const reply = replies[Math.min(hits, replies.length - 1)]!;
      hits++;
      res.writeHead(
        reply.status,
        reply.headers ?? { "content-type": "application/json" }
      );
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${port}`, hits: () => hits };
}

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

async function proxyTo(
  upstream: string,
  waits: number[],
  lines: string[]
): Promise<{ proxy: RunningProxy; calls: string }> {
  const calls = path.join(
    mkdtempSync(path.join(tmpdir(), "cc-retry-")),
    "calls.jsonl"
  );
  const proxy = await startProxy({
    callsFile: calls,
    env: { OPENAI_API_KEY: "sk-test", CC_UPSTREAM_OPENAI: upstream },
    retry: {
      sleep: async (ms) => {
        waits.push(ms);
      },
      report: (line) => lines.push(line),
    },
  });
  cleanup.push(() => proxy.close());
  return { proxy, calls };
}

const post = (proxy: RunningProxy) =>
  fetch(`${proxy.url}/t/trial1/openai/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.5", input: "hi" }),
  });

describe("proxy retries", () => {
  it("retries a rate limit, honouring Retry-After, and relays the eventual success", async () => {
    const up = await scripted([
      {
        status: 429,
        body: '{"error":{"type":"rate_limit"}}',
        headers: { "retry-after": "3" },
      },
      { status: 503, body: "busy" },
      OK,
    ]);
    cleanup.push(() => void up.server.close());
    const waits: number[] = [];
    const lines: string[] = [];
    const { proxy, calls } = await proxyTo(up.url, waits, lines);
    const res = await post(proxy);
    expect(res.status).toBe(200);
    expect(up.hits()).toBe(3);
    expect(waits[0]).toBe(3000);
    expect(waits[1]).toBeGreaterThanOrEqual(4000);
    expect(lines[0]).toMatch(/^retry 1\/4 for trial1 .* \(status 429\)$/);
    // Every attempt is recorded, the retried ones with why.
    const recorded = readFileSync(calls, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(recorded.map((r) => [r.status, r.error])).toEqual([
      [429, "status 429, retried"],
      [503, "status 503, retried"],
      [200, undefined],
    ]);
  });

  it("never retries an exhausted quota, and relays it as it was", async () => {
    const body =
      '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}';
    const up = await scripted([{ status: 429, body }]);
    cleanup.push(() => void up.server.close());
    const waits: number[] = [];
    const { proxy } = await proxyTo(up.url, waits, []);
    const res = await post(proxy);
    expect(res.status).toBe(429);
    expect(await res.text()).toBe(body);
    expect(up.hits()).toBe(1);
    expect(waits).toEqual([]);
  });

  it("gives up after the last retry and relays the final failure", async () => {
    const up = await scripted([{ status: 500, body: "down" }]);
    cleanup.push(() => void up.server.close());
    const waits: number[] = [];
    const { proxy } = await proxyTo(up.url, waits, []);
    const res = await post(proxy);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("down");
    expect(up.hits()).toBe(5);
    expect(waits).toHaveLength(4);
  });

  it("classifies replies and backs off with jitter up to the cap", async () => {
    expect(retryableReply(429, "slow down")).toBe(true);
    expect(retryableReply(529, "")).toBe(true);
    expect(retryableReply(400, '{"error":"Overloaded"}')).toBe(true);
    expect(retryableReply(400, "bad request")).toBe(false);
    expect(retryableReply(429, "insufficient_quota")).toBe(false);
    const policy = { baseMs: 2_000, maxMs: 60_000 };
    expect(retryDelayMs(0, null, policy, () => 0)).toBe(2_000);
    expect(retryDelayMs(2, null, policy, () => 1)).toBe(12_000);
    expect(retryDelayMs(10, null, policy, () => 0)).toBe(60_000);
    expect(retryDelayMs(0, "7", policy)).toBe(7_000);
    expect(retryDelayMs(0, "3600", policy)).toBe(60_000);
    // An HTTP-date Retry-After falls back to backoff.
    expect(
      retryDelayMs(0, "Wed, 21 Oct 2026 07:28:00 GMT", policy, () => 0)
    ).toBe(2_000);
  });
});
