/** The bundle's entry point (see build.sh): one turn of a driver's `run`. */
import { runEngine, type DriverModule } from "@context-cup/protocol/engine.js";
import { TypeScriptContext } from "./context.ts";

export function main(driver: DriverModule<TypeScriptContext>): Promise<number> {
  return runEngine({
    engine: "typescript",
    makeContext: (turn, config) => new TypeScriptContext(turn, config),
    driver,
  });
}
