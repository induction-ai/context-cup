/**
 * Notion MCP OAuth state for the toolathlon tasks whose preprocess duplicates
 * a Notion page. Notion's hosted MCP is OAuth only: an access token of about
 * eight hours and a refresh token that rotates on every use, where reusing a
 * spent one revokes the whole grant. So exactly one holder may ever refresh.
 * Locally that holder is this process, with the state in `secrets/mcp`
 * (gitignored). In CI it is the Notion Grant Refresh workflow, which keeps
 * the `TOOLATHLON_MCP_AUTH_B64` secret fresh; a suite run restores the access
 * token only and never refreshes.
 *
 * Docker trials bind-mount `secrets/mcp` live. A Daytona sandbox cannot mount
 * a host path, so before each Daytona notion job the host refreshes a token
 * near expiry (when it holds the refresh token), checks that Notion still
 * accepts it, and bakes a copy without the refresh token into the notion
 * tasks' `configs.zip`, which the task image unzips into its configs.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPO_ROOT } from "@context-cup/shared/repo_root.js";
import { z } from "zod";
import { TOOLATHLON_NOTION_TASKS } from "./tasks.ts";

type Report = (line: string) => void;

export const MCP_AUTH_DIR = path.join(REPO_ROOT, "secrets", "mcp");

/** The mcp-remote version the task images vendor; it names the state dir. */
export const MCP_REMOTE_VERSION = "0.1.16";

const MCP_LOGIN_LOCAL = `run this, approve in the browser, then Ctrl-C once it prints "Proxy established successfully":\n  MCP_REMOTE_CONFIG_DIR=secrets/mcp npx -y mcp-remote@${MCP_REMOTE_VERSION} https://mcp.notion.com/mcp`;

/** CI gets its own grant, minted on a developer's machine and stored as the
 *  secret the Notion Grant Refresh workflow keeps fresh. */
const MCP_LOGIN_CI = `run this on your own machine, approve in the browser, then Ctrl-C once it prints "Proxy established successfully":
  mkdir /tmp/ci-grant
  MCP_REMOTE_CONFIG_DIR=/tmp/ci-grant npx -y mcp-remote@${MCP_REMOTE_VERSION} https://mcp.notion.com/mcp
  COPYFILE_DISABLE=1 tar czf - -C /tmp/ci-grant . | base64 | gh secret set TOOLATHLON_MCP_AUTH_B64
  rm -rf /tmp/ci-grant`;

export const MCP_LOGIN = process.env.GITHUB_ACTIONS
  ? MCP_LOGIN_CI
  : MCP_LOGIN_LOCAL;

const OAUTH_METADATA_URL =
  "https://mcp.notion.com/.well-known/oauth-authorization-server";

const MCP_ENDPOINT_URL = "https://mcp.notion.com/mcp";

/** Refresh when less than this much life is left, so a sandbox never starts
 *  on a nearly dead token (mcp-remote only refreshes expired ones). */
const REFRESH_UNDER_MINUTES = 60;

/** mcp-remote's tokens file under `dir`, if it has logged in. */
export function mcpTokensFile(dir: string = MCP_AUTH_DIR): string | undefined {
  const state = path.join(dir, `mcp-remote-${MCP_REMOTE_VERSION}`);
  if (!existsSync(state)) return undefined;
  const file = readdirSync(state).find((f) => f.endsWith("_tokens.json"));
  return file ? path.join(state, file) : undefined;
}

const zTokens = z.looseObject({
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
});
const zClientInfo = z.looseObject({ client_id: z.string().optional() });
const zMetadata = z.looseObject({ token_endpoint: z.string().optional() });

function readTokens(tokensPath: string): z.infer<typeof zTokens> {
  return zTokens.parse(JSON.parse(readFileSync(tokensPath, "utf8")));
}

type FetchOptions = { dir?: string; fetch?: typeof fetch };

/** Refresh the token when it is close to expiry. Throws on a dead grant
 *  rather than let notion tasks hang at their healthcheck. A file without a
 *  refresh token (a CI suite's copy) is left as it is. */
export async function refreshMcpAuthIfStale(
  report: Report,
  options: FetchOptions & { now?: Date; when_under_min?: number } = {}
): Promise<void> {
  const tokensPath = mcpTokensFile(options.dir);
  if (!tokensPath) return;
  const call = options.fetch ?? fetch;
  const tokens = readTokens(tokensPath);
  const now = (options.now ?? new Date()).getTime();
  const ageMinutes = (now - statSync(tokensPath).mtimeMs) / 60_000;
  const remaining = (tokens.expires_in ?? 0) / 60 - ageMinutes;
  if (remaining > (options.when_under_min ?? REFRESH_UNDER_MINUTES)) return;
  if (!tokens.refresh_token) {
    report(
      `harbor: the notion MCP token has ${Math.round(remaining)}m of life left and no refresh token here, so it stays as it is`
    );
    return;
  }

  const clientInfo = zClientInfo.parse(
    JSON.parse(
      readFileSync(
        tokensPath.replace(/_tokens\.json$/, "_client_info.json"),
        "utf8"
      )
    )
  );
  if (!clientInfo.client_id) {
    throw new Error(
      `notion MCP state in ${path.dirname(tokensPath)} has no client_id; to log in again, ${MCP_LOGIN}`
    );
  }
  const metadata = await call(OAUTH_METADATA_URL);
  if (!metadata.ok) {
    throw new Error(
      `notion OAuth metadata: ${metadata.status} ${await metadata.text()}`
    );
  }
  const { token_endpoint } = zMetadata.parse(await metadata.json());
  if (!token_endpoint) {
    throw new Error(`no token_endpoint in ${OAUTH_METADATA_URL}`);
  }
  const response = await call(token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientInfo.client_id,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `notion MCP token refresh rejected (${response.status}): the grant is dead; to log in again, ${MCP_LOGIN}`
    );
  }
  // Merged: the rotation response may leave out fields mcp-remote reads.
  const rotated = z.looseObject({}).parse(await response.json());
  writeFileSync(tokensPath, JSON.stringify({ ...tokens, ...rotated }));
  report(
    `harbor: refreshed the notion MCP token (${Math.round(remaining)}m of life left)`
  );
}

/** A minimal MCP `initialize` request: the cheapest call that makes Notion
 *  check the bearer token. */
const MCP_PROBE_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "context-cup-suite", version: "0" },
  },
});

/** Throws when Notion rejects the access token in `secrets/mcp`. The file's
 *  age says nothing about the grant: a refresh elsewhere with a spent token
 *  revokes every token of the grant, and a sandbox given such a token blocks
 *  on an interactive login until the harbor timeout instead of failing. */
export async function requireLiveMcpAuth(
  report: Report,
  options: FetchOptions = {}
): Promise<void> {
  const tokensPath = mcpTokensFile(options.dir);
  if (!tokensPath) return;
  const { access_token } = readTokens(tokensPath);
  if (!access_token) return;
  let status: number;
  try {
    const response = await (options.fetch ?? fetch)(MCP_ENDPOINT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: MCP_PROBE_BODY,
      signal: AbortSignal.timeout(30_000),
    });
    status = response.status;
    // Only the status matters; the body may be an open event stream.
    await response.body?.cancel();
  } catch (err) {
    // Only Notion's verdict is decisive; a transport failure says nothing
    // about the grant, so the run proceeds as before the probe existed.
    const reason = err instanceof Error ? err.message.split("\n")[0] : err;
    report(`harbor: the notion MCP probe did not reach the server (${reason})`);
    return;
  }
  if (status === 401) {
    throw new Error(
      `notion MCP rejected the access token (401): the grant is dead; to log in again, ${MCP_LOGIN}`
    );
  }
  report(`harbor: notion MCP accepted the access token (HTTP ${status})`);
}

/** The tokens file's mtime at the last bake; a bake repeats only after a
 *  refresh rotated it. */
let bakedMtime = -1;

/** Snapshot `secrets/mcp` into each notion task's `configs.zip` as
 *  `.mcp-auth/`, creating the zip when there is none. The copy carries no
 *  refresh token: a sandbox that gets a 401 then fails alone instead of
 *  rotating the grant behind this process. */
export function bakeMcpAuthIntoTaskConfigs(
  tasksDir: string,
  report: Report,
  dir: string = MCP_AUTH_DIR
): void {
  const tokensPath = mcpTokensFile(dir);
  if (!tokensPath || !existsSync(tasksDir)) return;
  const mtime = statSync(tokensPath).mtimeMs;
  if (mtime === bakedMtime) return;
  const staging = mkdtempSync(path.join(tmpdir(), "cc-mcp-auth-"));
  try {
    cpSync(dir, path.join(staging, ".mcp-auth"), { recursive: true });
    const accessOnly = readTokens(tokensPath);
    delete accessOnly.refresh_token;
    writeFileSync(
      path.join(staging, ".mcp-auth", path.relative(dir, tokensPath)),
      JSON.stringify(accessOnly)
    );
    let baked = 0;
    for (const task of TOOLATHLON_NOTION_TASKS) {
      const envDir = path.join(tasksDir, task, "environment");
      if (!existsSync(envDir)) continue;
      execFileSync(
        "zip",
        ["-qr", path.join(envDir, "configs.zip"), ".mcp-auth"],
        {
          cwd: staging,
        }
      );
      baked++;
    }
    bakedMtime = mtime;
    report(`harbor: baked notion MCP state into ${baked} task config zip(s)`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

let serial: Promise<void> = Promise.resolve();

/** Refresh, check, then bake, one caller at a time: a refresh spends the
 *  refresh token, so two at once would leave one of them holding a dead
 *  grant. */
export function prepareMcpAuthForDaytona(
  tasksDir: string,
  report: Report
): Promise<void> {
  const run = serial.then(async () => {
    await refreshMcpAuthIfStale(report);
    await requireLiveMcpAuth(report);
    bakeMcpAuthIntoTaskConfigs(tasksDir, report);
  });
  serial = run.catch(() => {});
  return run;
}

/** Only for tests: forget the last bake. */
export function resetBakeState(): void {
  bakedMtime = -1;
}
