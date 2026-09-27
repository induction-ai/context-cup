import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { readManifest } from "@context-cup/protocol/manifest.js";
import {
  PROVIDERS,
  zProvider,
  type Provider,
} from "@context-cup/shared/provider.js";
import { REPO_ROOT } from "@context-cup/shared/repo_root.js";
import z from "zod";

/** The workspace globs that may hold drivers and engines. */
const PACKAGE_DIRS = ["course", "engines", "drivers"];

const zContextCup = z
  .object({
    /** `driver` and `engine` speak the turn protocol; an `agent` is a whole
     *  agent harbor runs by itself (Codex, Claude Code), reached through the
     *  proxy but owning its own loop and context. */
    kind: z.enum(["driver", "engine", "agent"]),
    extends: z.string().min(1).optional(),
    /** For `agent`: harbor's own agent class as `module:Class` (Codex).
     *  Without one, the package is a script agent: its `agent.sh` works the
     *  task, run by the course's script agent for the benchmark. */
    harbor_agent: z
      .string()
      .regex(/^[\w.]+:\w+$/, "harbor_agent must be module.path:ClassName")
      .optional(),
    /** Providers this package can drive. Absent means "whatever the parent
     *  supports"; a root package without a list supports every provider. */
    providers: z.array(zProvider).min(1).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((cc, ctx) => {
    if (cc.kind === "agent" && cc.extends) {
      ctx.addIssue({
        code: "custom",
        message: "an agent package does not extend an engine",
      });
    }
    if (cc.kind !== "agent" && cc.harbor_agent) {
      ctx.addIssue({
        code: "custom",
        message: "harbor_agent only applies to kind: agent",
      });
    }
  });

/** Whether a package is a whole agent that harbor runs through a class of
 *  its own (Codex), with no chain of packages for the course to upload. */
export function isHarborAgent(pkg: CupPackage): boolean {
  return pkg.kind === "agent" && pkg.harbor_agent !== undefined;
}

/** A workspace package that takes part in the driver protocol. */
export type CupPackage = {
  /** Its folder's name: what `--driver` and `extends` name it by. */
  name: string;
  dir: string;
  kind: "driver" | "engine" | "agent";
  extends?: string;
  harbor_agent?: string;
  providers?: Provider[];
  config?: Record<string, unknown>;
  description?: string;
};

/** Every driver and engine package in the workspace, keyed by folder name. */
export function scanPackages(
  root: string = REPO_ROOT
): Map<string, CupPackage> {
  const found = new Map<string, CupPackage>();
  for (const group of PACKAGE_DIRS) {
    const groupDir = path.join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir)) {
      const dir = path.join(groupDir, entry);
      if (!statSync(dir).isDirectory()) continue;
      const manifest = readManifest(dir);
      if (!manifest) continue;
      const parsed = zContextCup.safeParse(manifest.settings);
      if (!parsed.success) {
        throw new Error(
          `Package ${entry} (${dir}) has an invalid manifest: ${parsed.error.message}`
        );
      }
      const cc = parsed.data;
      if (found.has(entry)) {
        throw new Error(
          `Two packages are named ${entry}: ${found.get(entry)!.dir} and ${dir}; a package is its folder, so folder names must differ`
        );
      }
      found.set(entry, {
        name: entry,
        dir,
        kind: cc.kind,
        extends: cc.extends,
        harbor_agent: cc.harbor_agent,
        providers: cc.providers,
        config: cc.config,
        description: manifest.description,
      });
    }
  }
  return found;
}

let cache: Map<string, CupPackage> | undefined;
/** {@link scanPackages} once per process. */
export function workspacePackages(): Map<string, CupPackage> {
  return (cache ??= scanPackages());
}

/** Follow `extends` from a package to its root. Returned root first, leaf
 *  last. Throws on an unknown package or a cycle. */
export function resolveChain(
  leaf: string,
  packages: ReadonlyMap<string, CupPackage>
): CupPackage[] {
  const chain: CupPackage[] = [];
  const seen = new Set<string>();
  let name: string | undefined = leaf;
  while (name !== undefined) {
    if (seen.has(name)) {
      throw new Error(
        `Package ${leaf} has a cyclic extends chain: ${[...seen, name].join(" -> ")}`
      );
    }
    seen.add(name);
    const pkg: CupPackage | undefined = packages.get(name);
    if (!pkg) {
      const from = chain.at(-1);
      throw new Error(
        from
          ? `Package ${from.name} extends ${name}, which is not a driver or engine package in the workspace`
          : `Unknown package ${name}. Known: ${[...packages.keys()].join(", ") || "(none)"}`
      );
    }
    chain.unshift(pkg);
    name = pkg.extends;
  }
  return chain;
}

/** The providers a chain can drive: the leaf-most package that declares a
 *  list wins; a chain that declares none supports every provider. */
export function chainProviders(chain: readonly CupPackage[]): Provider[] {
  for (let i = chain.length - 1; i >= 0; i--) {
    const providers = chain[i]!.providers;
    if (providers) return providers;
  }
  return [...PROVIDERS];
}

/** The providers a driver supports, resolved through its chain. */
export function driverProviders(
  name: string,
  packages: ReadonlyMap<string, CupPackage> = workspacePackages()
): Provider[] {
  const driver = findDriver(name, packages);
  return chainProviders(resolveChain(driver.name, packages));
}

/** Packages `--driver` may name: turn-protocol drivers and whole agents. */
export function isRunnable(pkg: CupPackage): boolean {
  return pkg.kind === "driver" || pkg.kind === "agent";
}

/** The driver a suite file names, or an error listing the drivers that exist. */
export function findDriver(
  name: string,
  packages: ReadonlyMap<string, CupPackage> = workspacePackages()
): CupPackage {
  const pkg = packages.get(name);
  if (!pkg || !isRunnable(pkg)) {
    const drivers = [...packages.values()]
      .filter(isRunnable)
      .map((p) => p.name);
    throw new Error(
      `Unknown driver "${name}". Drivers in the workspace: ${drivers.join(", ") || "(none)"}`
    );
  }
  return pkg;
}

/** The package directories of a driver's chain, root to leaf, as the
 *  `CC_HOST_DRIVER_CHAIN` value. */
export function driverChainDirs(
  name: string,
  packages: ReadonlyMap<string, CupPackage> = workspacePackages()
): string[] {
  const driver = findDriver(name, packages);
  return resolveChain(driver.name, packages).map((p) => p.dir);
}
