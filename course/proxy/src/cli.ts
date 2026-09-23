/** `tsx course/proxy/src/cli.ts --port 0 --calls calls.jsonl [--save-bodies DIR]`
 *  Prints `listening http://127.0.0.1:<port>` once up; exits on SIGTERM. */
import "@context-cup/shared/load_env.js";
import yargs from "yargs";
import { startProxy } from "./server.ts";

const argv = yargs(process.argv.slice(2))
  .scriptName("proxy")
  .usage("Usage: $0 [--port N] [--calls FILE] [--save-bodies DIR]")
  .option("port", {
    type: "number",
    default: 0,
    describe: "0 picks a free port",
  })
  .option("calls", {
    type: "string",
    default: "calls.jsonl",
    describe: "JSON lines of recorded calls",
  })
  .option("save_bodies", {
    type: "string",
    describe: "Directory to keep every request and response body",
  })
  .alias("save-bodies", "save_bodies")
  .strict()
  .parseSync();

const proxy = await startProxy({
  port: argv.port,
  callsFile: argv.calls,
  bodiesDir: argv.save_bodies,
});
console.log(`listening ${proxy.url}`);

const stop = () => {
  proxy.close().then(
    () => process.exit(0),
    () => process.exit(1)
  );
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
