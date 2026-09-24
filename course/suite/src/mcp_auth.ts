/**
 * Notion MCP OAuth state for the toolathlon tasks whose preprocess duplicates
 * a Notion page. Notion's hosted MCP is OAuth only: an access token of a few
 * hours and a refresh token that rotates on every use. So refreshes happen one
 * at a time, and the rotated state persists across runs in `secrets/mcp`
 * (gitignored; in CI, a repository secret written back after a rotation).
 *
 * Docker trials bind-mount `secrets/mcp` live. A Daytona sandbox cannot mount
 * a host path, so before each Daytona notion job the host refreshes a token
 * near expiry and bakes a snapshot into the notion tasks' `configs.zip`,
 * which the task image unzips into its configs.
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

export const MCP_LOGIN = `run this, approve in the browser, then Ctrl-C once it prints "Proxy established successfully":\n  MCP_REMOTE_CONFIG_DIR=secrets/mcp npx -y mcp-remote@${MCP_REMOTE_VERSION} https://mcp.notion.com/mcp`;

const OAUTH_METADATA_URL =
  "https://mcp.notion.com/.well-known/oauth-authorization-server";

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
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
});
const zClientInfo = z.looseObject({ client_id: z.string().optional() });
const zMetadata = z.looseObject({ token_endpoint: z.string().optional() });

/** Refresh the token when it is close to expiry. Throws on a dead grant
 *  rather than let notion tasks hang at their healthcheck. */
export async function refreshMcpAuthIfStale(
  report: Report,
  options: { dir?: string; fetch?: typeof fetch; now?: Date } = {}
): Promise<void> {
  const tokensPath = mcpTokensFile(options.dir);
  if (!tokensPath) return;
  const call = options.fetch ?? fetch;
  const tokens = zTokens.parse(JSON.parse(readFileSync(tokensPath, "utf8")));
  const now = (options.now ?? new Date()).getTime();
  const ageMinutes = (now - statSync(tokensPath).mtimeMs) / 60_000;
  const remaining = (tokens.expires_in ?? 0) / 60 - ageMinutes;
  if (remaining > REFRESH_UNDER_MINUTES) return;

  const clientInfo = zClientInfo.parse(
    JSON.parse(
      readFileSync(
        tokensPath.replace(/_tokens\.json$/, "_client_info.json"),
        "utf8"
      )
    )
  );
  if (!tokens.refresh_token || !clientInfo.client_id) {
    throw new Error(
      `notion MCP state in ${path.dirname(tokensPath)} has no refresh_token or client_id; to log in again, ${MCP_LOGIN}`
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

/** The tokens file's mtime at the last bake; a bake repeats only after a
 *  refresh rotated it. */
let bakedMtime = -1;

/** Snapshot `secrets/mcp` into each notion task's `configs.zip` as
 *  `.mcp-auth/`, creating the zip when there is none. */
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

/** Refresh then bake, one caller at a time: a refresh spends the refresh
 *  token, so two at once would leave one of them holding a dead grant. */
export function prepareMcpAuthForDaytona(
  tasksDir: string,
  report: Report
): Promise<void> {
  const run = serial.then(async () => {
    await refreshMcpAuthIfStale(report);
    bakeMcpAuthIntoTaskConfigs(tasksDir, report);
  });
  serial = run.catch(() => {});
  return run;
}

/** Only for tests: forget the last bake. */
export function resetBakeState(): void {
  bakedMtime = -1;
}
