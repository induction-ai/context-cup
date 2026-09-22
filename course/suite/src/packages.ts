import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  PROVIDERS,
  zProvider,
  type Provider,
} from "@context-cup/shared/provider.js";
import { REPO_ROOT } from "@context-cup/shared/repo_root.js";
import z from "zod";

export const PACKAGE_SCOPE = "@context-cup/";
/** Drivers live in their own scope so contestants' packages read as such. */
export const DRIVER_SCOPE = "@context-cup-drivers/";

/** The workspace globs that may hold drivers and engines. */
const PACKAGE_DIRS = ["course", "engines", "drivers"];

const zContextCup = z.object({
  kind: z.enum(["driver", "engine"]),
  extends: z.string().min(1).optional(),
  /** Providers this package can drive. Absent means "whatever the parent
   *  supports"; a root package without a list supports every provider. */
  providers: z.array(zProvider).min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const zManifest = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  contextCup: zContextCup.optional(),
});

/** A workspace package that takes part in the driver protocol. */
export type CupPackage = {
  name: string;
  dir: string;
  kind: "driver" | "engine";
  extends?: string;
  providers?: Provider[];
  config?: Record<string, unknown>;
  description?: string;
};

/** Every driver and engine package in the workspace, keyed by package name. */
export function scanPackages(
  root: string = REPO_ROOT
): Map<string, CupPackage> {
  const found = new Map<string, CupPackage>();
  for (const group of PACKAGE_DIRS) {
    const groupDir = path.join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir)) {
      const dir = path.join(groupDir, entry);
      const file = path.join(dir, "package.json");
      if (!statSync(dir).isDirectory() || !existsSync(file)) continue;
      const manifest = zManifest.parse(JSON.parse(readFileSync(file, "utf8")));
      if (!manifest.contextCup) continue;
      if (found.has(manifest.name)) {
        throw new Error(
          `Package ${manifest.name} is declared twice: ${found.get(manifest.name)!.dir} and ${dir}`
        );
      }
      found.set(manifest.name, {
        name: manifest.name,
        dir,
        kind: manifest.contextCup.kind,
        extends: manifest.contextCup.extends,
        providers: manifest.contextCup.providers,
        config: manifest.contextCup.config,
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

/** The suite-file name of a driver: its package name minus the scope. */
export function driverShortName(packageName: string): string {
  return packageName.startsWith(DRIVER_SCOPE)
    ? packageName.slice(DRIVER_SCOPE.length)
    : packageName;
}

export function driverPackageName(shortName: string): string {
  return shortName.startsWith("@") ? shortName : `${DRIVER_SCOPE}${shortName}`;
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
  shortName: string,
  packages: ReadonlyMap<string, CupPackage> = workspacePackages()
): Provider[] {
  const driver = findDriver(shortName, packages);
  return chainProviders(resolveChain(driver.name, packages));
}

/** The driver a suite file names, or an error listing the drivers that exist. */
export function findDriver(
  shortName: string,
  packages: ReadonlyMap<string, CupPackage> = workspacePackages()
): CupPackage {
  const pkg = packages.get(driverPackageName(shortName));
  if (!pkg || pkg.kind !== "driver") {
    const drivers = [...packages.values()]
      .filter((p) => p.kind === "driver")
      .map((p) => driverShortName(p.name));
    throw new Error(
      `Unknown driver "${shortName}". Drivers in the workspace: ${drivers.join(", ") || "(none)"}`
    );
  }
  return pkg;
}

/** The package directories of a driver's chain, root to leaf, as the
 *  `CC_HOST_DRIVER_CHAIN` value. */
export function driverChainDirs(
  shortName: string,
  packages: ReadonlyMap<string, CupPackage> = workspacePackages()
): string[] {
  const driver = findDriver(shortName, packages);
  return resolveChain(driver.name, packages).map((p) => p.dir);
}
