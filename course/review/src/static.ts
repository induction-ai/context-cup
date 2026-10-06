/** The static review of a driver PR (the first step of bin/review_driver):
 *  everything about an entry that can be
 *  checked without running it. It reads the PR's files and never executes
 *  them, so it is safe to run before anyone has looked at the code; the smoke
 *  check, which does run the entry, waits for it to pass.
 *
 *  Two halves. The scope check holds a PR to one directory: an entry is
 *  `drivers/<name>/` and nothing else (`pnpm-lock.yaml` aside, which a
 *  TypeScript driver's dependencies change). The driver check reads that
 *  directory: a manifest the course accepts, the files its lane needs, nothing
 *  that runs on the host where the competition's keys are, no imports from the
 *  course beyond the protocol and the engines, and warnings for a human
 *  reviewer where an entry names a benchmark or reaches outside. */
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";
import type { Provider } from "@context-cup/shared/provider.js";
import { REFERENCE_TARGET } from "@context-cup/shared/reference_target.js";
import {
  driverProviders,
  resolveChain,
  scanPackages,
  type CupPackage,
} from "@context-cup/suite/packages.js";
import { loadTargets, lookupTarget } from "@context-cup/suite/targets.js";
import { TOOLATHLON_TASKS } from "@context-cup/suite/tasks.js";
import { parse as parseToml } from "smol-toml";

export type Finding = {
  level: "error" | "warning";
  check: string;
  message: string;
  file?: string;
  line?: number;
};

export type Review = {
  /** The driver the PR enters, when it names exactly one. */
  driver?: string;
  findings: Finding[];
  passed: string[];
};

/** Collects a review's findings and passed checks. */
class Recorder {
  findings: Finding[] = [];
  passed: string[] = [];

  error(check: string, message: string, at: Partial<Finding> = {}): void {
    this.findings.push({ level: "error", check, message, ...at });
  }

  warning(check: string, message: string, at: Partial<Finding> = {}): void {
    this.findings.push({ level: "warning", check, message, ...at });
  }

  ok(check: string): void {
    this.passed.push(check);
  }

  /** Records `ok` when `body` added no finding. */
  check(name: string, body: () => void): void {
    const before = this.findings.length;
    body();
    if (this.findings.length === before) this.ok(name);
  }
}

export function errors(review: Review): Finding[] {
  return review.findings.filter((f) => f.level === "error");
}

export function warnings(review: Review): Finding[] {
  return review.findings.filter((f) => f.level === "warning");
}

/** The one path outside the driver a PR may change: pnpm records a
 *  TypeScript driver's dependencies in the workspace lockfile. */
const LOCKFILE = "pnpm-lock.yaml";
const DRIVER_NAME = /^[a-z][a-z0-9_]*$/;
/** How many outside paths a finding names before it summarises. */
const MAX_LISTED = 10;

/** The driver directories a PR's changed paths fall in, and every changed
 *  path outside them. */
function splitChanges(changed: readonly string[]): {
  drivers: string[];
  outside: string[];
} {
  const drivers = new Set<string>();
  const outside: string[] = [];
  for (const file of changed) {
    const match = /^drivers\/([^/]+)\/./.exec(file);
    if (match) drivers.add(match[1]!);
    else if (file !== LOCKFILE) outside.push(file);
  }
  return { drivers: [...drivers].sort(), outside };
}

/** The scope check: one driver directory, and nothing outside it. Returns the
 *  driver's name when the PR names exactly one. */
function reviewScope(
  changed: readonly string[],
  r: Recorder
): string | undefined {
  const { drivers, outside } = splitChanges(changed);
  r.check("Changes only `drivers/<name>/`", () => {
    if (outside.length === 0) return;
    const listed = outside.slice(0, MAX_LISTED).map((f) => `\`${f}\``);
    if (outside.length > MAX_LISTED) {
      listed.push(`and ${outside.length - MAX_LISTED} more`);
    }
    r.error(
      "Outside the driver",
      `This PR changes ${count(outside.length, "file")} outside \`drivers/<name>/\`: ${listed.join(", ")}. A driver PR changes only its own directory; course, engine, workflow, and docs changes go in a PR of their own, and a maintainer adds the driver to the suite workflow after merging.`
    );
  });
  if (drivers.length === 0) {
    r.error(
      "No driver",
      "This PR changes no `drivers/<name>/` directory, so there is no entry to review."
    );
    return undefined;
  }
  if (drivers.length > 1) {
    r.error(
      "More than one driver",
      `This PR changes ${drivers.map((d) => `\`drivers/${d}/\``).join(", ")}. Enter one driver per PR.`
    );
    return undefined;
  }
  const driver = drivers[0]!;
  r.check("Driver name", () => {
    if (driver.startsWith("base_")) {
      r.error(
        "Reserved name",
        "The `base_` prefix is reserved for the course’s own drivers, and they change through course PRs. Copy one to a directory of your own instead.",
        { file: `drivers/${driver}/` }
      );
    } else if (!DRIVER_NAME.test(driver)) {
      r.error(
        "Driver name",
        `\`${driver}\` is not a valid driver name: use lowercase letters, digits, and underscores, starting with a letter.`,
        { file: `drivers/${driver}/` }
      );
    }
  });
  return driver;
}

/** Package lifecycle scripts pnpm runs on install, which would run an
 *  entry's code on the host. */
const INSTALL_SCRIPTS = [
  "preinstall",
  "install",
  "postinstall",
  "preprepare",
  "prepare",
  "postprepare",
];

/** Whether an npm dependency spec resolves from the registry: a version, a
 *  range, or a tag, or an `npm:` alias to one. Anything else (git in any
 *  form, a path, a URL, a GitHub shorthand) fetches from somewhere that can
 *  carry code that runs at install. */
function isRegistrySpec(spec: string): boolean {
  const alias = /^npm:(@?[^@\s]+)(?:@(.*))?$/.exec(spec);
  if (alias) return alias[2] === undefined || isRegistrySpec(alias[2]);
  return !/[:/]/.test(spec);
}

const SECRETS: Array<[string, RegExp]> = [
  ["an Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["an OpenAI API key", /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/],
  ["a Google API key", /\bAIza[0-9A-Za-z_-]{35}/],
  ["a GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_\w{22,})/],
  ["an AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  [
    "a connection string with a password",
    /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:@/]+:[^\s@/]+@/,
  ],
];

/** A provider's own API host: a driver calls the base URL it is given. */
const PROVIDER_HOST =
  /\b(?:api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com)\b/;
const OUTSIDE_URL =
  /\bhttps?:\/\/(?!(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?:[:/]|$))[^\s"'`)>\]]+/;

/** The benchmarks by name, and every task the course runs by its id. */
const BENCHMARK_NAME =
  /\b(?:toolathlon|tau(?:2|3|[_-]?bench|[_-]banking))\b|\bbanking_\d{3}\b/i;
const TASK_NAME = new RegExp(
  `(?<![\\w-])(?:${Object.keys(TOOLATHLON_TASKS)
    .map((name) => name.replace(/_/g, "[_-]"))
    .join("|")})(?![\\w-])`,
  "i"
);

/** Files a driver never commits: dependencies, build output, local env. */
function generatedReason(rel: string): string | undefined {
  const parts = rel.split("/");
  if (parts.includes("node_modules")) return "installed npm packages";
  if (parts.includes(".venv")) return "a Python virtualenv";
  if (parts.includes("__pycache__") || rel.endsWith(".pyc"))
    return "Python bytecode";
  if (parts[0] === "bundle") return "the engine’s build output";
  const base = parts.at(-1)!;
  if (/^\.env(?:\..+)?$/.test(base) && base !== ".env.example")
    return "an env file";
  return undefined;
}

const MAX_FILE_BYTES = 1_000_000;
const MAX_HITS_PER_FILE = 5;
/** Files the content scans skip: generated, or prose for the reviewer. */
const LOCKFILES = new Set(["uv.lock", "package-lock.json", LOCKFILE]);

function isTestFile(rel: string): boolean {
  const base = path.basename(rel);
  return (
    rel.split("/").includes("tests") ||
    /^test_.*\.py$|_test\.py$|\.test\.[cm]?[jt]s$/.test(base)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A PEP 503 normalised Python package name. */
function normalise(name: string): string {
  return name.replace(/[-_.]+/g, "-").toLowerCase();
}

/** What a driver may import from the workspace: the protocol library and
 *  the engines, by their Python module and npm names. */
function allowedImports(root: string): {
  python: Set<string>;
  npm: Set<string>;
} {
  const python = new Set(["context_cup_protocol"]);
  const npm = new Set(["@context-cup/protocol"]);
  const engines = path.join(root, "engines");
  if (!existsSync(engines)) return { python, npm };
  for (const engine of readdirSync(engines)) {
    const src = path.join(engines, engine, "src");
    if (existsSync(src) && statSync(src).isDirectory()) {
      for (const module of readdirSync(src)) {
        if (existsSync(path.join(src, module, "__init__.py")))
          python.add(module);
      }
    }
    const pkg = path.join(engines, engine, "package.json");
    if (existsSync(pkg)) {
      const name = (JSON.parse(readFileSync(pkg, "utf8")) as { name?: unknown })
        .name;
      if (typeof name === "string") npm.add(name);
    }
  }
  return { python, npm };
}

type DriverFile = {
  /** Relative to the driver's directory. */
  rel: string;
  /** Relative to the repo root, for findings. */
  file: string;
  bytes: Buffer;
  text?: string;
};

/** The driver's tracked files, read; and the tracked paths that are not
 *  plain files (symlinks, submodules), which the review reads nothing
 *  through. */
function readDriverFiles(
  root: string,
  driver: string,
  tracked: readonly string[]
): { files: DriverFile[]; others: string[] } {
  const prefix = `drivers/${driver}/`;
  const files: DriverFile[] = [];
  const others: string[] = [];
  for (const file of tracked) {
    if (!file.startsWith(prefix)) continue;
    const full = path.join(root, file);
    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      continue; // deleted in the working tree
    }
    if (!stat.isFile()) {
      others.push(file);
      continue;
    }
    const bytes = readFileSync(full);
    const binary = bytes.subarray(0, 8000).includes(0);
    files.push({
      rel: file.slice(prefix.length),
      file,
      bytes,
      text: binary ? undefined : bytes.toString("utf8"),
    });
  }
  return { files, others };
}

/** A line that is only a comment, in the languages drivers are written in. */
const COMMENT_LINE = /^\s*(?:#|\/\/|\/\*|\*)/;

/** Each line of `text` that matches `pattern`, with its 1-based number.
 *  `code_only` skips lines that are only a comment. */
function matchingLines(
  text: string,
  pattern: RegExp,
  code_only = false
): Array<{ line: number; match: string }> {
  const hits: Array<{ line: number; match: string }> = [];
  text.split("\n").forEach((content, i) => {
    if (code_only && COMMENT_LINE.test(content)) return;
    const match = pattern.exec(content);
    if (match) hits.push({ line: i + 1, match: match[0] });
  });
  return hits;
}

/** The driver check: the directory a PR enters, as the course would load
 *  it. `tracked` is every file git tracks in the checkout, relative to
 *  `root`. */
function reviewDriver(
  root: string,
  driver: string,
  tracked: readonly string[],
  r: Recorder,
  changed: readonly string[],
  existing: boolean
): void {
  const dir = path.join(root, "drivers", driver);
  const at = (rel: string) => ({ file: `drivers/${driver}/${rel}` });
  if (!existsSync(dir)) {
    r.error(
      "Driver removed",
      `This PR deletes \`drivers/${driver}/\`; there is nothing left to enter.`
    );
    return;
  }
  const { files, others } = readDriverFiles(root, driver, tracked);
  const byRel = new Map(files.map((f) => [f.rel, f]));
  const allowed = allowedImports(root);

  if (existing) {
    r.warning(
      "Existing entry",
      `\`drivers/${driver}/\` is already on main, so this PR changes an entry rather than adding one. Check it comes from the entry’s author.`,
      at("")
    );
  }

  r.check("Plain files only", () => {
    for (const file of others) {
      r.error(
        "Not a plain file",
        "A symlink can point anywhere on the host, including at its secrets, and a submodule pulls in code from elsewhere. Commit the file itself.",
        { file }
      );
    }
  });

  // The manifest, as bin/suite reads it.
  let packages: Map<string, CupPackage>;
  try {
    packages = scanPackages(root);
  } catch (error) {
    r.error("Manifest", (error as Error).message);
    return;
  }
  const pkg = packages.get(driver);
  if (!pkg) {
    r.error(
      "Manifest",
      "No manifest: a Python driver needs a `[tool.context-cup]` table in its `pyproject.toml`, a TypeScript driver a `contextCup` block in its `package.json`.",
      at("")
    );
    return;
  }
  r.ok("Manifest parses");

  let lane: "python" | "typescript" | "agent" | undefined;
  r.check("Kind and engine", () => {
    if (pkg.kind === "engine") {
      r.error(
        "Kind",
        'An entry is `kind = "driver"` or `kind = "agent"`; engines are the course’s.',
        at("")
      );
      return;
    }
    if (pkg.kind === "agent") {
      // harbor runs the agent through a class of the runner's, so an entry
      // can name one the course has but not bring its own.
      const module = pkg.harbor_agent?.split(":")[0];
      if (
        module &&
        !existsSync(
          path.join(root, "course/runner/src", ...module.split(".")) + ".py"
        )
      ) {
        r.error(
          "Harbor agent",
          `\`harbor_agent\` names \`${module}\`, which the course’s runner doesn’t have, and a driver PR can’t add it. Name one it has, like \`base_codex\`’s, or enter a script agent (an \`agent.sh\`, like \`base_agent\`).`,
          at("")
        );
        return;
      }
      // A harbor agent's code is the runner's; a script agent brings agent.sh.
      if (!pkg.harbor_agent) lane = "agent";
      return;
    }
    let chain: CupPackage[];
    try {
      chain = resolveChain(driver, packages);
    } catch (error) {
      r.error("Engine", (error as Error).message, at(""));
      return;
    }
    const engine = chain[0]!;
    if (engine.kind !== "engine") {
      r.error(
        "Engine",
        `\`extends\` leads to \`${engine.name}\`, which is not an engine. Extend one of the engines under \`engines/\`.`,
        at("")
      );
      return;
    }
    lane = existsSync(path.join(engine.dir, "package.json"))
      ? "typescript"
      : "python";
  });

  r.check("Runs at the reference target", () => {
    const provider = lookupTarget(REFERENCE_TARGET, loadTargets()).provider;
    let providers: Provider[];
    try {
      providers = driverProviders(driver, packages);
    } catch {
      return; // a broken chain or kind, which the check above reports
    }
    if (!providers.includes(provider)) {
      r.error(
        "Providers",
        `The competition runs at \`${REFERENCE_TARGET}\`, a ${provider} model, but this driver supports only ${providers.join(", ")}. Add \`${provider}\` to \`providers\`.`,
        at("")
      );
    }
  });

  if (!pkg.description) {
    r.warning(
      "Description",
      "The manifest has no description; `bin/suite` shows it when it asks which driver to run.",
      at(byRel.has("package.json") ? "package.json" : "pyproject.toml")
    );
  } else {
    r.ok("Has a description");
  }

  r.check("Entry point", () => {
    if (lane === "agent") {
      if (!byRel.has("agent.sh")) {
        r.error(
          "Entry point",
          "A script agent needs an `agent.sh`; the course runs it once per trial.",
          at("agent.sh")
        );
      }
    } else if (byRel.has("run.sh")) {
      // A driver's own run.sh shadows its engine's, and needs no driver.py
      // or driver.ts.
    } else if (lane === "python") {
      const entry = byRel.get("driver.py");
      if (!entry) {
        r.error(
          "Entry point",
          "This lane needs a `driver.py`, or a `run.sh` of the driver’s own.",
          at("driver.py")
        );
      } else if (!/^(?:async\s+)?def\s+run\s*\(/m.test(entry.text ?? "")) {
        r.error(
          "Entry point",
          "`driver.py` defines no top-level `run(ctx)`.",
          at("driver.py")
        );
      }
    } else if (lane === "typescript") {
      const entry = byRel.get("driver.ts");
      if (!entry) {
        r.error(
          "Entry point",
          "This lane needs a `driver.ts`, or a `run.sh` of the driver’s own.",
          at("driver.ts")
        );
      } else if (
        !/export\s+(?:async\s+)?function\s+run\b|export\s+const\s+run\b|export\s*\{[^}]*\brun\b[^}]*\}/.test(
          entry.text ?? ""
        )
      ) {
        r.error(
          "Entry point",
          "`driver.ts` exports no `run`.",
          at("driver.ts")
        );
      }
    }
  });

  r.check("Has a README", () => {
    if (!byRel.has("README.md")) {
      r.error(
        "README",
        "Add a `README.md` saying what the strategy keeps, compresses, drops, or retrieves, and why. Reviewers judge the entry against it.",
        at("README.md")
      );
    }
  });

  if (!files.some((f) => isTestFile(f.rel))) {
    r.warning(
      "Tests",
      "No tests. A few (`test_<name>.py`, `<name>.test.ts`) catch a broken turn before a paid run does; see the Python base drivers’.",
      at("")
    );
  } else {
    r.ok("Has tests");
  }

  // Nothing of the entry's runs on the host: bin/suite and pnpm run there with
  // the competition's keys in the environment.
  r.check("Nothing runs on the host", () => {
    if (byRel.has("build.sh")) {
      r.error(
        "Host build script",
        "`build.sh` runs on the host, beside the competition’s keys, so an entry can’t ship one. Do the work in `setup.sh`, which runs inside the trial container.",
        at("build.sh")
      );
    }
    const manifest = byRel.get("package.json");
    if (manifest?.text) {
      reviewPackageJson(manifest.text, at("package.json"), allowed.npm, r);
    }
    for (const f of files) {
      if (["setup.py", "setup.cfg"].includes(path.basename(f.rel))) {
        r.error(
          "Build script",
          "A driver’s project is never built, and uv runs a `setup.py` on the host to build one. Remove it.",
          { file: f.file }
        );
      }
    }
    const pyproject = byRel.get("pyproject.toml");
    if (pyproject?.text) {
      reviewPyproject(pyproject.text, byRel.get("uv.lock"), at, r);
    }
    if (changed.includes(LOCKFILE) && !byRel.has("package.json")) {
      r.error(
        "Lockfile",
        "This PR changes `pnpm-lock.yaml`, but the driver has no `package.json`. Only a TypeScript driver’s dependencies belong there.",
        { file: LOCKFILE }
      );
    }
  });

  r.check("Nothing generated committed", () => {
    for (const f of files) {
      const reason = generatedReason(f.rel);
      if (reason) {
        r.error(
          "Generated file",
          `This is ${reason}; it is built or installed, never committed.`,
          { file: f.file }
        );
      }
    }
  });

  r.check("No secrets", () => {
    for (const f of files) {
      if (!f.text) continue;
      for (const [what, pattern] of SECRETS) {
        for (const hit of matchingLines(f.text, pattern)) {
          r.error(
            "Secret",
            `This looks like ${what}. The repo is public: revoke it, then remove it from the PR’s history.`,
            { file: f.file, line: hit.line }
          );
        }
      }
    }
  });

  r.check("Imports only the protocol and engines", () => {
    for (const f of files) {
      if (!f.text) continue;
      if (f.rel.endsWith(".py")) {
        for (const hit of matchingLines(
          f.text,
          /^\s*(?:from|import)\s+(context_cup_\w+)/
        )) {
          const module = /context_cup_\w+/.exec(hit.match)![0];
          if (!allowed.python.has(module)) {
            r.error(
              "Course import",
              `\`${module}\` is the course’s. A driver may import \`context_cup_protocol\` and its engine, and nothing else from the course.`,
              { file: f.file, line: hit.line }
            );
          }
        }
        for (const hit of matchingLines(
          f.text,
          /\bsys\.path\.(?:insert|append)\b/
        )) {
          r.warning(
            "Import path",
            "Changing `sys.path` can reach files outside the driver’s directory; check what it imports.",
            { file: f.file, line: hit.line }
          );
        }
      }
      if (/\.[cm]?[jt]sx?$/.test(f.rel)) {
        for (const hit of matchingLines(
          f.text,
          /(?:from|import|require)\s*\(?\s*["'](@context-cup\/[\w-]+)/
        )) {
          const name = /@context-cup\/[\w-]+/.exec(hit.match)![0];
          if (!allowed.npm.has(name)) {
            r.error(
              "Course import",
              `\`${name}\` is the course’s. A driver may import \`@context-cup/protocol\` and its engine, and nothing else from the course.`,
              { file: f.file, line: hit.line }
            );
          }
        }
        for (const hit of matchingLines(
          f.text,
          /(?:from|import|require)\s*\(?\s*["']\.\.\//
        )) {
          r.error(
            "Outside import",
            "This imports from outside the driver’s directory; only the directory is uploaded to a trial.",
            { file: f.file, line: hit.line }
          );
        }
      }
    }
  });

  r.check("Calls only the base URL it is given", () => {
    for (const f of files) {
      if (!f.text || f.rel === "README.md" || LOCKFILES.has(f.rel)) continue;
      for (const hit of matchingLines(f.text, PROVIDER_HOST)) {
        r.error(
          "Provider host",
          `\`${hit.match}\` is a provider’s own API. Every model call goes to the base URL the driver is given, which the SDKs read from the environment.`,
          { file: f.file, line: hit.line }
        );
      }
    }
  });

  // Warnings: not wrong in themselves, but what a reviewer reads first.
  // Tests included: they upload with the driver, and it can import them.
  const scanned = files.filter(
    (f) =>
      f.text !== undefined && f.rel !== "README.md" && !LOCKFILES.has(f.rel)
  );
  r.check("No outside URLs", () => {
    for (const f of scanned) {
      for (const hit of matchingLines(f.text!, OUTSIDE_URL).slice(
        0,
        MAX_HITS_PER_FILE
      )) {
        if (PROVIDER_HOST.test(hit.match)) continue;
        r.warning(
          "Outside URL",
          `\`${hit.match}\`: during a run a driver reaches only its model endpoint and the task’s tools. Check this is not called.`,
          { file: f.file, line: hit.line }
        );
      }
    }
  });

  r.check("No benchmark or task names", () => {
    for (const f of scanned) {
      const hits = [
        ...matchingLines(f.text!, BENCHMARK_NAME, true),
        ...matchingLines(f.text!, TASK_NAME, true),
      ].sort((a, b) => a.line - b.line);
      for (const hit of hits.slice(0, MAX_HITS_PER_FILE)) {
        r.warning(
          "Benchmark name",
          `\`${hit.match}\` names a benchmark or one of its tasks. Entries are generic context managers; check this is not tuned to the course.`,
          { file: f.file, line: hit.line }
        );
      }
    }
  });

  r.check("No large or binary files", () => {
    for (const f of files) {
      if (f.text === undefined) {
        r.warning(
          "Binary file",
          "A binary file can hide anything, from precomputed answers to an executable. Check what it is and why the driver needs it.",
          { file: f.file }
        );
      } else if (f.bytes.length > MAX_FILE_BYTES && !LOCKFILES.has(f.rel)) {
        r.warning(
          "Large file",
          `${(f.bytes.length / 1_000_000).toFixed(1)} MB. Check it holds nothing tuned to the benchmarks.`,
          { file: f.file }
        );
      }
    }
  });

  if (byRel.has("setup.sh")) {
    r.warning(
      "setup.sh",
      "Runs as root in every trial container, before the proxy that holds the keys starts. Read it in full: it should only install what the driver needs.",
      at("setup.sh")
    );
  }
}

function reviewPackageJson(
  text: string,
  at: { file: string },
  workspace: ReadonlySet<string>,
  r: Recorder
): void {
  let spec: Record<string, unknown>;
  try {
    spec = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return; // the manifest check already reported it
  }
  const scripts = isRecord(spec.scripts) ? spec.scripts : {};
  for (const name of INSTALL_SCRIPTS) {
    if (name in scripts) {
      r.error(
        "Install script",
        `\`scripts.${name}\` runs on the host when pnpm installs the workspace. Remove it; \`setup.sh\` runs inside the trial.`,
        at
      );
    }
  }
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const deps = isRecord(spec[field]) ? spec[field] : {};
    for (const [name, version] of Object.entries(deps)) {
      const v = String(version);
      if (v.startsWith("workspace:")) {
        if (!workspace.has(name)) {
          r.error(
            "Workspace dependency",
            `\`${name}\` is not the protocol or an engine; a driver depends on nothing else in the workspace.`,
            at
          );
        }
      } else if (!v.startsWith("catalog:") && !isRegistrySpec(v)) {
        r.error(
          "Dependency source",
          `\`${name}\` comes from \`${v}\`. Depend on registry packages only: anything else can run code on the host as it installs.`,
          at
        );
      }
    }
  }
}

function reviewPyproject(
  text: string,
  lock: DriverFile | undefined,
  at: (rel: string) => { file: string },
  r: Recorder
): void {
  let spec: Record<string, unknown>;
  try {
    spec = parseToml(text) as Record<string, unknown>;
  } catch {
    return; // the manifest check already reported it
  }
  const project = isRecord(spec.project) ? spec.project : {};
  const tool = isRecord(spec.tool) ? spec.tool : {};
  const uv = isRecord(tool.uv) ? tool.uv : {};
  if ("build-system" in spec) {
    r.error(
      "Build system",
      "A driver’s project is never built; a `[build-system]` table has uv build it on the host. Remove it.",
      at("pyproject.toml")
    );
  }
  if (uv.package === true || "workspace" in uv) {
    r.error(
      "Build system",
      "`[tool.uv] package = true` or a `[tool.uv.workspace]` has uv build the driver’s project on the host. A driver is a virtual project: remove them.",
      at("pyproject.toml")
    );
  }
  if ("sources" in uv) {
    r.error(
      "Dependency source",
      "`[tool.uv.sources]` pulls packages from git, a path, or a URL, which uv builds on the host. Depend on PyPI packages only.",
      at("pyproject.toml")
    );
  }
  const deps = Array.isArray(project.dependencies)
    ? project.dependencies.map(String)
    : [];
  for (const dep of deps) {
    if (dep.includes("@")) {
      r.error(
        "Dependency source",
        `\`${dep}\` names a direct URL, which uv builds on the host. Depend on PyPI packages only.`,
        at("pyproject.toml")
      );
    }
  }
  if (deps.length === 0) return;
  if (!lock?.text) {
    r.error(
      "uv.lock",
      "The driver declares Python dependencies but has no `uv.lock` beside its `pyproject.toml`; run `uv lock` there and commit it.",
      at("uv.lock")
    );
    return;
  }
  let locked: Record<string, unknown>;
  try {
    locked = parseToml(lock.text) as Record<string, unknown>;
  } catch (error) {
    r.error(
      "uv.lock",
      `Does not parse: ${(error as Error).message}`,
      at("uv.lock")
    );
    return;
  }
  const entries = Array.isArray(locked.package)
    ? locked.package.filter(isRecord)
    : [];
  const names = new Set(entries.map((p) => normalise(String(p.name))));
  for (const dep of deps) {
    const name = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(dep)?.[1];
    if (name && !names.has(normalise(name))) {
      r.error(
        "uv.lock",
        `\`${name}\` is in \`pyproject.toml\` but not in \`uv.lock\`; run \`uv lock\` and commit it.`,
        at("uv.lock")
      );
    }
  }
  for (const entry of entries) {
    const source = isRecord(entry.source) ? entry.source : {};
    if ("virtual" in source) continue; // the driver itself, never built
    const wheels = Array.isArray(entry.wheels) ? entry.wheels : [];
    if (!("registry" in source)) {
      r.error(
        "Dependency source",
        `\`${String(entry.name)}\` is locked from ${Object.keys(source).join(", ") || "an unknown source"}, not a package index, so uv would build it on the host.`,
        at("uv.lock")
      );
    } else if (wheels.length === 0) {
      r.error(
        "Source-only dependency",
        `\`${String(entry.name)}\` ${String(entry.version)} has no wheel, so uv would build it from source on the host. Pick a version that ships wheels.`,
        at("uv.lock")
      );
    }
  }
}

/** The static review of a PR, as checked out at `root` (its merge commit, in
 *  CI). `changed` is every path the PR changes, deletions included;
 *  `tracked` every file git tracks at `root`. Both are relative to `root`. */
export function reviewDriverPr(inputs: {
  root: string;
  changed: readonly string[];
  tracked: readonly string[];
  /** The drivers main already has, by folder name. */
  existing?: readonly string[];
}): Review {
  const r = new Recorder();
  const driver = reviewScope(inputs.changed, r);
  if (driver) {
    reviewDriver(
      inputs.root,
      driver,
      inputs.tracked,
      r,
      inputs.changed,
      inputs.existing?.includes(driver) ?? false
    );
  }
  return { driver, findings: r.findings, passed: r.passed };
}

/** The review of one driver directory alone, without the PR's scope. */
export function reviewDriverDir(inputs: {
  root: string;
  driver: string;
  tracked: readonly string[];
}): Review {
  const r = new Recorder();
  reviewDriver(inputs.root, inputs.driver, inputs.tracked, r, [], false);
  return { driver: inputs.driver, findings: r.findings, passed: r.passed };
}

/** Marks the PR comment the workflow keeps updated with this review. */
export const STATIC_MARKER = "<!-- driver-review:static -->";

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function location(f: Finding): string {
  if (!f.file) return "";
  return ` (\`${f.file}${f.line ? `:${f.line}` : ""}\`)`;
}

/** The review as the PR comment the workflow posts. */
export function formatMarkdown(review: Review): string {
  const errs = errors(review);
  const warns = warnings(review);
  const name = review.driver ? `\`${review.driver}\`` : "this PR";
  const lines = [
    STATIC_MARKER,
    `## ${errs.length === 0 ? "✅" : "❌"} Static review: ${name}`,
    "",
    `✅ ${review.passed.length} passed | ❌ ${count(errs.length, "error")} | ⚠️ ${count(warns.length, "warning")}`,
    "",
  ];
  if (errs.length > 0) {
    lines.push("### Errors (must fix)", "");
    for (const f of errs)
      lines.push(`- ❌ **${f.check}**: ${f.message}${location(f)}`);
    lines.push("");
  }
  if (warns.length > 0) {
    lines.push("### Warnings (for the reviewer)", "");
    for (const f of warns)
      lines.push(`- ⚠️ **${f.check}**: ${f.message}${location(f)}`);
    lines.push("");
  }
  if (review.passed.length > 0) {
    lines.push(
      "<details>",
      `<summary>Passed checks (${review.passed.length})</summary>`,
      ""
    );
    for (const p of review.passed) lines.push(`- ✅ ${p}`);
    lines.push("", "</details>", "");
  }
  return lines.join("\n");
}

function plainLocation(f: Finding): string {
  if (!f.file) return "";
  return ` (${f.file}${f.line ? `:${f.line}` : ""})`;
}

/** The review for a terminal: errors, warnings, and the counts. */
export function formatText(review: Review): string {
  const errs = errors(review);
  const warns = warnings(review);
  const lines = [`Static review: ${review.driver ?? "this branch"}`];
  for (const f of errs)
    lines.push(`  ✗ ${f.check}: ${f.message}${plainLocation(f)}`);
  for (const f of warns)
    lines.push(`  ! ${f.check}: ${f.message}${plainLocation(f)}`);
  lines.push(
    `  ${review.passed.length} passed, ${count(errs.length, "error")}, ${count(warns.length, "warning")}`
  );
  return lines.join("\n");
}

/** The review as JSON, for the workflow to read the driver and verdict. */
export function formatJson(review: Review): string {
  return JSON.stringify(
    {
      driver: review.driver ?? null,
      ok: errors(review).length === 0,
      errors: errors(review),
      warnings: warnings(review),
      passed: review.passed,
    },
    null,
    2
  );
}
