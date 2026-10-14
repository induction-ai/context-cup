/**
 * bin/refresh_mcp_auth: refresh the notion MCP token in `secrets/mcp` unless
 * it has more than --when_under_min minutes of life left. The Notion Grant
 * Refresh workflow runs it every few hours so the `TOOLATHLON_MCP_AUTH_B64`
 * secret always holds a live grant (see mcp_auth.ts).
 */
import yargs from "yargs";
import { refreshMcpAuthIfStale } from "./mcp_auth.ts";

const argv = yargs(process.argv.slice(2))
  .scriptName("bin/refresh_mcp_auth")
  .option("when_under_min", {
    type: "number",
    demandOption: true,
    describe: "Refresh a token with less than this many minutes of life left",
  })
  .alias("h", "help")
  .strict()
  .parseSync();

refreshMcpAuthIfStale(console.log, {
  when_under_min: argv.when_under_min,
}).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
