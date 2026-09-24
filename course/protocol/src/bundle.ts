/** Bundle a TypeScript driver for a trial container: the engine's entry point
 *  and the driver's `driver.ts`, with every npm package either imports, in
 *  one ES module that the runner's `node` runs. Trial containers have `node`
 *  but no package manager, so this runs on the host, where `pnpm install`
 *  has put the workspace's packages, from an engine's `build.sh`:
 *
 *    tsx bundle.ts --main <engine>/src/main.ts --driver "$CC_DRIVER_DIR"
 *
 *  The engine's `main.ts` exports `main(driver)`, which runs one turn and
 *  resolves to the process exit code. The bundle lands at
 *  `<driver>/bundle/turn.mjs`, beside a source map. */
import { realpathSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { build } from "esbuild";

export const BUNDLE_DIR = "bundle";
export const BUNDLE_FILE = "turn.mjs";

export type BundleOptions = {
  /** The engine's entry module, exporting `main(driver)`. */
  main: string;
  /** The driver package directory, holding `driver.ts`. */
  driverDir: string;
  /** Defaults to `<driverDir>/bundle/turn.mjs`. */
  outfile?: string;
};

/** Writes the bundle and returns its path. */
export async function bundleDriver(options: BundleOptions): Promise<string> {
  const driverDir = path.resolve(options.driverDir);
  const outfile =
    options.outfile ?? path.join(driverDir, BUNDLE_DIR, BUNDLE_FILE);
  const entry = [
    `import { main } from ${JSON.stringify(path.resolve(options.main))};`,
    `import * as driver from ${JSON.stringify(path.join(driverDir, "driver.ts"))};`,
    `process.exitCode = await main(driver);`,
  ].join("\n");
  await build({
    stdin: {
      contents: entry,
      resolveDir: driverDir,
      sourcefile: "turn.ts",
      loader: "ts",
    },
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    // Stack traces in a turn's stderr.txt point at driver.ts lines; the map
    // leaves out the sources themselves, which would triple the upload.
    sourcemap: true,
    sourcesContent: false,
    // Some bundled CommonJS packages call require() for Node builtins, which
    // an ES module does not have.
    banner: {
      js: 'import { createRequire as __ccCreateRequire } from "node:module"; const require = __ccCreateRequire(import.meta.url);',
    },
    legalComments: "none",
    logLevel: "warning",
  });
  return outfile;
}

// Engines run this through their node_modules symlink.
if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) {
  const { values } = parseArgs({
    options: {
      main: { type: "string" },
      driver: { type: "string" },
      outfile: { type: "string" },
    },
  });
  if (!values.main || !values.driver) {
    console.error("usage: bundle.ts --main <engine main.ts> --driver <dir>");
    process.exit(2);
  }
  console.log(
    await bundleDriver({
      main: values.main,
      driverDir: values.driver,
      outfile: values.outfile,
    })
  );
}
