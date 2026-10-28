import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSandbox, destroySandbox, writeProjectConfig } from "../src/opencode/sandbox.js";

const tempDirs: string[] = [];

function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "sandbox-test-")).then((dir) => {
    tempDirs.push(dir);
    return dir;
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const EXPECTED_HOST_ENV_KEYS = [
  "HOME",
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
  "PATH",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
].sort();

describe("createSandbox", () => {
  it("creates project, home and xdg directories under the root", async () => {
    const sandbox = await createSandbox("/opt/oc/bin", {});
    try {
      for (const dir of [
        sandbox.paths.root,
        sandbox.paths.project,
        sandbox.paths.home,
        sandbox.paths.xdgConfig,
        sandbox.paths.xdgCache,
        sandbox.paths.xdgData,
        sandbox.paths.xdgState,
        sandbox.paths.work,
      ]) {
        const info = await stat(dir);
        expect(info.isDirectory()).toBe(true);
      }
      // every path lives inside root
      for (const dir of Object.values(sandbox.paths)) {
        if (dir !== sandbox.paths.root) {
          expect(path.dirname(dir)).toBe(sandbox.paths.root);
        }
      }
      expect(sandbox.configPath).toBe(path.join(sandbox.paths.project, "opencode.json"));
    } finally {
      await destroySandbox(sandbox.paths);
    }
  });

  it("derives hostEnv exactly from sandboxEnvironment (fixed key set)", async () => {
    const sandbox = await createSandbox("/opt/oc/bin", {});
    try {
      expect(Object.keys(sandbox.hostEnv).sort()).toEqual(EXPECTED_HOST_ENV_KEYS);
      expect(sandbox.hostEnv["HOME"]).toBe(sandbox.paths.home);
      expect(sandbox.hostEnv["XDG_CONFIG_HOME"]).toBe(sandbox.paths.xdgConfig);
      expect(sandbox.hostEnv["XDG_CACHE_HOME"]).toBe(sandbox.paths.xdgCache);
      expect(sandbox.hostEnv["XDG_DATA_HOME"]).toBe(sandbox.paths.xdgData);
      expect(sandbox.hostEnv["XDG_STATE_HOME"]).toBe(sandbox.paths.xdgState);
      expect(sandbox.hostEnv["OPENCODE_SERVER_PASSWORD"]).toBe(sandbox.password);
      expect(sandbox.hostEnv["OPENCODE_SERVER_USERNAME"]).toBe(sandbox.username);
      expect(sandbox.username).toBe("opencode");
    } finally {
      await destroySandbox(sandbox.paths);
    }
  });

  it("puts the target binary dir first on PATH, then extra dirs, then system dirs", async () => {
    const sandbox = await createSandbox("/opt/oc/bin", { extraPathDirs: ["/extra/tools"] });
    try {
      expect(sandbox.hostEnv["PATH"]).toBe(
        ["/opt/oc/bin", "/extra/tools", "/usr/bin", "/bin"].join(path.delimiter),
      );
    } finally {
      await destroySandbox(sandbox.paths);
    }
  });

  it("omits OPENCODE_SERVER_USERNAME when sandboxEnvironment would", async () => {
    // The sandbox always supplies a username, so assert the generated password shape instead.
    const sandbox = await createSandbox("/opt/oc/bin", {});
    try {
      expect(sandbox.password).toMatch(/^[0-9a-f]{48}$/);
      expect(sandbox.password).not.toBe(sandbox.username);
    } finally {
      await destroySandbox(sandbox.paths);
    }
  });
});

describe("writeProjectConfig", () => {
  it("writes $schema and registers the plugin as a string entry", async () => {
    const dir = await makeTempDir();
    const configPath = await writeProjectConfig(dir, "/abs/plugin-dir");
    expect(configPath).toBe(path.join(dir, "opencode.json"));
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(parsed["$schema"]).toBe("https://opencode.ai/config.json");
    expect(parsed["plugin"]).toEqual(["/abs/plugin-dir"]);
  });

  it("never uses the {package,options} object form (host cannot resolve local paths)", async () => {
    // Verified against OpenCode 2.1.2 and 2.2.0: {package: <local dir>} does
    // not load. The string entry is the only supported registration (ADR 0003).
    const dir = await makeTempDir();
    await writeProjectConfig(dir, "/abs/plugin-dir");
    const parsed = JSON.parse(await readFile(path.join(dir, "opencode.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(parsed["plugin"]).toEqual(["/abs/plugin-dir"]);
  });

  it("overwrites an existing config file", async () => {
    const dir = await makeTempDir();
    await mkdir(dir, { recursive: true });
    await writeProjectConfig(dir, "/first");
    await writeProjectConfig(dir, "/second");
    const parsed = JSON.parse(await readFile(path.join(dir, "opencode.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(parsed["plugin"]).toEqual(["/second"]);
  });
});

describe("destroySandbox", () => {
  it("removes the sandbox root and everything under it", async () => {
    const sandbox = await createSandbox("/opt/oc/bin", {});
    const root = sandbox.paths.root;
    const info = await stat(root);
    expect(info.isDirectory()).toBe(true);
    await destroySandbox(sandbox.paths);
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
