import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerRef } from "../src/opencode/client.js";
import type { PluginTestSuite, Scenario, ScenarioContext } from "../src/scenarios/define.js";
import { definePluginTestSuite, makePluginStatusFn, makeRequest } from "../src/scenarios/define.js";
import { loadScenarioSuites } from "../src/scenarios/load.js";
import { runScenario, scenarioDiagnostic } from "../src/scenarios/run.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
const servers: Server[] = [];

function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "scenarios-test-")).then((dir) => {
    tempDirs.push(dir);
    return dir;
  });
}

async function writeModule(name: string, code: string): Promise<string> {
  const dir = await makeTempDir();
  const filePath = path.join(dir, name);
  await writeFile(filePath, code);
  return filePath;
}

type Handler = (req: IncomingMessage, res: ServerResponse, index: number) => void;

interface RecordingServer {
  port: number;
  baseUrl: string;
  authHeaders: string[];
  close(): Promise<void>;
}

async function startRecordingServer(handler: Handler): Promise<RecordingServer> {
  let index = 0;
  const authHeaders: string[] = [];
  const server = createServer((req, res) => {
    const auth = req.headers["authorization"];
    if (typeof auth === "string") {
      authHeaders.push(auth);
    }
    handler(req, res, index);
    index += 1;
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    authHeaders,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function sendJson(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

const PLUGIN_LIST = JSON.stringify({
  data: [
    { source: { type: "builtin" }, features: {}, state: { status: "active" } },
    {
      id: "my-plugin",
      source: { type: "local", path: "/plugins/target/index.ts" },
      features: { server: true },
      state: { status: "active" },
    },
  ],
});

const ONLY_BUILTINS = JSON.stringify({
  data: [{ source: { type: "builtin" }, features: {}, state: { status: "active" } }],
});

const serverRef = (baseUrl: string): ServerRef => ({
  baseUrl,
  username: "opencode",
  password: "pw",
});

const EXPECTED_AUTH = `Basic ${Buffer.from("opencode:pw").toString("base64")}`;

function makeCtx(overrides?: Partial<ScenarioContext>): ScenarioContext {
  const ctx: ScenarioContext = {
    suite: "my-suite",
    scenario: "my-scenario",
    target: { spec: "current", kind: "current", binaryPath: "/bin/oc", version: null },
    plugin: { source: { type: "builtin" }, features: {}, state: { status: "active" } },
    server: { baseUrl: "http://127.0.0.1:1", username: "opencode", password: "pw" },
    paths: {
      root: "/r",
      project: "/r/project",
      home: "/r/home",
      xdgConfig: "/r/config",
      xdgCache: "/r/cache",
      xdgData: "/r/data",
      xdgState: "/r/state",
      work: "/r/work",
    },
    options: {},
    request: async () => ({ status: 200, body: null, text: "" }),
    pluginStatus: async () => ({
      source: { type: "builtin" },
      features: {},
      state: { status: "active" },
    }),
  };
  return { ...ctx, ...overrides };
}

/** setTimeout replacement that fires the callback immediately (via microtask). */
function immediateSetTimeout(): typeof setTimeout {
  const impl = (callback: () => void): NodeJS.Timeout => {
    queueMicrotask(() => {
      (callback as () => void)();
    });
    return 0 as unknown as NodeJS.Timeout;
  };
  return impl as unknown as typeof setTimeout;
}

beforeEach(() => {
  // sanity: fresh arrays each test
  tempDirs.length = 0;
});

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------
// definePluginTestSuite
// ---------------------------------------------------------------------------

describe("definePluginTestSuite", () => {
  it("preserves the array form of scenarios", () => {
    const runA = async (): Promise<void> => {};
    const scenario: Scenario = { name: "a", run: runA };
    const suite = definePluginTestSuite({ name: "array-suite", scenarios: [scenario] });
    expect(suite.name).toBe("array-suite");
    expect(suite.scenarios).toHaveLength(1);
    expect(suite.scenarios[0]?.name).toBe("a");
    expect(suite.scenarios[0]?.run).toBe(runA);
  });

  it("converts the Record form into named scenarios", () => {
    const runA = async (): Promise<void> => {};
    const runB = async (): Promise<void> => {};
    const suite = definePluginTestSuite({ name: "record-suite", scenarios: { a: runA, b: runB } });
    expect(suite.name).toBe("record-suite");
    expect(suite.scenarios).toEqual([
      { name: "a", run: runA },
      { name: "b", run: runB },
    ]);
  });

  it("produces a structurally valid PluginTestSuite usable by loadScenarioSuites round-trips", () => {
    const suite: PluginTestSuite = definePluginTestSuite({
      name: "s",
      scenarios: { only: () => {} },
    });
    expect(suite.scenarios.map((s) => s.name)).toEqual(["only"]);
  });
});

// ---------------------------------------------------------------------------
// runScenario
// ---------------------------------------------------------------------------

describe("runScenario", () => {
  it("returns a pass outcome with duration measured via deps.now", async () => {
    let ticks = 100;
    const now = vi.fn(() => {
      ticks += 10;
      return ticks;
    });
    const suite = definePluginTestSuite({ name: "my-suite", scenarios: [] });
    const scenario: Scenario = { name: "happy", run: () => {} };
    const outcome = await runScenario(suite, scenario, makeCtx(), 1000, { now });
    expect(now).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({
      name: "happy",
      suite: "my-suite",
      status: "pass",
      durationMs: 10,
    });
    expect(scenarioDiagnostic(outcome)).toBeNull();
  });

  it("maps a thrown error to a fail outcome with message and stack", async () => {
    const suite = definePluginTestSuite({ name: "my-suite", scenarios: [] });
    const scenario: Scenario = {
      name: "explodes",
      run: () => {
        throw new Error("boom");
      },
    };
    const outcome = await runScenario(suite, scenario, makeCtx(), 1000, {});
    expect(outcome.status).toBe("fail");
    expect(outcome.name).toBe("explodes");
    expect(outcome.suite).toBe("my-suite");
    expect(outcome.error?.message).toBe("boom");
    expect(outcome.error?.stack).toContain("Error: boom");
    const diag = scenarioDiagnostic(outcome);
    expect(diag?.code).toBe("SCEN001");
    expect(diag?.family).toBe("SCEN");
  });

  it("maps an injected immediate timeout to a timeout outcome (SCEN002-ish)", async () => {
    const suite = definePluginTestSuite({ name: "my-suite", scenarios: [] });
    const scenario: Scenario = {
      name: "hangs",
      run: () => new Promise<void>(() => {}),
    };
    const outcome = await runScenario(suite, scenario, makeCtx(), 25, {
      setTimeoutImpl: immediateSetTimeout(),
    });
    expect(outcome.status).toBe("fail");
    expect(outcome.error?.message).toContain("scenario timed out after 25ms");
    const diag = scenarioDiagnostic(outcome);
    expect(diag?.code).toBe("SCEN001");
    expect(diag?.message).toContain("scenario timed out after 25ms");
  });

  it("maps an asynchronously rejected scenario promise to a fail outcome", async () => {
    const suite = definePluginTestSuite({ name: "my-suite", scenarios: [] });
    const scenario: Scenario = {
      name: "async-explodes",
      run: () => Promise.reject(new Error("async boom")),
    };
    const outcome = await runScenario(suite, scenario, makeCtx(), 1000, {});
    expect(outcome.status).toBe("fail");
    expect(outcome.name).toBe("async-explodes");
    expect(outcome.error?.message).toBe("async boom");
    expect(outcome.error?.stack).toContain("Error: async boom");
    expect(scenarioDiagnostic(outcome)?.code).toBe("SCEN001");
  });

  it("omits the stack when the thrown error has no stack", async () => {
    const suite = definePluginTestSuite({ name: "my-suite", scenarios: [] });
    const scenario: Scenario = {
      name: "stackless",
      run: () => {
        const error = new Error("no trace");
        delete error.stack;
        throw error;
      },
    };
    const outcome = await runScenario(suite, scenario, makeCtx(), 1000, {});
    expect(outcome.status).toBe("fail");
    expect(outcome.error).toEqual({ message: "no trace" });
  });

  it("falls back to a generic message when a fail outcome carries no error", () => {
    const diag = scenarioDiagnostic({ status: "fail" });
    expect(diag).toMatchObject({ code: "SCEN001", message: "scenario failed" });
  });

  it("lets a scenario use the ctx.request helper against a live server", async () => {
    const api = await startRecordingServer((_req, res) => {
      sendJson(res, 200, '{"ok":true}');
    });
    const suite = definePluginTestSuite({ name: "my-suite", scenarios: [] });
    const scenario: Scenario = {
      name: "uses-request",
      run: async (ctx) => {
        const outcome = await ctx.request("/api/whatever");
        if (outcome.status !== 200) {
          throw new Error(`expected 200, got ${String(outcome.status)}`);
        }
      },
    };
    const outcome = await runScenario(
      suite,
      scenario,
      makeCtx({ server: serverRef(api.baseUrl) }),
      1000,
      {},
    );
    expect(outcome.status).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// makeRequest / makePluginStatusFn
// ---------------------------------------------------------------------------

describe("makeRequest", () => {
  it("sends a Basic auth header and parses the JSON body", async () => {
    const api = await startRecordingServer((_req, res) => {
      sendJson(res, 200, '{"ok":true,"items":[1,2]}');
    });
    const outcome = await makeRequest(serverRef(api.baseUrl), "/api/plugin");
    expect(api.authHeaders).toEqual([EXPECTED_AUTH]);
    expect(outcome.status).toBe(200);
    expect(outcome.body).toEqual({ ok: true, items: [1, 2] });
    expect(outcome.text).toBe('{"ok":true,"items":[1,2]}');
  });

  it("prepends a slash to bare paths", async () => {
    let seenPath = "";
    const api = await startRecordingServer((req, res) => {
      seenPath = req.url ?? "";
      sendJson(res, 200, "{}");
    });
    await makeRequest(serverRef(api.baseUrl), "api/plugin");
    expect(seenPath).toBe("/api/plugin");
  });

  it("preserves extra init headers and passes them through", async () => {
    let seenContentType = "";
    const api = await startRecordingServer((req, res) => {
      seenContentType = req.headers["content-type"] ?? "";
      sendJson(res, 200, "{}");
    });
    await makeRequest(serverRef(api.baseUrl), "/api/plugin", {
      headers: { "content-type": "application/json" },
    });
    expect(seenContentType).toBe("application/json");
    expect(api.authHeaders).toEqual([EXPECTED_AUTH]);
  });

  it("keeps null body for non-JSON text", async () => {
    const api = await startRecordingServer((_req, res) => {
      sendJson(res, 200, "<html>nope</html>");
    });
    const outcome = await makeRequest(serverRef(api.baseUrl), "/x");
    expect(outcome.status).toBe(200);
    expect(outcome.body).toBeNull();
    expect(outcome.text).toBe("<html>nope</html>");
  });

  it("keeps null body for an empty response", async () => {
    const api = await startRecordingServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const outcome = await makeRequest(serverRef(api.baseUrl), "/x");
    expect(outcome.status).toBe(204);
    expect(outcome.body).toBeNull();
    expect(outcome.text).toBe("");
  });

  it("throws an API001 diagnostic on network failure", async () => {
    const api = await startRecordingServer((_req, res) => {
      sendJson(res, 200, "{}");
    });
    const port = api.port;
    await api.close();
    let thrown: unknown;
    try {
      await makeRequest(serverRef(`http://127.0.0.1:${port}`), "/api/plugin");
    } catch (e) {
      thrown = e;
    }
    expect((thrown as { code?: string }).code).toBe("API001");
    expect((thrown as { message?: string }).message).toContain("failed");
  });
});

describe("makePluginStatusFn", () => {
  it("returns the first non-builtin plugin with authentication", async () => {
    const api = await startRecordingServer((_req, res) => {
      sendJson(res, 200, PLUGIN_LIST);
    });
    const status = await makePluginStatusFn(serverRef(api.baseUrl))();
    expect(api.authHeaders).toEqual([EXPECTED_AUTH]);
    expect(status).not.toBeNull();
    const info = status as {
      source: { type: string };
      id?: string;
      state: { status: string };
    } | null;
    expect(info?.source.type).toBe("local");
    expect(info?.id).toBe("my-plugin");
    expect(info?.state.status).toBe("active");
  });

  it("returns HOST005 when only builtins are present", async () => {
    const api = await startRecordingServer((_req, res) => {
      sendJson(res, 200, ONLY_BUILTINS);
    });
    const status = await makePluginStatusFn(serverRef(api.baseUrl))();
    expect(status).toMatchObject({ code: "HOST005", family: "HOST" });
  });

  it("returns API001 on a non-200 status", async () => {
    const api = await startRecordingServer((_req, res) => {
      sendJson(res, 500, '{"error":"boom"}');
    });
    const status = await makePluginStatusFn(serverRef(api.baseUrl))();
    expect(status).toMatchObject({ code: "API001", family: "API" });
    expect((status as { message: string }).message).toContain("HTTP 500");
  });

  it("returns API001 when the data field is not an array", async () => {
    const api = await startRecordingServer((_req, res) => {
      sendJson(res, 200, '{"data":"nope"}');
    });
    const status = await makePluginStatusFn(serverRef(api.baseUrl))();
    expect(status).toMatchObject({ code: "API001" });
  });

  it("returns API001 when the underlying fetch rejects", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    try {
      const status = await makePluginStatusFn(serverRef("http://127.0.0.1:9"))();
      expect(status).toMatchObject({ code: "API001", family: "API" });
      expect((status as { message: string }).message).toContain("network down");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// loadScenarioSuites
// ---------------------------------------------------------------------------

describe("loadScenarioSuites", () => {
  it("loads a default-exported suite from an .mjs module", async () => {
    const filePath = await writeModule(
      "suite.mjs",
      `export default {
  name: "default-suite",
  scenarios: [{ name: "works", run: () => {} }],
};
`,
    );
    const result = await loadScenarioSuites(filePath, "/nowhere");
    expect("suites" in result).toBe(true);
    if ("suites" in result) {
      expect(result.suites).toHaveLength(1);
      expect(result.suites[0]?.name).toBe("default-suite");
      expect(result.suites[0]?.scenarios[0]?.name).toBe("works");
    }
  });

  it("loads an array default export of suites", async () => {
    const filePath = await writeModule(
      "array.mjs",
      `export default [
  { name: "first", scenarios: [] },
  { name: "second", scenarios: [{ name: "x", run: () => {} }] },
];
`,
    );
    const result = await loadScenarioSuites(filePath, "/nowhere");
    expect("suites" in result).toBe(true);
    if ("suites" in result) {
      expect(result.suites.map((s) => s.name)).toEqual(["first", "second"]);
    }
  });

  it("loads named-export suites in addition to a default", async () => {
    const filePath = await writeModule(
      "named.mjs",
      `export const one = { name: "one", scenarios: [] };
export const two = { name: "two", scenarios: [{ name: "y", run: () => {} }] };
export const notASuite = { name: 42, scenarios: "nope" };
`,
    );
    const result = await loadScenarioSuites(filePath, "/nowhere");
    expect("suites" in result).toBe(true);
    if ("suites" in result) {
      expect(result.suites.map((s) => s.name)).toEqual(["one", "two"]);
    }
  });

  it("resolves a relative spec against packageRoot", async () => {
    const filePath = await writeModule(
      "rel.mjs",
      `export default { name: "relative", scenarios: [] };
`,
    );
    const dir = path.dirname(filePath);
    const result = await loadScenarioSuites("rel.mjs", dir);
    expect("suites" in result).toBe(true);
    if ("suites" in result) {
      expect(result.suites[0]?.name).toBe("relative");
    }
  });

  it("returns SCEN003 when the module exports no suites", async () => {
    const filePath = await writeModule(
      "empty.mjs",
      `export default { foo: 1 };
export const alsoNotASuite = 3;
`,
    );
    const result = await loadScenarioSuites(filePath, "/nowhere");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.code).toBe("SCEN003");
      expect(result.error.message).toContain("exported no suites");
    }
  });

  it("returns SCEN003 when the module is broken", async () => {
    const filePath = await writeModule(
      "broken.mjs",
      `throw new Error("module exploded");
`,
    );
    const result = await loadScenarioSuites(filePath, "/nowhere");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.code).toBe("SCEN003");
      expect(result.error.message).toContain("could not load scenario module");
      expect(result.error.message).toContain("module exploded");
    }
  });

  it("returns SCEN003 for a missing module", async () => {
    const dir = await makeTempDir();
    const result = await loadScenarioSuites(path.join(dir, "ghost.mjs"), "/nowhere");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.code).toBe("SCEN003");
    }
  });

  it("reads back a suite written by definePluginTestSuite semantics", async () => {
    // Round-trip: a suite authored the way plugin authors would, persisted to disk.
    const filePath = await writeModule(
      "roundtrip.mjs",
      `export default {
  name: "authored",
  scenarios: [
    { name: "first", run: () => {} },
    { name: "second", run: () => {} },
  ],
};
`,
    );
    const result = await loadScenarioSuites(filePath, "/nowhere");
    if ("suites" in result) {
      const suite = result.suites[0];
      expect(suite?.name).toBe("authored");
      expect(suite?.scenarios.map((s) => s.name)).toEqual(["first", "second"]);
    } else {
      expect.unreachable();
    }
  });
});

describe("readback sanity", () => {
  it("module files exist after load (cleanup happens in afterEach)", async () => {
    const filePath = await writeModule(
      "exists.mjs",
      `export default { name: "n", scenarios: [] };\n`,
    );
    const content = await readFile(filePath, "utf8");
    expect(content).toContain("export default");
  });
});
