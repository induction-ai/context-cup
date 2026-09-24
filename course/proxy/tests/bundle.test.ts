import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildProxyBundle } from "../src/bundle.ts";

/** The bundle is what trial containers run: one file, a bare `node`, keys
 *  from the env, and the run's model filled in for the alias. */
describe("proxy bundle", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cc-bundle-"));
  const calls = path.join(dir, "calls.jsonl");
  const seen: { auth?: string; model?: string }[] = [];
  let upstream: Server;
  let child: ChildProcess;
  let url: string;

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        seen.push({
          auth: req.headers.authorization,
          model: (JSON.parse(body) as { model?: string }).model,
        });
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            id: "resp_1",
            object: "response",
            model: "gpt-test",
            output: [],
            usage: { input_tokens: 10, output_tokens: 2 },
          })
        );
      });
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve)
    );
    const port = (upstream.address() as { port: number }).port;

    const bundle = await buildProxyBundle(path.join(dir, "proxy.cjs"));
    child = spawn(
      process.execPath,
      [
        bundle,
        "--port",
        "0",
        "--calls",
        calls,
        "--default-provider",
        "openai",
        "--default-model",
        "gpt-test",
      ],
      {
        cwd: dir,
        env: {
          PATH: process.env.PATH,
          OPENAI_API_KEY: "sk-bundle",
          CC_UPSTREAM_OPENAI: `http://127.0.0.1:${port}`,
        },
      }
    );
    url = await new Promise<string>((resolve, reject) => {
      child.stdout!.on("data", (chunk: Buffer) => {
        const m = /listening (\S+)/.exec(chunk.toString());
        if (m) resolve(m[1]!);
      });
      child.once("exit", (code) => reject(new Error(`proxy exited ${code}`)));
    });
  }, 60_000);

  afterAll(() => {
    child?.kill("SIGTERM");
    upstream?.close();
  });

  it("answers /healthz", async () => {
    const res = await fetch(`${url}/healthz`);
    expect(res.ok).toBe(true);
  });

  it("injects the key, fills in the model, and records the call", async () => {
    const res = await fetch(`${url}/t/trial-1/openai/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer cc-proxy",
      },
      body: JSON.stringify({ model: "cc-model", input: "hi" }),
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(seen.at(-1)).toEqual({
      auth: "Bearer sk-bundle",
      model: "gpt-test",
    });
    const lines = readFileSync(calls, "utf8").trim().split("\n");
    const record = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    expect(record.trial_id).toBe("trial-1");
    expect(JSON.stringify(record)).not.toContain("sk-bundle");
  });
});
