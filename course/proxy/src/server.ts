/** The forwarding proxy: `/t/<trial>/<provider>/<path>` goes to the provider
 *  with the real key injected, the reply is relayed as it streams, and every
 *  model call is recorded with the trial and turn it belongs to. */

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PROVIDERS, type Provider } from "@context-cup/shared/provider.js";
import express, { type Request, type Response } from "express";
import { parseCall, wireForPath } from "./parsers.ts";
import { CallLog, TrialState, type CallRecord } from "./records.ts";

export type ProxyOptions = {
  port?: number;
  callsFile?: string;
  bodiesDir?: string;
  /** Provider keys; defaults to the process env. */
  env?: Record<string, string | undefined>;
  /** The run's target: filled in where a call names no model or names
   *  {@link MODEL_ALIAS}. A model the caller named is never changed. */
  defaultModel?: DefaultModel;
};

export type DefaultModel = { provider: Provider; model: string };

/** The model name that means "the run's target model". */
export const MODEL_ALIAS = "cc-model";

/** Fill in the run's model where a model call names none or names the alias.
 *  Anything else passes through byte for byte. */
export function resolveModel(
  provider: Provider,
  path: string,
  body: Buffer,
  fallback: DefaultModel | undefined
): { path: string; body: Buffer } | { error: string } {
  const target = fallback?.provider === provider ? fallback.model : undefined;
  if (provider === "gemini") {
    const m = /^(.*\/models\/)([^/:]+)(:.*)$/.exec(path);
    if (!m || m[2] !== MODEL_ALIAS) return { path, body };
    if (!target)
      return { error: `no ${provider} model for ${MODEL_ALIAS} in this run` };
    return { path: `${m[1]}${target}${m[3]}`, body };
  }
  if (!wireForPath(path) || body.length === 0) return { path, body };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return { path, body };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { path, body };
  }
  const request = parsed as { model?: unknown };
  const named = request.model;
  if (named !== undefined && named !== MODEL_ALIAS) return { path, body };
  if (!target) {
    if (named === MODEL_ALIAS) {
      return { error: `no ${provider} model for ${MODEL_ALIAS} in this run` };
    }
    return { path, body };
  }
  return {
    path,
    body: Buffer.from(JSON.stringify({ ...request, model: target })),
  };
}

export type RunningProxy = {
  port: number;
  url: string;
  close: () => Promise<void>;
};

const DEFAULT_UPSTREAM: Record<Provider, string> = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
};
const UPSTREAM_ENV: Record<Provider, string> = {
  openai: "CC_UPSTREAM_OPENAI",
  anthropic: "CC_UPSTREAM_ANTHROPIC",
  gemini: "CC_UPSTREAM_GEMINI",
};
const KEY_ENV: Record<Provider, string[]> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};
const ANTHROPIC_VERSION = "2023-06-01";

/** Headers that must not be relayed in either direction. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);
/** Credentials the client may send as placeholders; never forwarded. */
const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "x-goog-api-key",
]);

const ROUTE = /^\/t\/([^/]+)\/(openai|anthropic|gemini)(\/.*)$/;

export function upstreamFor(
  provider: Provider,
  env: Record<string, string | undefined>
): string {
  return (env[UPSTREAM_ENV[provider]] || DEFAULT_UPSTREAM[provider]).replace(
    /\/+$/,
    ""
  );
}

function keyFor(
  provider: Provider,
  env: Record<string, string | undefined>
): string | undefined {
  for (const name of KEY_ENV[provider]) {
    if (env[name]) return env[name];
  }
  return undefined;
}

function authHeaders(provider: Provider, key: string): Record<string, string> {
  if (provider === "openai") return { authorization: `Bearer ${key}` };
  if (provider === "anthropic") return { "x-api-key": key };
  return { "x-goog-api-key": key };
}

export function createApp(options: ProxyOptions) {
  const env = options.env ?? process.env;
  const log = new CallLog(
    options.callsFile ?? "calls.jsonl",
    options.bodiesDir
  );
  const state = new TrialState();
  const app = express();
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/t/:trial_id/turn", express.json(), (req, res) => {
    const turn_id = (req.body as { turn_id?: unknown })?.turn_id;
    if (typeof turn_id !== "string" || turn_id.length === 0) {
      res.status(400).json({ error: "turn_id (string) is required" });
      return;
    }
    state.setTurn(String(req.params.trial_id), turn_id);
    res.status(204).end();
  });

  app.use(express.raw({ type: () => true, limit: "64mb" }));

  app.use(async (req, res, next) => {
    const match = ROUTE.exec(req.path);
    if (!match) {
      next();
      return;
    }
    // Codex first tries the Responses API over a WebSocket. This proxy speaks
    // HTTP only; a fast, clear refusal makes the client fall back to HTTP
    // streaming instead of retrying against an unrelated upstream error.
    if ((req.headers.upgrade ?? "").toLowerCase() === "websocket") {
      res.status(426).json({
        error: "the course proxy speaks HTTP only; use HTTP streaming",
      });
      return;
    }
    const trial_id = decodeURIComponent(match[1]!);
    const provider = match[2] as Provider;
    const rest = match[3]!;
    const query = req.originalUrl.includes("?")
      ? req.originalUrl.slice(req.originalUrl.indexOf("?"))
      : "";
    const key = keyFor(provider, env);
    if (!key) {
      res.status(503).json({
        error: `proxy has no key for ${provider}: set ${KEY_ENV[provider].join(" or ")}`,
      });
      return;
    }
    const resolved = resolveModel(
      provider,
      rest,
      Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
      options.defaultModel
    );
    if ("error" in resolved) {
      res.status(400).json({ error: resolved.error });
      return;
    }
    const requestBody = resolved.body;
    const forwardPath = resolved.path;
    const upstream = upstreamFor(provider, env);
    const url = `${upstream}${forwardPath}${query}`;
    const host = new URL(url).hostname;
    const started = Date.now();
    const started_at = new Date(started).toISOString();
    const purpose = firstHeader(req, "x-cc-purpose") ?? "turn";

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      if (HOP_BY_HOP.has(lower) || CREDENTIAL_HEADERS.has(lower)) continue;
      if (lower === "x-cc-purpose") continue;
      if (typeof value === "string") headers[lower] = value;
      else if (Array.isArray(value)) headers[lower] = value.join(", ");
    }
    if (provider === "anthropic" && !headers["anthropic-version"]) {
      headers["anthropic-version"] = ANTHROPIC_VERSION;
    }
    Object.assign(headers, authHeaders(provider, key));

    let upstreamResponse: globalThis.Response;
    try {
      upstreamResponse = await fetch(url, {
        method: req.method,
        headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : requestBody,
        redirect: "manual",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res
        .status(502)
        .json({ error: `upstream ${host} unreachable: ${message}` });
      record(null, 502, Buffer.alloc(0), `upstream unreachable: ${message}`);
      return;
    }

    res.status(upstreamResponse.status);
    upstreamResponse.headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      // fetch decoded the body, so its encoding and length no longer apply.
      if (HOP_BY_HOP.has(lower) || lower === "content-encoding") return;
      res.setHeader(name, value);
    });
    const contentType = upstreamResponse.headers.get("content-type") ?? "";

    const chunks: Buffer[] = [];
    if (upstreamResponse.body) {
      res.flushHeaders();
      const reader = upstreamResponse.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          chunks.push(chunk);
          if (!res.writableEnded) res.write(chunk);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        record(
          contentType,
          upstreamResponse.status,
          Buffer.concat(chunks),
          `upstream stream failed: ${message}`
        );
        res.end();
        return;
      }
    }
    res.end();
    record(contentType, upstreamResponse.status, Buffer.concat(chunks));

    function record(
      responseContentType: string | null,
      status: number,
      responseBody: Buffer,
      error?: string
    ): void {
      const parsed = parseCall({
        host,
        path: forwardPath,
        requestBody,
        responseBody,
        contentType: responseContentType ?? "",
      });
      if (!parsed) return; // not a model call; forwarded, not recorded
      const rec: CallRecord = {
        trial_id,
        turn_id: state.turn(trial_id),
        sequence: state.nextSequence(trial_id),
        purpose,
        provider: parsed.provider,
        host: parsed.host,
        model: parsed.model,
        wire: parsed.wire,
        usage: parsed.usage,
        duration_ms: Date.now() - started,
        status,
        service_tier: parsed.service_tier,
        request_bytes: requestBody.length,
        response_bytes: responseBody.length,
        streamed: parsed.streamed,
        started_at,
      };
      if (parsed.model === null)
        rec.error = error ? `no model; ${error}` : "no model";
      else if (error) rec.error = error;
      log.write(rec);
      log.saveBodies(rec, url, requestBody, responseBody);
    }
  });

  app.use((_req, res) => {
    res.status(404).json({
      error: `unknown route; use /t/<trial_id>/<${PROVIDERS.join("|")}>/<provider path> or /t/<trial_id>/turn`,
    });
  });

  return app;
}

function firstHeader(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export async function startProxy(
  options: ProxyOptions = {}
): Promise<RunningProxy> {
  const app = createApp(options);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(options.port ?? 0, "127.0.0.1", () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export type { Response as ExpressResponse };
