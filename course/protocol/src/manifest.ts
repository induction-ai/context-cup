/** A package's manifest, in its language's format: the `contextCup` block of
 *  its `package.json`, else the `[tool.context-cup]` table of its
 *  `pyproject.toml`. Names in either file are ignored: a package is its
 *  folder. The Python twin is `context_cup_protocol/manifest.py`, read by the
 *  runner and the Python engines; tests/test_protocol_contract.py checks the
 *  two agree. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

export type Manifest = {
  /** The `contextCup` block: kind, extends, providers, config, ... */
  settings: Record<string, unknown>;
  version?: string;
  description?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

/** A manifest file's contents; one that does not parse fails naming
 *  itself. */
function parseFile(file: string, parse: (text: string) => unknown): unknown {
  try {
    return parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: ${(error as Error).message}`, { cause: error });
  }
}

/** The package's manifest, or undefined for a directory with neither. */
export function readManifest(dir: string): Manifest | undefined {
  const json = path.join(dir, "package.json");
  if (existsSync(json)) {
    const spec = parseFile(json, JSON.parse);
    if (!isRecord(spec)) throw new TypeError(`${json} must hold a JSON object`);
    if (isRecord(spec.contextCup)) {
      return {
        settings: spec.contextCup,
        version: text(spec.version),
        description: text(spec.description),
      };
    }
  }
  const toml = path.join(dir, "pyproject.toml");
  if (existsSync(toml)) {
    const spec = parseFile(toml, parseToml);
    const tool = isRecord(spec) && isRecord(spec.tool) ? spec.tool : {};
    const project =
      isRecord(spec) && isRecord(spec.project) ? spec.project : {};
    if (isRecord(tool["context-cup"])) {
      return {
        settings: tool["context-cup"],
        version: text(project.version),
        description: text(project.description),
      };
    }
  }
  return undefined;
}

/** The manifest's `config`, the tunables a driver's `ctx.config` holds. */
export function manifestConfig(
  manifest: Manifest | undefined
): Record<string, unknown> {
  const config = manifest?.settings.config;
  return isRecord(config) ? { ...config } : {};
}
