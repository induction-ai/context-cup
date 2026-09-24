/** The proxy as a process: what runs inside every trial container, bundled to
 *  one file by `bundle.ts` so the container needs nothing but `node`.
 *
 *  node proxy.cjs --port 18080 --calls /logs/agent/calls.jsonl \
 *    [--save-bodies DIR] [--default-provider openai --default-model gpt-5.5]
 *
 *  Provider keys come from the process env. Prints `listening <url>` once up;
 *  exits on SIGTERM. No top-level await and no workspace lookups, so it runs
 *  as CommonJS outside the repo. */
import { parseArgs } from "node:util";
import { zProvider } from "@context-cup/shared/provider.js";
import { startProxy, type DefaultModel } from "./server.ts";

function defaultModel(
  provider: string | undefined,
  model: string | undefined
): DefaultModel | undefined {
  if (!provider && !model) return undefined;
  if (!provider || !model) {
    throw new Error("--default-provider and --default-model go together");
  }
  return { provider: zProvider.parse(provider), model };
}

function main(): void {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: "0" },
      calls: { type: "string", default: "calls.jsonl" },
      "save-bodies": { type: "string" },
      "default-provider": { type: "string" },
      "default-model": { type: "string" },
    },
    strict: true,
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0) {
    throw new Error(`--port must be a port number, not ${values.port}`);
  }
  startProxy({
    port,
    callsFile: values.calls,
    bodiesDir: values["save-bodies"],
    defaultModel: defaultModel(
      values["default-provider"],
      values["default-model"]
    ),
  }).then(
    (proxy) => {
      console.log(`listening ${proxy.url}`);
      const stop = () => {
        proxy.close().then(
          () => process.exit(0),
          () => process.exit(1)
        );
      };
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    },
    (err: unknown) => {
      console.error(err);
      process.exit(1);
    }
  );
}

main();
