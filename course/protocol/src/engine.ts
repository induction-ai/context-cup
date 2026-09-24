/** The turn mechanics every TypeScript engine shares: an engine supplies the
 *  `ctx` its drivers' `run(ctx)` receives, and `runEngine` does the rest.
 *  The twin of `context_cup_protocol/engine.py`. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  parseTurnInput,
  PROTOCOL_VERSION,
  type Payload,
  type TurnInput,
  type TurnOutput,
} from "./models.ts";

/** What every engine's `ctx` carries back into `output.json`. */
export interface EngineContext {
  contextPayload: Payload;
  state: unknown;
}

/** A driver module: `driver.ts` exporting `run(ctx)`. */
export type DriverModule<C> = {
  run?: (ctx: C) => unknown;
};

export type EngineOptions<C extends EngineContext> = {
  /** The engine's name, as `output.json`'s `driver.engine`. */
  engine: string;
  makeContext: (turn: TurnInput, config: Record<string, unknown>) => C;
  driver: DriverModule<C>;
  /** Turns what `run(ctx)` returned into the turn's response, for engines
   *  whose drivers return something else (an SDK result, say). */
  finish?: (ctx: C, result: unknown) => unknown;
  argv?: string[];
};

type Manifest = {
  name?: string;
  version?: string;
  contextCup?: { config?: Record<string, unknown> };
};

/** What `run` returned, as JSON: a plain object, or an SDK response whose
 *  JSON form is one. */
export function asPayload(value: unknown): Payload {
  const json: unknown =
    value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    const kind = Array.isArray(value) ? "an array" : typeof value;
    throw new TypeError(
      `run(ctx) must return the provider's response, not ${kind}`
    );
  }
  return json as Payload;
}

export async function runTurn<C extends EngineContext>(
  options: EngineOptions<C>,
  driverDir: string,
  turn: TurnInput
): Promise<TurnOutput> {
  const { driver, engine, finish } = options;
  if (typeof driver.run !== "function") {
    throw new TypeError(
      `${path.join(driverDir, "driver.ts")} must export run(ctx)`
    );
  }
  const manifest = JSON.parse(
    await readFile(path.join(driverDir, "package.json"), "utf8")
  ) as Manifest;
  await mkdir(turn.dirs.state, { recursive: true });
  const ctx = options.makeContext(turn, {
    ...(manifest.contextCup?.config ?? {}),
  });
  const result = await driver.run(ctx);
  const response = asPayload(finish ? await finish(ctx, result) : result);
  const name = String(manifest.name || path.basename(driverDir))
    .split("/")
    .at(-1)!;
  return {
    protocol: PROTOCOL_VERSION,
    turn_id: turn.turn_id,
    response,
    context_payload: ctx.contextPayload,
    state: ctx.state ?? null,
    driver: { name, engine, version: manifest.version ?? null },
  };
}

/** `--driver DIR --input in.json --output out.json`: one turn, exit code 0,
 *  or a stack trace on stderr and exit code 1.
 *
 *  An engine's entry point is a call to this. It reads `input.json`, the
 *  driver's `package.json`, creates the state directory, and builds `ctx`
 *  with `makeContext(turn, contextCup.config)`. It calls `run(ctx)`, passes
 *  the result through `finish(ctx, result)` when the engine gives one, and
 *  takes it as the response. `output.json` gets that response plus
 *  `ctx.contextPayload` and `ctx.state` as they stand after the call. Any
 *  error, from the driver or here, fails the turn; the runner retries it. */
export async function runEngine<C extends EngineContext>(
  options: EngineOptions<C>
): Promise<number> {
  const { values } = parseArgs({
    args: options.argv ?? process.argv.slice(2),
    options: {
      driver: { type: "string" },
      input: { type: "string" },
      output: { type: "string" },
    },
  });
  if (!values.driver || !values.input || !values.output) {
    console.error(
      `usage: engine-${options.engine} --driver DIR --input in.json --output out.json`
    );
    return 2;
  }
  let output: TurnOutput;
  try {
    const turn = parseTurnInput(
      JSON.parse(await readFile(values.input, "utf8"))
    );
    output = await runTurn(options, values.driver, turn);
  } catch (err) {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    return 1;
  }
  await mkdir(path.dirname(values.output), { recursive: true });
  await writeFile(values.output, JSON.stringify(output, null, 2));
  return 0;
}
