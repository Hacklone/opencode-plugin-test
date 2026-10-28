import { access } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createTempDir,
  ensureDir,
  removeDir,
  resolvePackageRoot,
  WORKSPACE_PREFIX,
} from "../src/util/dirs.js";
import { generateServerPassword, sandboxEnvironment } from "../src/util/env.js";
import { allocatePort } from "../src/util/ports.js";

describe("dirs", () => {
  it("creates and removes temp dirs", async () => {
    const dir = await createTempDir();
    expect(path.basename(dir).startsWith(WORKSPACE_PREFIX)).toBe(true);
    await ensureDir(path.join(dir, "a/b"));
    await removeDir(dir);
    await expect(access(dir)).rejects.toThrow();
  });

  it("resolvePackageRoot uses cwd as default", () => {
    expect(resolvePackageRoot(undefined)).toBe(process.cwd());
    expect(resolvePackageRoot("relative")).toBe(path.resolve("relative"));
  });
});

describe("env", () => {
  it("builds a fully sanitized environment", () => {
    const env = sandboxEnvironment({
      home: "/s/home",
      xdgConfig: "/s/config",
      xdgCache: "/s/cache",
      xdgData: "/s/data",
      xdgState: "/s/state",
      extraPath: ["/target/bin"],
      serverPassword: "pw",
      serverUsername: "user",
    });
    expect(env["HOME"]).toBe("/s/home");
    expect(env["XDG_CONFIG_HOME"]).toBe("/s/config");
    expect(env["XDG_CACHE_HOME"]).toBe("/s/cache");
    expect(env["XDG_DATA_HOME"]).toBe("/s/data");
    expect(env["XDG_STATE_HOME"]).toBe("/s/state");
    expect(env["PATH"]).toBe("/target/bin:/usr/bin:/bin");
    expect(env["OPENCODE_SERVER_PASSWORD"]).toBe("pw");
    expect(env["OPENCODE_SERVER_USERNAME"]).toBe("user");
    // nothing else leaks
    expect(Object.keys(env).sort()).toEqual([
      "HOME",
      "OPENCODE_SERVER_PASSWORD",
      "OPENCODE_SERVER_USERNAME",
      "PATH",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
    ]);
  });

  it("omits the username when not given", () => {
    const env = sandboxEnvironment({
      home: "/h",
      xdgConfig: "/c",
      xdgCache: "/k",
      xdgData: "/d",
      xdgState: "/st",
      extraPath: [],
      serverPassword: "pw",
    });
    expect(env["OPENCODE_SERVER_USERNAME"]).toBeUndefined();
  });

  it("generates hex passwords", () => {
    const pw = generateServerPassword();
    expect(pw).toMatch(/^[0-9a-f]{48}$/);
    expect(generateServerPassword()).not.toBe(pw);
  });
});

describe("ports", () => {
  it("allocates distinct free ports", async () => {
    const a = await allocatePort();
    const b = await allocatePort();
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
  });

  it("rejects when no usable port can be determined", async () => {
    const realCreateServer = net.createServer.bind(net);
    const spy = vi.spyOn(net, "createServer").mockImplementation(() => {
      const server = realCreateServer();
      server.address = () => null;
      return server;
    });
    try {
      await expect(allocatePort()).rejects.toThrow("could not allocate a port");
    } finally {
      spy.mockRestore();
    }
  });
});
