import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describe,
  expect,
  it,
} from "@context-cup/shared/test_helpers/index.js";
import { PROVIDERS } from "../src/keys.ts";
import {
  driverChainDirs,
  driverProviders,
  findDriver,
  resolveChain,
  scanPackages,
  type CupPackage,
} from "../src/packages.ts";
import { samplePackages } from "./helpers.ts";

describe("resolveChain", () => {
  it("walks a two-level chain root to leaf", async () => {
    const chain = resolveChain("base_python", samplePackages());
    expect(chain.map((p) => p.name)).toEqual(["python", "base_python"]);
    expect(driverChainDirs("base_python", samplePackages())).toEqual([
      "/ws/engines/python",
      "/ws/drivers/base_python",
    ]);
  });

  it("walks any depth", async () => {
    const pkgs = samplePackages();
    pkgs.set("summarise", {
      name: "summarise",
      dir: "/ws/engines/summarise",
      kind: "engine",
      extends: "python",
    });
    pkgs.set("fancy", {
      name: "fancy",
      dir: "/ws/drivers/fancy",
      kind: "driver",
      extends: "summarise",
    });
    expect(resolveChain("fancy", pkgs).map((p) => p.dir)).toEqual([
      "/ws/engines/python",
      "/ws/engines/summarise",
      "/ws/drivers/fancy",
    ]);
  });

  it("names an unknown parent", async () => {
    const pkgs = samplePackages();
    pkgs.set("orphan", {
      name: "orphan",
      dir: "/ws/drivers/orphan",
      kind: "driver",
      extends: "missing",
    });
    expect(() => resolveChain("orphan", pkgs)).toThrow(
      "Package orphan extends missing, which is not a driver or engine package"
    );
    expect(() => resolveChain("nope", pkgs)).toThrow("Unknown package nope");
  });

  it("detects a cycle", async () => {
    const pkgs = new Map<string, CupPackage>([
      [
        "a",
        {
          name: "a",
          dir: "/a",
          kind: "engine",
          extends: "b",
        },
      ],
      [
        "b",
        {
          name: "b",
          dir: "/b",
          kind: "engine",
          extends: "a",
        },
      ],
    ]);
    expect(() => resolveChain("a", pkgs)).toThrow(
      "cyclic extends chain: a -> b -> a"
    );
  });
});

describe("findDriver", () => {
  it("accepts drivers only, by folder name", async () => {
    expect(findDriver("base_passthrough", samplePackages()).dir).toBe(
      "/ws/drivers/base_passthrough"
    );
    expect(() => findDriver("python", samplePackages())).toThrow(
      'Unknown driver "python". Drivers in the workspace: base_passthrough, base_python'
    );
  });

  it("suggests the driver a typo meant", async () => {
    const message = (name: string) => {
      try {
        findDriver(name, samplePackages());
      } catch (err) {
        return (err as Error).message;
      }
      throw new Error(`${name} resolved`);
    };
    expect(message("basepython")).toContain("Did you mean base_python?");
    expect(message(" Base_Python")).toContain("Did you mean base_python?");
    expect(message("base_pyhton")).toContain("Did you mean base_python?");
    expect(message("base_passthru")).not.toContain("Did you mean");
    expect(message("")).not.toContain("Did you mean");
  });

  it("scans the real workspace", async () => {
    const pkgs = scanPackages();
    expect(pkgs.get("python")?.kind).toBe("engine");
    expect(findDriver("base_python", pkgs).extends).toBe("python");
    expect(
      driverChainDirs("base_python", pkgs).map((d) =>
        d.split("/").slice(-2).join("/")
      )
    ).toEqual(["engines/python", "drivers/base_python"]);
  });
});

describe("providers", () => {
  const pkg = (
    name: string,
    kind: "driver" | "engine",
    extra: Partial<CupPackage> = {}
  ): CupPackage => ({ name, dir: `/ws/${name}`, kind, ...extra });

  it("inherits the parent's list when a driver declares none", () => {
    const packages = new Map<string, CupPackage>([
      ["e", pkg("e", "engine", { providers: ["openai", "gemini"] })],
      ["d", pkg("d", "driver", { extends: "e" })],
    ]);
    expect(driverProviders("d", packages)).toEqual(["openai", "gemini"]);
  });

  it("lets the leaf narrow the list", () => {
    const packages = new Map<string, CupPackage>([
      ["e", pkg("e", "engine", { providers: ["openai", "gemini"] })],
      [
        "d",
        pkg("d", "driver", {
          extends: "e",
          providers: ["openai"],
        }),
      ],
    ]);
    expect(driverProviders("d", packages)).toEqual(["openai"]);
  });

  it("supports every provider when nothing in the chain declares one", () => {
    const packages = new Map<string, CupPackage>([["d", pkg("d", "driver")]]);
    expect(driverProviders("d", packages)).toEqual([...PROVIDERS]);
  });
});

describe("agent packages", () => {
  it("are runnable drivers with their own providers and no chain", async () => {
    const packages = samplePackages();
    expect(findDriver("base_codex", packages).kind).toBe("agent");
    expect(driverProviders("base_codex", packages)).toEqual(["openai"]);
  });

  it("may be a script agent but cannot extend an engine", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cup-agent-"));
    try {
      const pkg = join(dir, "drivers", "bad");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify({
          name: "bad",
          contextCup: { kind: "agent" },
        })
      );
      expect(scanPackages(dir).get("bad")).toMatchObject({
        kind: "agent",
        harbor_agent: undefined,
      });
      writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify({
          name: "bad",
          contextCup: {
            kind: "agent",
            harbor_agent: "x.y:Z",
            extends: "python",
          },
        })
      );
      expect(() => scanPackages(dir)).toThrow(/does not extend/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("manifests", () => {
  /** A throwaway workspace; each entry is a package folder and its files. */
  function workspace(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "cup-manifest-"));
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), text);
    }
    return root;
  }

  it("reads package.json or pyproject.toml, naming a package by its folder", () => {
    const root = workspace({
      "engines/python/pyproject.toml": [
        '[project]\nname = "context-cup-engine-python"',
        'description = "The Python engine."',
        '[tool.context-cup]\nkind = "engine"\nproviders = ["openai"]',
      ].join("\n"),
      "drivers/keep/pyproject.toml": [
        '[project]\nname = "anything"\ndependencies = []',
        '[tool.context-cup]\nkind = "driver"\nextends = "python"',
        "config = { keep = 3 }",
      ].join("\n"),
      "drivers/ts/package.json": JSON.stringify({
        name: "@whatever/else",
        contextCup: { kind: "driver", extends: "python" },
      }),
      "drivers/notes/pyproject.toml": '[project]\nname = "notes"',
    });
    try {
      const pkgs = scanPackages(root);
      expect([...pkgs.keys()].sort()).toEqual(["keep", "python", "ts"]);
      expect(pkgs.get("python")).toMatchObject({
        kind: "engine",
        providers: ["openai"],
        description: "The Python engine.",
      });
      expect(pkgs.get("keep")).toMatchObject({
        kind: "driver",
        extends: "python",
        config: { keep: 3 },
      });
      expect(
        driverChainDirs("keep", pkgs).map((d) => d.slice(root.length))
      ).toEqual(["/engines/python", "/drivers/keep"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers package.json when a package has both", () => {
    const root = workspace({
      "drivers/both/package.json": JSON.stringify({
        contextCup: { kind: "agent" },
      }),
      "drivers/both/pyproject.toml": '[tool.context-cup]\nkind = "driver"',
    });
    try {
      expect(scanPackages(root).get("both")?.kind).toBe("agent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses two packages in folders of one name", () => {
    const root = workspace({
      "engines/same/package.json": JSON.stringify({
        contextCup: { kind: "engine" },
      }),
      "drivers/same/pyproject.toml": '[tool.context-cup]\nkind = "driver"',
    });
    try {
      expect(() => scanPackages(root)).toThrow(/Two packages are named same/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
