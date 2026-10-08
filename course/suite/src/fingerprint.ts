/** A driver's fingerprint: one hash over the files of its package and every
 *  package it extends, which is the code a trial runs as the driver. Two
 *  runs with the same fingerprint ran the same driver; a run whose
 *  fingerprint differs from the driver's current one is stale.
 *
 *  Only the chain counts. The course (runner, proxy, protocol) changes every
 *  driver at once and would make every run stale; a change there that should
 *  rerun the field is a decision, not something a hash finds.
 *
 *  Files are read from disk, not from git, so it works where there is no
 *  history (a Render build) and counts a local edit that a run would upload.
 *  What .gitignore ignores (bundles, node_modules, caches) doesn't count, so
 *  a build or a test run leaves it unchanged. */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@context-cup/shared/repo_root.js";
import ignore, { type Ignore } from "ignore";
import {
  driverChainDirs,
  workspacePackages,
  type CupPackage,
} from "./packages.ts";

/** Bumped when what goes into the hash changes, so old and new never match
 *  by accident. */
const VERSION = "v1";

function rootIgnore(root: string): Ignore {
  const ig = ignore();
  const file = path.join(root, ".gitignore");
  if (existsSync(file)) ig.add(readFileSync(file, "utf8"));
  return ig;
}

/** Every file under `dir` that git would see, as paths relative to `root`
 *  with forward slashes. */
function listFiles(dir: string, root: string, ig: Ignore): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const full = path.join(abs, entry.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (entry.name === ".git" || ig.ignores(`${rel}/`)) continue;
        walk(full);
      } else if (entry.isFile() && !ig.ignores(rel)) {
        out.push(rel);
      }
    }
  };
  walk(dir);
  return out;
}

/** The fingerprint of these package directories. */
export function fingerprintDirs(
  dirs: string[],
  root: string = REPO_ROOT
): string {
  const ig = rootIgnore(root);
  const files = [
    ...new Set(dirs.flatMap((d) => listFiles(d, root, ig))),
  ].sort();
  const hash = createHash("sha256").update(VERSION);
  for (const rel of files) {
    const content = createHash("sha256")
      .update(readFileSync(path.join(root, rel)))
      .digest("hex");
    hash.update(`\0${rel}\0${content}`);
  }
  return `${VERSION}:${hash.digest("hex")}`;
}

/** The fingerprint of a driver, as `--driver` names it. */
export function driverFingerprint(
  name: string,
  packages: ReadonlyMap<string, CupPackage> = workspacePackages(),
  root: string = REPO_ROOT
): string {
  return fingerprintDirs(driverChainDirs(name, packages), root);
}
