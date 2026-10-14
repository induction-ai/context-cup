import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  beforeEach,
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import {
  bakeMcpAuthIntoTaskConfigs,
  MCP_REMOTE_VERSION,
  mcpTokensFile,
  refreshMcpAuthIfStale,
  requireLiveMcpAuth,
  resetBakeState,
} from "../src/mcp_auth.ts";

const NOW = new Date("2026-09-23T12:00:00Z");

/** An mcp-remote login under a fresh dir, its tokens written `ageMinutes`
 *  before NOW with an 8 hour lifetime. Without `refresh` it is a CI suite's
 *  copy: the access token alone. */
function login(
  ageMinutes: number,
  { refresh = true }: { refresh?: boolean } = {}
): { dir: string; tokens: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "cc-mcp-"));
  const state = path.join(dir, `mcp-remote-${MCP_REMOTE_VERSION}`);
  mkdirSync(state);
  const tokens = path.join(state, "abc_tokens.json");
  writeFileSync(
    tokens,
    JSON.stringify({
      access_token: "old-access",
      ...(refresh ? { refresh_token: "old-refresh" } : {}),
      expires_in: 8 * 3600,
      token_type: "bearer",
    })
  );
  writeFileSync(
    path.join(state, "abc_client_info.json"),
    JSON.stringify({ client_id: "client-1" })
  );
  const at = new Date(NOW.getTime() - ageMinutes * 60_000);
  utimesSync(tokens, at, at);
  return { dir, tokens };
}

type Call = { url: string; body: string | null };

function oauthFetch(tokenStatus = 200): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? String(init.body) : null });
    if (url.endsWith("/.well-known/oauth-authorization-server")) {
      return Response.json({ token_endpoint: "https://auth.test/token" });
    }
    return tokenStatus === 200
      ? Response.json({
          access_token: "new-access",
          refresh_token: "new-refresh",
        })
      : new Response("invalid_grant", { status: tokenStatus });
  };
  return { fetch: impl as typeof fetch, calls };
}

describe("refreshMcpAuthIfStale", () => {
  it("leaves a token with plenty of life alone", async () => {
    const { dir, tokens } = login(60);
    const { fetch, calls } = oauthFetch();
    await refreshMcpAuthIfStale(() => {}, { dir, fetch, now: NOW });
    expect(calls).toEqual([]);
    expect(JSON.parse(readFileSync(tokens, "utf8")).refresh_token).toBe(
      "old-refresh"
    );
  });

  it("rotates a token near expiry, keeping fields the response leaves out", async () => {
    const { dir, tokens } = login(7.5 * 60);
    const { fetch, calls } = oauthFetch();
    const lines: string[] = [];
    await refreshMcpAuthIfStale((l) => lines.push(l), { dir, fetch, now: NOW });
    expect(calls[1]!.url).toBe("https://auth.test/token");
    expect(Object.fromEntries(new URLSearchParams(calls[1]!.body!))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "old-refresh",
      client_id: "client-1",
    });
    expect(JSON.parse(readFileSync(tokens, "utf8"))).toEqual({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 8 * 3600,
      token_type: "bearer",
    });
    expect(lines).toEqual([
      "harbor: refreshed the notion MCP token (30m of life left)",
    ]);
  });

  it("refreshes under the caller's own threshold", async () => {
    const { dir, tokens } = login(2 * 60);
    const { fetch, calls } = oauthFetch();
    await refreshMcpAuthIfStale(() => {}, { dir, fetch, now: NOW });
    expect(calls).toEqual([]);
    await refreshMcpAuthIfStale(() => {}, {
      dir,
      fetch,
      now: NOW,
      when_under_min: 420,
    });
    expect(calls.map((c) => c.url)).toEqual([
      "https://auth.test/.well-known/oauth-authorization-server".replace(
        "https://auth.test",
        "https://mcp.notion.com"
      ),
      "https://auth.test/token",
    ]);
    expect(JSON.parse(readFileSync(tokens, "utf8")).refresh_token).toBe(
      "new-refresh"
    );
  });

  it("leaves a stale token without a refresh token alone, saying so", async () => {
    const { dir, tokens } = login(7.5 * 60, { refresh: false });
    const { fetch, calls } = oauthFetch();
    const lines: string[] = [];
    await refreshMcpAuthIfStale((l) => lines.push(l), { dir, fetch, now: NOW });
    expect(calls).toEqual([]);
    expect(lines).toEqual([
      "harbor: the notion MCP token has 30m of life left and no refresh token here, so it stays as it is",
    ]);
    expect(JSON.parse(readFileSync(tokens, "utf8")).access_token).toBe(
      "old-access"
    );
  });

  it("fails loudly on a dead grant", async () => {
    const { dir } = login(9 * 60);
    const { fetch } = oauthFetch(400);
    await expect(
      refreshMcpAuthIfStale(() => {}, { dir, fetch, now: NOW })
    ).rejects.toThrow(/refresh rejected \(400\): the grant is dead/);
  });

  it("does nothing without a login", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cc-mcp-"));
    expect(mcpTokensFile(dir)).toBeUndefined();
    await refreshMcpAuthIfStale(() => {}, { dir, fetch: oauthFetch().fetch });
  });
});

describe("requireLiveMcpAuth", () => {
  type Probe = { authorization: string | null; body: string | null };

  function probeFetch(verdict: number | Error): {
    fetch: typeof fetch;
    probes: Probe[];
  } {
    const probes: Probe[] = [];
    const impl = async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://mcp.notion.com/mcp");
      probes.push({
        authorization: new Headers(init?.headers).get("authorization"),
        body: init?.body ? String(init.body) : null,
      });
      if (verdict instanceof Error) throw verdict;
      return new Response("{}", { status: verdict });
    };
    return { fetch: impl as typeof fetch, probes };
  }

  it("sends the access token with an initialize request and reports the verdict", async () => {
    const { dir } = login(0);
    const { fetch, probes } = probeFetch(200);
    const lines: string[] = [];
    await requireLiveMcpAuth((l) => lines.push(l), { dir, fetch });
    expect(probes).toHaveLength(1);
    expect(probes[0]!.authorization).toBe("Bearer old-access");
    expect(JSON.parse(probes[0]!.body!).method).toBe("initialize");
    expect(lines).toEqual([
      "harbor: notion MCP accepted the access token (HTTP 200)",
    ]);
  });

  it("fails loudly when Notion rejects the token", async () => {
    const { dir } = login(0);
    const { fetch } = probeFetch(401);
    await expect(requireLiveMcpAuth(() => {}, { dir, fetch })).rejects.toThrow(
      /rejected the access token \(401\): the grant is dead/
    );
  });

  it("lets a transport failure pass, saying so", async () => {
    const { dir } = login(0);
    const { fetch } = probeFetch(new Error("fetch failed\nsomething"));
    const lines: string[] = [];
    await requireLiveMcpAuth((l) => lines.push(l), { dir, fetch });
    expect(lines).toEqual([
      "harbor: the notion MCP probe did not reach the server (fetch failed)",
    ]);
  });

  it("does nothing without a login", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cc-mcp-"));
    const { fetch, probes } = probeFetch(401);
    await requireLiveMcpAuth(() => {}, { dir, fetch });
    expect(probes).toEqual([]);
  });
});

describe("bakeMcpAuthIntoTaskConfigs", () => {
  beforeEach(() => resetBakeState());

  function tasksDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "cc-tasks-"));
    for (const task of ["notion-hr", "sales-accounting"]) {
      mkdirSync(path.join(dir, task, "environment"), { recursive: true });
    }
    return dir;
  }

  const entries = (zip: string) =>
    execFileSync("unzip", ["-Z1", zip]).toString().trim().split("\n").sort();

  it("bakes the access token without the refresh token", async () => {
    const { dir } = login(0);
    const tasks = tasksDir();
    bakeMcpAuthIntoTaskConfigs(tasks, () => {}, dir);
    const baked = execFileSync("unzip", [
      "-p",
      path.join(tasks, "notion-hr/environment/configs.zip"),
      `.mcp-auth/mcp-remote-${MCP_REMOTE_VERSION}/abc_tokens.json`,
    ]).toString();
    expect(JSON.parse(baked)).toEqual({
      access_token: "old-access",
      expires_in: 8 * 3600,
      token_type: "bearer",
    });
  });

  it("adds .mcp-auth/ to the notion tasks' configs.zip only, once per token", async () => {
    const { dir } = login(0);
    const tasks = tasksDir();
    const lines: string[] = [];
    bakeMcpAuthIntoTaskConfigs(tasks, (l) => lines.push(l), dir);
    expect(
      entries(path.join(tasks, "notion-hr/environment/configs.zip"))
    ).toEqual([
      ".mcp-auth/",
      `.mcp-auth/mcp-remote-${MCP_REMOTE_VERSION}/`,
      `.mcp-auth/mcp-remote-${MCP_REMOTE_VERSION}/abc_client_info.json`,
      `.mcp-auth/mcp-remote-${MCP_REMOTE_VERSION}/abc_tokens.json`,
    ]);
    expect(() =>
      readFileSync(path.join(tasks, "sales-accounting/environment/configs.zip"))
    ).toThrow();
    bakeMcpAuthIntoTaskConfigs(tasks, (l) => lines.push(l), dir);
    expect(lines).toEqual([
      "harbor: baked notion MCP state into 1 task config zip(s)",
    ]);
  });
});
