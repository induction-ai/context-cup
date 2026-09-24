/** The host-side half of a driver chain: every `build.sh` in the chain, root
 *  first, once per suite run and before any trial. A trial container has no
 *  package manager, so what needs the workspace's npm packages (bundling a
 *  TypeScript driver) happens here, and the runner uploads the result with
 *  the package. */
import { existsSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import {
  findDriver,
  resolveChain,
  workspacePackages,
  type CupPackage,
} from "./packages.ts";

/** Runs the chain's build scripts and returns the packages that had one.
 *  Throws with the script's output when one fails. */
export async function buildChain(
  chain: readonly CupPackage[]
): Promise<string[]> {
  const dirs = chain.map((p) => p.dir);
  const built: string[] = [];
  for (const pkg of chain) {
    const script = path.join(pkg.dir, "build.sh");
    if (!existsSync(script)) continue;
    const result = await execa("bash", [script], {
      cwd: pkg.dir,
      env: {
        CC_DRIVER_DIR: dirs.at(-1)!,
        CC_SELF_DIR: pkg.dir,
        CC_CHAIN: dirs.join(":"),
      },
      all: true,
      reject: false,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `${pkg.name}: build.sh failed (exit ${result.exitCode})\n${result.all ?? ""}`
      );
    }
    built.push(pkg.name);
  }
  return built;
}

/** {@link buildChain} for a driver named as `--driver` names it. A whole agent
 *  has no chain and builds nothing. */
export async function buildDriver(
  shortName: string,
  packages: ReadonlyMap<string, CupPackage> = workspacePackages()
): Promise<string[]> {
  const driver = findDriver(shortName, packages);
  if (driver.kind === "agent") return [];
  return buildChain(resolveChain(driver.name, packages));
}
