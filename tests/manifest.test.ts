import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  exportTargetPath,
  isValidSemver,
  type PluginManifest,
  readManifest,
  requiredExportFiles,
  resolveExportsValue,
  serverExport,
  validateManifest,
} from "../src/package/manifest.js";

async function writeManifest(json: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manifest-"));
  await writeFile(path.join(dir, "package.json"), json);
  return dir;
}

describe("readManifest", () => {
  it("parses a full manifest", async () => {
    const dir = await writeManifest(
      JSON.stringify({
        name: "p",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./i.ts" },
        dependencies: { x: "1" },
      }),
    );
    const result = await readManifest(dir);
    if ("manifest" in result) {
      expect(result.manifest.name).toBe("p");
      expect(result.manifest.version).toBe("1.0.0");
      expect(result.manifest.type).toBe("module");
      expect(result.manifest.exports).toEqual({ ".": "./i.ts" });
      expect(result.manifest.dependencies).toEqual({ x: "1" });
      expect(result.manifest.raw).toHaveProperty("name");
    } else {
      expect.unreachable();
    }
  });

  it("reports missing package.json", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "manifest-"));
    const result = await readManifest(dir);
    expect("error" in result && result.error.code).toBe("PKG001");
  });

  it("reports invalid JSON", async () => {
    const dir = await writeManifest("{oops");
    const result = await readManifest(dir);
    expect("error" in result && result.error.code).toBe("PKG002");
  });

  it("reports non-object roots", async () => {
    const dir = await writeManifest("[1,2]");
    const result = await readManifest(dir);
    expect("error" in result && result.error.code).toBe("PKG002");
  });

  it("treats non-string fields as null and non-record deps/exports as null", async () => {
    const dir = await writeManifest(
      JSON.stringify({ name: 1, version: {}, type: 3, exports: [], dependencies: "x" }),
    );
    const result = await readManifest(dir);
    if ("manifest" in result) {
      expect(result.manifest.name).toBeNull();
      expect(result.manifest.version).toBeNull();
      expect(result.manifest.type).toBeNull();
      expect(result.manifest.exports).toBeNull();
      expect(result.manifest.dependencies).toBeNull();
    } else {
      expect.unreachable();
    }
  });
});

describe("exports helpers", () => {
  it("resolveExportsValue handles strings and conditionals", () => {
    expect(resolveExportsValue("./a.ts")).toBe("./a.ts");
    expect(resolveExportsValue({ import: "./b.ts", require: "./c.js" })).toBe("./b.ts");
    expect(resolveExportsValue({ default: "./d.ts" })).toBe("./d.ts");
    expect(resolveExportsValue({ types: "./e.d.ts" })).toBeNull();
  });

  it("serverExport prefers . then ./server", () => {
    const base: PluginManifest = {
      name: "p",
      version: "1.0.0",
      type: "module",
      exports: null,
      dependencies: null,
      raw: {},
    };
    expect(serverExport(base)).toBeNull();
    expect(serverExport({ ...base, exports: {} })).toBeNull();
    expect(serverExport({ ...base, exports: { "./server": "./s.ts" } })).toEqual({
      specifier: "./server",
      target: "./s.ts",
    });
    expect(
      serverExport({ ...base, exports: { ".": { types: "./t.d.ts" }, "./server": "./s.ts" } }),
    ).toEqual({ specifier: "./server", target: "./s.ts" }); // "." exists but resolves to null, so the loop skips to ./server
  });

  it("serverExport falls through a non-resolving dot entry", () => {
    const base: PluginManifest = {
      name: "p",
      version: "1.0.0",
      type: "module",
      exports: null,
      dependencies: null,
      raw: {},
    };
    const exportsMap = { ".": { types: "./t.d.ts" }, "./server": "./s.ts" };
    expect(serverExport({ ...base, exports: exportsMap })).toEqual({
      specifier: "./server",
      target: "./s.ts",
    });
  });

  it("exportTargetPath normalizes", () => {
    expect(exportTargetPath("./a/b.ts")).toBe("a/b.ts");
    expect(exportTargetPath("c.ts?query")).toBe("c.ts");
  });

  it("isValidSemver", () => {
    expect(isValidSemver("1.0.0")).toBe(true);
    expect(isValidSemver("1.0.0-beta.1+build")).toBe(true);
    expect(isValidSemver("1.0")).toBe(false);
    expect(isValidSemver("v1.0.0")).toBe(false);
  });
});

describe("validateManifest", () => {
  const good: PluginManifest = {
    name: "p",
    version: "1.0.0",
    type: "module",
    exports: { ".": "./i.ts" },
    dependencies: null,
    raw: {},
  };

  it("passes a good manifest", () => {
    expect(validateManifest(good)).toEqual([]);
  });

  it("flags missing name", () => {
    const problems = validateManifest({ ...good, name: null });
    expect(problems.map((p) => p.code)).toContain("PKG003");
  });

  it("flags missing/invalid version", () => {
    expect(validateManifest({ ...good, version: null }).map((p) => p.code)).toContain("PKG004");
    expect(validateManifest({ ...good, version: "banana" }).map((p) => p.code)).toContain("PKG004");
  });

  it("flags missing exports", () => {
    expect(validateManifest({ ...good, exports: null }).map((p) => p.code)).toContain("PKG005");
  });

  it("flags missing server export", () => {
    expect(
      validateManifest({ ...good, exports: { "./tui": "./t.ts" } }).map((p) => p.code),
    ).toContain("PKG006");
  });

  it("warns about non-ESM and injected SDK dependency", () => {
    expect(validateManifest({ ...good, type: "commonjs" }).map((p) => p.code)).toContain("PKG012");
    expect(
      validateManifest({ ...good, dependencies: { "@opencode/plugin": "^2" } }).map((p) => p.code),
    ).toContain("PKG009");
  });

  it("collects required export files", () => {
    expect(
      requiredExportFiles({
        ...good,
        exports: {
          ".": "./a.ts",
          "./tui": "./tui.ts",
          "./rpc": "./rpc.ts",
          "./gui-experimental": "./gui.ts",
          "./other": "./o.ts",
          "./broken": { types: "./x.d.ts" },
        },
      }),
    ).toEqual(["a.ts", "tui.ts", "rpc.ts", "gui.ts"]);
    expect(requiredExportFiles({ ...good, exports: null })).toEqual([]);
  });

  it("skips export targets that normalize to an empty path", () => {
    expect(
      requiredExportFiles({
        ...good,
        exports: { ".": "./", "./tui": "" },
      }),
    ).toEqual([]);
  });
});
