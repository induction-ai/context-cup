import { execSync } from "node:child_process";
import { REPO_ROOT } from "@context-cup/shared/repo_root.js";

/** The workspace's commit: git's HEAD, or on Render, whose builds may have
 *  no history, the commit Render deployed. Null when neither says. */
export function gitSha(): string | null {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return process.env.RENDER_GIT_COMMIT || null;
  }
}
