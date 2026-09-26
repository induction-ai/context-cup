import { existsSync } from "node:fs";
import path from "node:path";

/** Nearest ancestor of `from` that holds `marker`. */
export function find_up(marker: string, from: string): string {
  let dir = from;
  while (!existsSync(path.join(dir, marker))) {
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`${marker} not found above ${from}`);
    }
    dir = parent;
  }
  return dir;
}

/** The pnpm workspace root. Shared files such as `.env` live there, whatever
 * the cwd. A bundler (the site's Next build) leaves `import.meta.dirname`
 * undefined; there the search starts from the cwd, inside the workspace. */
export const REPO_ROOT = find_up(
  "pnpm-workspace.yaml",
  import.meta.dirname ?? process.cwd()
);
