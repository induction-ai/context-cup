/** Bundle the proxy (`cli.ts` and everything it imports) into one CommonJS
 *  file that a bare `node` runs, for upload into trial containers. bin/suite
 *  builds it before every run; `pnpm --filter @context-cup/proxy build` does
 *  it by hand. */
import path from "node:path";
import { build } from "esbuild";

export const PROXY_BUNDLE = path.join(
  import.meta.dirname,
  "..",
  "dist",
  "proxy.cjs"
);

/** Writes {@link PROXY_BUNDLE} and returns its path. */
export async function buildProxyBundle(
  outfile: string = PROXY_BUNDLE
): Promise<string> {
  await build({
    entryPoints: [path.join(import.meta.dirname, "cli.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    minify: false,
    legalComments: "none",
    logLevel: "warning",
  });
  return outfile;
}

if (process.argv[1] === import.meta.filename) {
  console.log(await buildProxyBundle());
}
