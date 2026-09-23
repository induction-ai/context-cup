/** Choosing the one driver and one target a suite run uses. Both come from
 *  the command line; when either is missing and a prompt is available, the
 *  user picks from a numbered list. Kept free of terminal code so it can be
 *  tested with an injected asker. */

import {
  driverProviders,
  driverShortName,
  findDriver,
  isRunnable,
  type CupPackage,
} from "./packages.ts";
import {
  describeTarget,
  lookupTarget,
  targetsForProviders,
  type Target,
  type TargetsFile,
} from "./targets.ts";

export type Choice = { name: string; detail: string };

/** Shows numbered choices and returns the index picked. */
export type Asker = (question: string, choices: Choice[]) => Promise<number>;

export type Launch = {
  driver_name: string;
  target_name: string;
  target: Target;
};

export function driverChoices(
  packages: ReadonlyMap<string, CupPackage>
): Choice[] {
  return [...packages.values()]
    .filter(isRunnable)
    .map((p) => ({
      name: driverShortName(p.name),
      detail: p.description ?? "",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function targetChoices(entries: Array<[string, Target]>): Choice[] {
  return entries.map(([name, t]) => ({ name, detail: describeTarget(t) }));
}

function listing(choices: Choice[]): string {
  return choices.map((c) => c.name).join(", ") || "(none)";
}

export async function resolveLaunch(inputs: {
  driver?: string;
  target?: string;
  targets: TargetsFile;
  packages: ReadonlyMap<string, CupPackage>;
  /** null when no prompt is possible (not a TTY). */
  ask: Asker | null;
}): Promise<Launch> {
  const { targets, packages, ask } = inputs;

  let driver_name = inputs.driver;
  if (driver_name === undefined) {
    const choices = driverChoices(packages);
    if (choices.length === 0) {
      throw new Error("No driver packages under drivers/.");
    }
    if (!ask) {
      throw new Error(
        `--driver is required. Drivers in the workspace: ${listing(choices)}`
      );
    }
    driver_name = choices[await ask("Driver", choices)]!.name;
  }
  findDriver(driver_name, packages);
  const providers = driverProviders(driver_name, packages);
  const usable = targetsForProviders(targets, providers);

  let target_name = inputs.target;
  if (target_name === undefined) {
    if (usable.length === 0) {
      throw new Error(
        `Driver ${driver_name} supports ${providers.join(", ")}, and targets.json has no target for those providers.`
      );
    }
    const choices = targetChoices(usable);
    if (!ask) {
      throw new Error(
        `--target is required. Targets ${driver_name} can run: ${listing(choices)}`
      );
    }
    target_name = choices[await ask("Target model", choices)]!.name;
  }
  const target = lookupTarget(target_name, targets);
  if (!providers.includes(target.provider)) {
    throw new Error(
      `Driver ${driver_name} does not support provider ${target.provider} (it supports ${providers.join(", ")}). Targets it can run: ${listing(targetChoices(usable))}`
    );
  }
  return { driver_name, target_name, target };
}
