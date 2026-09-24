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
  driverShortName,
  findDriver,
  resolveChain,
  scanPackages,
  type CupPackage,
} from "../src/packages.ts";
import { samplePackages } from "./helpers.ts";

describe("resolveChain", () => {
  it("walks a two-level chain root to leaf", async () => {
    const chain = resolveChain(
      "@context-cup-drivers/base_python",
      samplePackages()
    );
    expect(chain.map((p) => p.name)).toEqual([
      "@context-cup/engine-python",
      "@context-cup-drivers/base_python",
    ]);
    expect(driverChainDirs("base_python", samplePackages())).toEqual([
      "/ws/engines/python",
      "/ws/drivers/base_python",
    ]);
  });

  it("walks any depth", async () => {
    const pkgs = samplePackages();
    pkgs.set("@context-cup/engine-summarise", {
      name: "@context-cup/engine-summarise",
      dir: "/ws/engines/summarise",
      kind: "engine",
      extends: "@context-cup/engine-python",
    });
    pkgs.set("@context-cup/fancy", {
      name: "@context-cup/fancy",
      dir: "/ws/drivers/fancy",
      kind: "driver",
      extends: "@context-cup/engine-summarise",
    });
    expect(resolveChain("@context-cup/fancy", pkgs).map((p) => p.dir)).toEqual([
      "/ws/engines/python",
      "/ws/engines/summarise",
      "/ws/drivers/fancy",
    ]);
  });

  it("names an unknown parent", async () => {
    const pkgs = samplePackages();
    pkgs.set("@context-cup/orphan", {
      name: "@context-cup/orphan",
      dir: "/ws/drivers/orphan",
      kind: "driver",
      extends: "@context-cup/engine-missing",
    });
    expect(() => resolveChain("@context-cup/orphan", pkgs)).toThrow(
      "Package @context-cup/orphan extends @context-cup/engine-missing, which is not a driver or engine package"
    );
    expect(() => resolveChain("@context-cup/nope", pkgs)).toThrow(
      "Unknown package @context-cup/nope"
    );
  });

  it("detects a cycle", async () => {
    const pkgs = new Map<string, CupPackage>([
      [
        "@context-cup/a",
        {
          name: "@context-cup/a",
          dir: "/a",
          kind: "engine",
          extends: "@context-cup/b",
        },
      ],
      [
        "@context-cup/b",
        {
          name: "@context-cup/b",
          dir: "/b",
          kind: "engine",
          extends: "@context-cup/a",
        },
      ],
    ]);
    expect(() => resolveChain("@context-cup/a", pkgs)).toThrow(
      "cyclic extends chain: @context-cup/a -> @context-cup/b -> @context-cup/a"
    );
  });
});

describe("findDriver", () => {
  it("accepts drivers only, by short name", async () => {
    expect(findDriver("base_passthrough", samplePackages()).dir).toBe(
      "/ws/drivers/base_passthrough"
    );
    expect(() => findDriver("engine-python", samplePackages())).toThrow(
      'Unknown driver "engine-python". Drivers in the workspace: base_passthrough, base_python'
    );
    expect(driverShortName("@context-cup-drivers/base_python")).toBe(
      "base_python"
    );
  });

  it("scans the real workspace", async () => {
    const pkgs = scanPackages();
    expect(pkgs.get("@context-cup/engine-python")?.kind).toBe("engine");
    expect(findDriver("base_passthrough", pkgs).extends).toBe(
      "@context-cup/engine-python"
    );
    expect(
      driverChainDirs("base_passthrough", pkgs).map((d) =>
        d.split("/").slice(-2).join("/")
      )
    ).toEqual(["engines/python", "drivers/base_passthrough"]);
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
      [
        "@context-cup/e",
        pkg("@context-cup/e", "engine", { providers: ["openai", "gemini"] }),
      ],
      [
        "@context-cup-drivers/d",
        pkg("@context-cup-drivers/d", "driver", { extends: "@context-cup/e" }),
      ],
    ]);
    expect(driverProviders("d", packages)).toEqual(["openai", "gemini"]);
  });

  it("lets the leaf narrow the list", () => {
    const packages = new Map<string, CupPackage>([
      [
        "@context-cup/e",
        pkg("@context-cup/e", "engine", { providers: ["openai", "gemini"] }),
      ],
      [
        "@context-cup-drivers/d",
        pkg("@context-cup-drivers/d", "driver", {
          extends: "@context-cup/e",
          providers: ["openai"],
        }),
      ],
    ]);
    expect(driverProviders("d", packages)).toEqual(["openai"]);
  });

  it("supports every provider when nothing in the chain declares one", () => {
    const packages = new Map<string, CupPackage>([
      ["@context-cup-drivers/d", pkg("@context-cup-drivers/d", "driver")],
    ]);
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
          name: "@context-cup-drivers/bad",
          contextCup: { kind: "agent" },
        })
      );
      expect(scanPackages(dir).get("@context-cup-drivers/bad")).toMatchObject({
        kind: "agent",
        harbor_agent: undefined,
      });
      writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify({
          name: "@context-cup-drivers/bad",
          contextCup: {
            kind: "agent",
            harbor_agent: "x.y:Z",
            extends: "@context-cup/engine-python",
          },
        })
      );
      expect(() => scanPackages(dir)).toThrow(/does not extend/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
