import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { PluginFeatures, PluginInfo, PluginSource, PluginState } from "../src/domain/types.js";
import {
  builtinCount,
  fetchPluginList,
  findPlugin,
  matchesMaterializedDir,
  parsePluginInfo,
  parsePluginList,
  type ServerRef,
} from "../src/opencode/client.js";

const tmpDirs: string[] = [];

function newTmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface InfoOverrides {
  id?: string;
  source: PluginSource;
  features: PluginFeatures;
  state: PluginState;
}

function makeInfo(overrides: InfoOverrides): PluginInfo {
  const info: PluginInfo = {
    source: overrides.source,
    features: overrides.features,
    state: overrides.state,
  };
  if (overrides.id !== undefined) {
    info.id = overrides.id;
  }
  return info;
}

const activeState: PluginState = { status: "active" };
const _noFeatures: PluginFeatures = {};

describe("parsePluginInfo (state/source/features validators)", () => {
  it("parses a full valid entry", () => {
    const parsed = parsePluginInfo({
      id: "my-plugin",
      source: { type: "local", path: "/x/p" },
      features: { server: true, tui: true, rpc: true },
      state: { status: "active" },
    });
    expect(parsed).toEqual({
      id: "my-plugin",
      source: { type: "local", path: "/x/p" },
      features: { server: true, tui: true, rpc: true },
      state: { status: "active" },
    });
  });

  it("omits id when it is not a string", () => {
    const parsed = parsePluginInfo({
      id: 42,
      source: { type: "builtin" },
      features: {},
      state: { status: "active" },
    });
    expect(parsed).not.toBeNull();
    if (parsed !== null) {
      expect("id" in parsed).toBe(false);
      expect(parsed.source).toEqual({ type: "builtin" });
    }
  });

  it("rejects non-object roots", () => {
    expect(parsePluginInfo(null)).toBeNull();
    expect(parsePluginInfo("str")).toBeNull();
    expect(parsePluginInfo(42)).toBeNull();
    expect(parsePluginInfo([])).toBeNull();
  });

  it("rejects missing or invalid source", () => {
    expect(parsePluginInfo({ features: {}, state: activeState })).toBeNull();
    expect(
      parsePluginInfo({ source: { type: "weird" }, features: {}, state: activeState }),
    ).toBeNull();
    expect(
      parsePluginInfo({ source: { type: "local" }, features: {}, state: activeState }),
    ).toBeNull();
    expect(
      parsePluginInfo({ source: { type: "local", path: 3 }, features: {}, state: activeState }),
    ).toBeNull();
    expect(
      parsePluginInfo({ source: { type: "package" }, features: {}, state: activeState }),
    ).toBeNull();
  });

  it("accepts sdk and package sources with a string target", () => {
    expect(parsePluginInfo({ source: { type: "sdk" }, features: {}, state: activeState })).toEqual({
      source: { type: "sdk" },
      features: {},
      state: activeState,
    });
    expect(
      parsePluginInfo({
        source: { type: "package", target: "npm:p" },
        features: {},
        state: activeState,
      }),
    ).toEqual({ source: { type: "package", target: "npm:p" }, features: {}, state: activeState });
  });

  it("rejects missing or non-object features", () => {
    expect(parsePluginInfo({ source: { type: "builtin" }, state: activeState })).toBeNull();
    expect(
      parsePluginInfo({ source: { type: "builtin" }, features: true, state: activeState }),
    ).toBeNull();
  });

  it("tolerates array-typed features as an empty feature set", () => {
    const parsed = parsePluginInfo({
      source: { type: "builtin" },
      features: [],
      state: activeState,
    });
    expect(parsed).toEqual({ source: { type: "builtin" }, features: {}, state: activeState });
  });

  it("ignores non-true feature values", () => {
    const parsed = parsePluginInfo({
      source: { type: "builtin" },
      features: { server: false, tui: "yes" },
      state: activeState,
    });
    expect(parsed).toEqual({ source: { type: "builtin" }, features: {}, state: activeState });
  });

  it("rejects missing or invalid state", () => {
    expect(parsePluginInfo({ source: { type: "builtin" }, features: {} })).toBeNull();
    expect(
      parsePluginInfo({ source: { type: "builtin" }, features: {}, state: { status: "wat" } }),
    ).toBeNull();
    expect(
      parsePluginInfo({ source: { type: "builtin" }, features: {}, state: { status: "failed" } }),
    ).toBeNull();
    expect(
      parsePluginInfo({
        source: { type: "builtin" },
        features: {},
        state: { status: "failed", error: 1 },
      }),
    ).toBeNull();
  });

  it("parses failed state with and without ref", () => {
    const failed = parsePluginInfo({
      source: { type: "builtin" },
      features: {},
      state: { status: "failed", error: "boom", ref: "r1" },
    });
    expect(failed?.state).toEqual({ status: "failed", error: "boom", ref: "r1" });
    const failedNoRef = parsePluginInfo({
      source: { type: "builtin" },
      features: {},
      state: { status: "failed", error: "boom" },
    });
    expect(failedNoRef?.state).toEqual({ status: "failed", error: "boom" });
  });
});

describe("parsePluginList", () => {
  it("parses a valid {location, data} body and drops invalid entries", () => {
    const good = {
      id: "p1",
      source: { type: "local", path: "/x/p1" },
      features: {},
      state: { status: "active" },
    };
    const plugins = parsePluginList({ location: "http://x", data: [good, { nope: true }, "junk"] });
    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.id).toBe("p1");
  });

  it("returns [] for bad JSON bodies (null/undefined)", () => {
    expect(parsePluginList(null)).toEqual([]);
    expect(parsePluginList(undefined)).toEqual([]);
  });

  it("returns [] when data is not an array", () => {
    expect(parsePluginList({ data: {} })).toEqual([]);
    expect(parsePluginList({ data: "nope" })).toEqual([]);
    expect(parsePluginList({})).toEqual([]);
  });

  it("returns [] for non-object bodies", () => {
    expect(parsePluginList(42)).toEqual([]);
    expect(parsePluginList("str")).toEqual([]);
  });
});

describe("fetchPluginList", () => {
  const server: ServerRef = { baseUrl: "http://127.0.0.1:4099", username: "u", password: "p" };

  function stubFetch(
    status: number,
    body: string,
  ): Mock<(url: string | URL, init?: RequestInit) => Promise<Response>> {
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit) => new Response(body, { status }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("returns the plugin list on 200 with a valid body", async () => {
    const body = JSON.stringify({
      location: "http://x",
      data: [
        {
          id: "p1",
          source: { type: "local", path: "/x/p1" },
          features: { server: true },
          state: { status: "active" },
        },
        { source: { type: "builtin" }, features: {}, state: { status: "active" } },
      ],
    });
    const fetchMock = stubFetch(200, body);
    const result = await fetchPluginList(server, 1000);
    if ("plugins" in result) {
      expect(result.plugins).toHaveLength(2);
      expect(result.plugins[0]?.id).toBe("p1");
      expect(result.plugins[1]?.source).toEqual({ type: "builtin" });
    } else {
      expect.unreachable();
    }
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:4099/api/plugin");
  });

  it("maps 401 to diag API002", async () => {
    stubFetch(401, "");
    const result = await fetchPluginList(server, 1000);
    if ("error" in result) {
      expect(result.error.code).toBe("API002");
      expect(result.error.hint).toBe("check OPENCODE_SERVER_PASSWORD handling");
    } else {
      expect.unreachable();
    }
  });

  it("maps 403 to diag API002", async () => {
    stubFetch(403, "");
    const result = await fetchPluginList(server, 1000);
    if ("error" in result) {
      expect(result.error.code).toBe("API002");
    } else {
      expect.unreachable();
    }
  });

  it("maps other HTTP errors to diag API001", async () => {
    stubFetch(500, "");
    const result = await fetchPluginList(server, 1000);
    if ("error" in result) {
      expect(result.error.code).toBe("API001");
      expect(result.error.message).toContain("500");
    } else {
      expect.unreachable();
    }
  });

  it("maps network rejection to diag API001", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const result = await fetchPluginList(server, 1000);
    if ("error" in result) {
      expect(result.error.code).toBe("API001");
      expect(result.error.message).toContain("failed");
    } else {
      expect.unreachable();
    }
  });

  it("returns an empty list for non-JSON 200 bodies", async () => {
    stubFetch(200, "<html>not json</html>");
    const result = await fetchPluginList(server, 1000);
    if ("plugins" in result) {
      expect(result.plugins).toEqual([]);
    } else {
      expect.unreachable();
    }
  });
});

describe("builtinCount", () => {
  it("counts builtin sources only", () => {
    const plugins: PluginInfo[] = [
      makeInfo({ source: { type: "builtin" }, features: {}, state: activeState }),
      makeInfo({ source: { type: "local", path: "/a" }, features: {}, state: activeState }),
      makeInfo({ source: { type: "builtin" }, features: {}, state: activeState }),
      makeInfo({ source: { type: "package", target: "npm:p" }, features: {}, state: activeState }),
    ];
    expect(builtinCount(plugins)).toBe(2);
  });

  it("returns 0 for an empty list", () => {
    expect(builtinCount([])).toBe(0);
  });
});

describe("matchesMaterializedDir", () => {
  it("matches the exact dir", () => {
    const root = newTmpDir("client-");
    const dir = path.join(root, "artifact");
    mkdirSync(dir);
    const info = makeInfo({
      source: { type: "local", path: dir },
      features: {},
      state: activeState,
    });
    expect(matchesMaterializedDir(info, dir)).toBe(true);
  });

  it("matches a subpath under the dir", () => {
    const root = newTmpDir("client-");
    const dir = path.join(root, "artifact");
    const info = makeInfo({
      source: { type: "local", path: path.join(dir, "sub", "f.js") },
      features: {},
      state: activeState,
    });
    expect(matchesMaterializedDir(info, dir)).toBe(true);
  });

  it("does not match a sibling that only shares the prefix", () => {
    const root = newTmpDir("client-");
    const dir = path.join(root, "artifact");
    const info = makeInfo({
      source: { type: "local", path: `${dir}-other` },
      features: {},
      state: activeState,
    });
    expect(matchesMaterializedDir(info, dir)).toBe(false);
  });

  it("matches a symlinked materialized dir via realpath", () => {
    const root = newTmpDir("client-");
    const realDir = path.join(root, "real");
    mkdirSync(realDir);
    const linkDir = path.join(root, "link");
    symlinkSync(realDir, linkDir, "dir");
    const pluginPath = realpathSync(linkDir);
    const info = makeInfo({
      source: { type: "local", path: pluginPath },
      features: {},
      state: activeState,
    });
    expect(matchesMaterializedDir(info, linkDir)).toBe(true);
  });

  it("rejects non-local sources", () => {
    const dir = "/materialized";
    expect(
      matchesMaterializedDir(
        makeInfo({ source: { type: "builtin" }, features: {}, state: activeState }),
        dir,
      ),
    ).toBe(false);
    expect(
      matchesMaterializedDir(
        makeInfo({
          source: { type: "package", target: "npm:p" },
          features: {},
          state: activeState,
        }),
        dir,
      ),
    ).toBe(false);
    expect(
      matchesMaterializedDir(
        makeInfo({ source: { type: "sdk" }, features: {}, state: activeState }),
        dir,
      ),
    ).toBe(false);
  });

  it("rejects an unrelated local path", () => {
    const info = makeInfo({
      source: { type: "local", path: "/elsewhere/p" },
      features: {},
      state: activeState,
    });
    expect(matchesMaterializedDir(info, "/materialized")).toBe(false);
  });
});

describe("findPlugin", () => {
  const root = "/materialized";
  const byId = makeInfo({
    id: "expected-id",
    source: { type: "local", path: "/elsewhere/p" },
    features: {},
    state: activeState,
  });
  const byDir = makeInfo({
    source: { type: "local", path: `${root}/p` },
    features: {},
    state: activeState,
  });
  const builtin = makeInfo({ source: { type: "builtin" }, features: {}, state: activeState });
  const plugins: PluginInfo[] = [builtin, byId, byDir];

  it("finds by expectedPluginId first", () => {
    expect(findPlugin(plugins, root, "expected-id")).toBe(byId);
  });

  it("falls back to the dir match when the id is unknown", () => {
    expect(findPlugin(plugins, root, "missing-id")).toBe(byDir);
  });

  it("finds by dir when expectedPluginId is null", () => {
    expect(findPlugin(plugins, root, null)).toBe(byDir);
  });

  it("ignores builtin plugins for the dir match", () => {
    expect(findPlugin([builtin], root, null)).toBeNull();
    expect(findPlugin([builtin], root, "expected-id")).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(findPlugin([], root, null)).toBeNull();
    expect(findPlugin([byId], root, null)).toBeNull();
  });
});
