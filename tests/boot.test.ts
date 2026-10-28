import { type ChildProcess, spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bootHost,
  type LiveHost,
  locatePlugin,
  stopHost,
  waitForReadiness,
} from "../src/opencode/boot.js";
import type { ServerRef } from "../src/opencode/client.js";
import type { StreamingHandle } from "../src/util/process.js";

// ---------------------------------------------------------------------------
// Fake "opencode" binary. bootHost is exercised by really spawning this
// stand-in script (BootOptions.spawnImpl is forwarded to spawnStreaming and
// covered separately) — never the real opencode.
// ---------------------------------------------------------------------------
const FAKE_SCRIPT = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";

let attempt = 0;
const countFile = process.env["FAKE_COUNT_FILE"];
if (countFile !== undefined) {
  try { attempt = Number.parseInt(readFileSync(countFile, "utf8").trim(), 10) || 0; } catch { attempt = 0; }
  attempt += 1;
  appendFileSync(countFile, String(attempt) + "\\n");
}

const mode = process.env["FAKE_MODE"] ?? "banner";
if (mode === "exit-nonzero") {
  process.stderr.write("fatal: bad configuration\\n");
  process.exit(1);
}
if (mode === "eaddrinuse-always" || (mode === "eaddrinuse-once" && attempt < 2)) {
  process.stderr.write("Error: listen EADDRINUSE: address already in use 127.0.0.1:1\\n");
  process.exit(1);
}
if (mode === "hang") {
  // Prints no banner; stays alive so waitForBanner times out with a live process.
  setInterval(() => {}, 60000);
} else {
  const url = process.env["FAKE_BANNER_URL"] ?? "http://127.0.0.1:" + process.env["FAKE_LISTEN_PORT"];
  process.stdout.write("server listening on " + url + "\\n");
  setInterval(() => {}, 60000);
}
`;

let root: string;
const servers: Server[] = [];

function makeTempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "boot-test-")).then((dir) => {
    root = dir;
    return dir;
  });
}

async function writeFakeBinary(): Promise<string> {
  const binPath = path.join(root, "fake-opencode.mjs");
  await writeFile(binPath, FAKE_SCRIPT);
  await chmod(binPath, 0o755);
  return binPath;
}

interface RecordingServer {
  port: number;
  baseUrl: string;
  authHeaders: string[];
  close(): Promise<void>;
}

type Handler = (req: IncomingMessage, res: ServerResponse, index: number) => void;

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

const EMPTY_LIST = '{"location":{"directory":"/x"},"data":[]}';

const FULL_LIST = JSON.stringify({
  data: [
    { source: { type: "builtin" }, features: {}, state: { status: "active" } },
    {
      id: "plugin-1",
      source: { type: "local", path: "/dir/index.ts" },
      features: { server: true },
      state: { status: "active" },
    },
  ],
});

const FAILED_LIST = JSON.stringify({
  data: [
    { source: { type: "builtin" }, features: {}, state: { status: "active" } },
    {
      id: "plugin-1",
      source: { type: "local", path: "/dir/index.ts" },
      features: { server: true },
      state: { status: "failed", error: "boom", ref: "ref-1" },
    },
  ],
});

const EXPECTED_AUTH = `Basic ${Buffer.from("opencode:pw").toString("base64")}`;

function fakeEnv(
  listenPort: number,
  mode: string,
  countFile?: string,
  bannerUrl?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: path.dirname(process.execPath),
    FAKE_MODE: mode,
    FAKE_LISTEN_PORT: String(listenPort),
  };
  if (countFile !== undefined) {
    env["FAKE_COUNT_FILE"] = countFile;
  }
  if (bannerUrl !== undefined) {
    env["FAKE_BANNER_URL"] = bannerUrl;
  }
  return env;
}

interface BootOptionsInput {
  binaryPath: string;
  env: NodeJS.ProcessEnv;
  maxPortRetries?: number;
  bootTimeoutMs?: number;
}

function bootOpts(input: BootOptionsInput) {
  return {
    binaryPath: input.binaryPath,
    cwd: root,
    env: input.env,
    username: "opencode",
    password: "pw",
    bootTimeoutMs: input.bootTimeoutMs ?? 400,
    ...(input.maxPortRetries !== undefined ? { maxPortRetries: input.maxPortRetries } : {}),
  };
}

const serverRef = (baseUrl: string): ServerRef => ({
  baseUrl,
  username: "opencode",
  password: "pw",
});

beforeEach(async () => {
  await makeTempRoot();
});

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await rm(root, { recursive: true, force: true });
});

describe("bootHost", () => {
  it("parses the listening banner, polls readiness, and boots successfully", async () => {
    const api = await startRecordingServer((_req, res, index) => {
      sendJson(res, 200, index === 0 ? EMPTY_LIST : FULL_LIST);
    });
    const binaryPath = await writeFakeBinary();
    const result = await bootHost(
      bootOpts({ binaryPath, env: fakeEnv(api.port, "banner"), maxPortRetries: 0 }),
    );
    try {
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(`boot failed: ${result.error.code} ${result.error.message}`);
      }
      const { host } = result;
      expect(host.server.baseUrl).toBe(api.baseUrl);
      expect(host.server.username).toBe("opencode");
      expect(host.server.password).toBe("pw");
      expect(host.port).toBeGreaterThan(0);
      expect(host.handle.child.spawnargs.slice(1)).toEqual([
        "serve",
        "--port",
        String(host.port),
        "--hostname",
        "127.0.0.1",
      ]);
      expect(api.authHeaders.length).toBeGreaterThanOrEqual(2);
      for (const auth of api.authHeaders) {
        expect(auth).toBe(EXPECTED_AUTH);
      }
    } finally {
      if (result.ok) {
        await stopHost(result.host);
      }
    }
  });

  it("fails with API002 when the server rejects the credentials", async () => {
    const api = await startRecordingServer((_req, res) => {
      sendJson(res, 401, '{"error":"unauthorized"}');
    });
    const binaryPath = await writeFakeBinary();
    const result = await bootHost(bootOpts({ binaryPath, env: fakeEnv(api.port, "banner") }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("API002");
      expect(result.handle).toBeNull();
    }
  });

  it("fails with HOST002 when the plugin list never becomes non-empty", async () => {
    const api = await startRecordingServer((_req, res) => {
      sendJson(res, 200, EMPTY_LIST);
    });
    const binaryPath = await writeFakeBinary();
    const result = await bootHost(bootOpts({ binaryPath, env: fakeEnv(api.port, "banner") }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("HOST002");
      expect(result.error.message).toContain("readiness");
      expect(result.handle).toBeNull();
    }
  });

  // SRC SEAM GAP (reported, not modified): BootOptions.spawnImpl is declared but
  // never forwarded to spawnStreaming, and spawnStreaming snapshots `spawnError`
  // by value so async spawn 'error' events (e.g. ENOENT) never reach callers.
  // HOST001 is only reachable when spawn throws SYNCHRONOUSLY (captured before
  // the snapshot), e.g. an invalid options.cwd. We exercise exactly that path.
  it("returns HOST001 when spawn throws synchronously", async () => {
    const api = await startRecordingServer((_req, res) => {
      sendJson(res, 200, FULL_LIST);
    });
    const binaryPath = await writeFakeBinary();
    // Invalid cwd forces child_process.spawn to throw synchronously — the only
    // way the sync-throw branch of spawnStreaming (and thus HOST001) is reached.
    const result = await bootHost({
      ...bootOpts({ binaryPath, env: fakeEnv(api.port, "banner") }),
      cwd: 123 as unknown as string,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("HOST001");
      expect(result.error.message).toContain("could not spawn");
      expect(result.handle).toBeNull();
    }
  });

  // An ENOENT binary surfaces as HOST001: handle.spawnError is now a live
  // getter, so the async 'error' event is visible to boot.ts.
  it("maps a nonexistent binary's ENOENT to HOST001", async () => {
    const api = await startRecordingServer((_req, res) => {
      sendJson(res, 200, FULL_LIST);
    });
    const result = await bootHost(
      bootOpts({ binaryPath: path.join(root, "does-not-exist"), env: fakeEnv(api.port, "banner") }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("HOST001");
      expect(result.handle).toBeNull();
    }
  });

  it("returns HOST003 when the process exits nonzero before the banner", async () => {
    const api = await startRecordingServer((_req, res) => {
      sendJson(res, 200, FULL_LIST);
    });
    const binaryPath = await writeFakeBinary();
    const result = await bootHost(bootOpts({ binaryPath, env: fakeEnv(api.port, "exit-nonzero") }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("HOST003");
      expect(result.error.message).toContain("exited");
      expect(result.error.message).toContain("code 1");
      expect(result.handle).toBeNull();
    }
  });

  // Covers the "no banner, no spawn error, process still alive" branch: the
  // exit race resolves null (process is running), so neither the EADDRINUSE
  // retry nor the HOST003 exit-code path applies and HOST002 is returned.
  it("returns HOST002 when no banner appears but the process keeps running", async () => {
    const binaryPath = await writeFakeBinary();
    const result = await bootHost(
      bootOpts({ binaryPath, env: fakeEnv(1, "hang"), bootTimeoutMs: 300 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("HOST002");
      expect(result.error.message).toContain("did not print a listening banner");
      expect(result.handle).toBeNull();
    }
  });

  // The banner URL with a trailing slash is stripped before it becomes the
  // server base URL, and readiness then succeeds against the real API server.
  it("strips a trailing slash from the banner URL and boots successfully", async () => {
    const api = await startRecordingServer((_req, res) => {
      sendJson(res, 200, FULL_LIST);
    });
    const binaryPath = await writeFakeBinary();
    const result = await bootHost(
      bootOpts({ binaryPath, env: fakeEnv(api.port, "banner", undefined, `${api.baseUrl}/`) }),
    );
    try {
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.host.server.baseUrl).toBe(api.baseUrl);
      }
    } finally {
      if (result.ok) {
        await stopHost(result.host);
      }
    }
  });

  it("forwards spawnImpl to spawnStreaming", async () => {
    const api = await startRecordingServer((_req, res) => {
      sendJson(res, 200, FULL_LIST);
    });
    const result = await bootHost({
      ...bootOpts({
        binaryPath: path.join(root, "does-not-exist"),
        env: fakeEnv(api.port, "banner"),
      }),
      spawnImpl: spawn,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("HOST001");
      expect(result.handle).toBeNull();
    }
  });

  // With no loop iterations (maxPortRetries < 0) lastError is never set, so the
  // post-loop fallback diagnostic is used.
  it("returns the post-loop HOST002 fallback when maxPortRetries is negative", async () => {
    const binaryPath = await writeFakeBinary();
    const result = await bootHost(
      bootOpts({ binaryPath, env: fakeEnv(1, "banner"), maxPortRetries: -1 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("HOST002");
      expect(result.error.message).toBe("server boot failed after port retries");
      expect(result.handle).toBeNull();
    }
  });

  it("retries on EADDRINUSE and succeeds on a later attempt", async () => {
    const api = await startRecordingServer((_req, res) => {
      sendJson(res, 200, FULL_LIST);
    });
    const binaryPath = await writeFakeBinary();
    const countFile = path.join(root, "attempts.txt");
    const result = await bootHost(
      bootOpts({
        binaryPath,
        env: fakeEnv(api.port, "eaddrinuse-once", countFile),
        maxPortRetries: 2,
      }),
    );
    try {
      expect(result.ok).toBe(true);
      const attempts = (await readFile(countFile, "utf8"))
        .split("\n")
        .filter((line) => line.length > 0);
      expect(attempts).toEqual(["1", "2"]);
    } finally {
      if (result.ok) {
        await stopHost(result.host);
      }
    }
  });

  it("fails with HOST002 after exhausting port retries on persistent EADDRINUSE", async () => {
    const api = await startRecordingServer((_req, res) => {
      sendJson(res, 200, FULL_LIST);
    });
    const binaryPath = await writeFakeBinary();
    const countFile = path.join(root, "attempts.txt");
    const result = await bootHost(
      bootOpts({
        binaryPath,
        env: fakeEnv(api.port, "eaddrinuse-always", countFile),
        maxPortRetries: 1,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("HOST002");
      expect(result.error.message).toContain("busy");
    }
    const attempts = (await readFile(countFile, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0);
    expect(attempts).toEqual(["1", "2"]);
  });
});

describe("waitForReadiness", () => {
  // API001 (HTTP 500) while booting is expected: the poll continues and the
  // next iteration sees a populated plugin list.
  it("continues polling after a transient API001 error and succeeds", async () => {
    const api = await startRecordingServer((_req, res, index) => {
      if (index === 0) {
        sendJson(res, 500, '{"error":"warming up"}');
        return;
      }
      sendJson(res, 200, FULL_LIST);
    });
    const result = await waitForReadiness(serverRef(api.baseUrl), 5000);
    expect(result.ok).toBe(true);
  });
});

describe("locatePlugin", () => {
  it("finds the plugin after a few polls", async () => {
    const api = await startRecordingServer((_req, res, index) => {
      sendJson(res, 200, index < 2 ? EMPTY_LIST : FULL_LIST);
    });
    const result = await locatePlugin(serverRef(api.baseUrl), "/dir", null, 5000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plugin.source).toEqual({ type: "local", path: "/dir/index.ts" });
      expect(result.plugin.state).toEqual({ status: "active" });
      expect(result.plugin.id).toBe("plugin-1");
    }
  });

  it("matches by expected id when configured", async () => {
    const api = await startRecordingServer((_req, res) => {
      sendJson(res, 200, FULL_LIST);
    });
    const result = await locatePlugin(serverRef(api.baseUrl), "/no/such/dir", "plugin-1", 5000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plugin.id).toBe("plugin-1");
    }
  });

  it("times out with HOST005 when the plugin never appears", async () => {
    const api = await startRecordingServer((_req, res) => {
      sendJson(res, 200, EMPTY_LIST);
    });
    const result = await locatePlugin(serverRef(api.baseUrl), "/dir", null, 100);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("HOST005");
      expect(result.error.message).toContain("/dir");
      expect(result.plugin).toBeNull();
    }
  });

  // API002 (credentials rejected) is fatal during the discovery poll: no retry.
  it("returns API002 immediately when the server rejects the credentials", async () => {
    const api = await startRecordingServer((_req, res) => {
      sendJson(res, 403, '{"error":"forbidden"}');
    });
    const result = await locatePlugin(serverRef(api.baseUrl), "/dir", null, 5000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("API002");
      expect(result.error.message).toContain("rejected the credentials");
      expect(result.plugin).toBeNull();
    }
  });

  // API001 (transient HTTP 500) is retried: the poll continues and the plugin
  // shows up on a later iteration.
  it("continues polling after a transient API001 error", async () => {
    const api = await startRecordingServer((_req, res, index) => {
      if (index === 0) {
        sendJson(res, 500, '{"error":"warming up"}');
        return;
      }
      sendJson(res, 200, FULL_LIST);
    });
    const result = await locatePlugin(serverRef(api.baseUrl), "/dir", null, 5000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plugin.id).toBe("plugin-1");
    }
  });

  it("returns a failed plugin state so the caller can surface HOST006", async () => {
    const api = await startRecordingServer((_req, res) => {
      sendJson(res, 200, FAILED_LIST);
    });
    const result = await locatePlugin(serverRef(api.baseUrl), "/dir", null, 5000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plugin.state.status).toBe("failed");
      if (result.plugin.state.status === "failed") {
        expect(result.plugin.state.error).toBe("boom");
        expect(result.plugin.state.ref).toBe("ref-1");
      }
    }
  });
});

describe("stopHost", () => {
  it("kills the handle", async () => {
    const kill = vi.fn(async () => undefined);
    const handle = {
      child: {} as unknown as ChildProcess,
      stdout: () => "",
      stderr: () => "",
      spawnError: null,
      kill,
      exited: Promise.resolve({ code: null, signal: null }),
    } as unknown as StreamingHandle;
    const host: LiveHost = {
      server: { baseUrl: "http://127.0.0.1:1", username: "u", password: "p" },
      port: 1,
      handle,
    };
    await stopHost(host);
    expect(kill).toHaveBeenCalledOnce();
  });
});
