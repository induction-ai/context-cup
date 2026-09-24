/** The bundle's entry point (see build.sh): one turn of a driver's `run`. */
import { runEngine, type DriverModule } from "@context-cup/protocol/engine.js";
import { AisdkContext, finish } from "./context.ts";

export function main(driver: DriverModule<AisdkContext>): Promise<number> {
  return runEngine({
    engine: "aisdk",
    makeContext: (turn, config) => new AisdkContext(turn, config),
    driver,
    finish: (ctx, result) => finish(ctx, result),
  });
}
