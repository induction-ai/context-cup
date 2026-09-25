/** Reads `{ provider: payload }` on stdin and prints `{ provider:
 *  conversation }` from the TypeScript view, for test_protocol_contract.py. */
import { readFileSync } from "node:fs";
import type { Payload, Provider } from "../course/protocol/src/models.ts";
import { view } from "../course/protocol/src/view.ts";

const payloads = JSON.parse(readFileSync(0, "utf8")) as Record<
  Provider,
  Payload
>;
const out = Object.fromEntries(
  Object.entries(payloads).map(([provider, payload]) => [
    provider,
    view(provider as Provider, payload),
  ])
);
process.stdout.write(JSON.stringify(out));
