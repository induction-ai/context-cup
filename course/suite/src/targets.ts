import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { zProvider, type Provider } from "@context-cup/shared/provider.js";
import { REPO_ROOT } from "@context-cup/shared/repo_root.js";
import z from "zod";

/** One entry of targets.json: the model a run drives. */
export const zTarget = z.object({
  provider: zProvider,
  model: z.string().min(1),
  reasoning_effort: z.string().min(1).optional(),
  /** Max concurrent trials against this target across a run, for provider
   *  rate limits. Caps the suite's own concurrency when lower. */
  concurrency: z.number().int().positive().optional(),
});
export type Target = z.infer<typeof zTarget>;

export const zTargetsFile = z.record(z.string().min(1), zTarget);
export type TargetsFile = z.infer<typeof zTargetsFile>;

/** `targets.json` at the repo root, or wherever TARGETS_FILE points. */
export function targetsFilePath(): string {
  return process.env.TARGETS_FILE
    ? path.resolve(process.env.TARGETS_FILE)
    : path.join(REPO_ROOT, "targets.json");
}

export function parseTargetsFile(raw: unknown): TargetsFile {
  const targets = zTargetsFile.parse(raw);
  if (Object.keys(targets).length === 0) {
    throw new Error("targets.json names no targets");
  }
  return targets;
}

export function loadTargets(file: string = targetsFilePath()): TargetsFile {
  if (!existsSync(file)) {
    throw new Error(`No targets file at ${file}; see DEVELOPING.md`);
  }
  return parseTargetsFile(JSON.parse(readFileSync(file, "utf8")));
}

/** The target a name refers to, or an error listing the names. */
export function lookupTarget(name: string, targets: TargetsFile): Target {
  const target = targets[name];
  if (!target) {
    throw new Error(
      `Unknown target "${name}". Targets in ${path.relative(REPO_ROOT, targetsFilePath())}: ${Object.keys(targets).join(", ")}`
    );
  }
  return target;
}

/** The targets a driver can run, given the providers it supports. */
export function targetsForProviders(
  targets: TargetsFile,
  providers: readonly Provider[]
): Array<[string, Target]> {
  return Object.entries(targets).filter(([, t]) =>
    providers.includes(t.provider)
  );
}

/** `openai/gpt-5.5@medium`: how a target reads in logs and tables. */
export function describeTarget(target: Target): string {
  const effort = target.reasoning_effort ? `@${target.reasoning_effort}` : "";
  return `${target.provider}/${target.model}${effort}`;
}
