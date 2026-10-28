import type { spawn } from "node:child_process";
import { type Diagnostic, diag } from "../domain/diagnostics.js";
import type { PluginInfo } from "../domain/types.js";
import { allocatePort } from "../util/ports.js";
import { findListeningUrl, type StreamingHandle, spawnStreaming } from "../util/process.js";
import { builtinCount, fetchPluginList, findPlugin, type ServerRef } from "./client.js";

export interface LiveHost {
  server: ServerRef;
  port: number;
  handle: StreamingHandle;
}

export type BootResult =
  | { ok: true; host: LiveHost }
  | { ok: false; error: Diagnostic; handle: StreamingHandle | null };

export interface BootOptions {
  binaryPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  username: string;
  password: string;
  bootTimeoutMs: number;
  maxPortRetries?: number;
  spawnImpl?: typeof spawn;
}

const BOOT_POLL_INTERVAL_MS = 250;

/**
 * Boots `opencode serve` inside the sandbox and waits for readiness.
 * Readiness = `GET /api/plugin` returns 200 with a non-empty list (builtins
 * loaded means boot settled). There is no JSON health endpoint on v2, so the
 * plugin list IS the readiness probe.
 */
export async function bootHost(opts: BootOptions): Promise<BootResult> {
  const maxRetries = opts.maxPortRetries ?? 3;
  let handle: StreamingHandle | null = null;
  let lastError: Diagnostic | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const port = await allocatePort();
    handle = spawnStreaming(
      {
        cmd: opts.binaryPath,
        args: ["serve", "--port", String(port), "--hostname", "127.0.0.1"],
        cwd: opts.cwd,
        env: opts.env,
      },
      opts.spawnImpl === undefined ? {} : { spawnImpl: opts.spawnImpl },
    );

    const url = await waitForBanner(handle, opts.bootTimeoutMs);
    if (url === null) {
      const stderr = handle.stderr();
      const exited = await Promise.race([
        handle.exited,
        new Promise<null>((r) => setTimeout(() => r(null), 50)),
      ]);
      await handle.kill();
      const spawnError = handle.spawnError;
      if (spawnError !== null) {
        return {
          ok: false,
          error: diag("HOST", "001", `could not spawn ${opts.binaryPath}: ${spawnError}`),
          handle: null,
        };
      }
      if (exited !== null && isAddressInUse(stderr)) {
        lastError = diag("HOST", "002", `port ${port} busy; retrying`);
        continue;
      }
      if (exited !== null && exited.code !== null && exited.code !== 0) {
        return {
          ok: false,
          error: diag(
            "HOST",
            "003",
            `OpenCode server exited before becoming ready (code ${String(exited.code)})`,
            tail(stderr, 5),
          ),
          handle: null,
        };
      }
      return {
        ok: false,
        error: diag(
          "HOST",
          "002",
          "OpenCode server did not print a listening banner in time",
          tail(stderr, 5),
        ),
        handle: null,
      };
    }

    const server: ServerRef = {
      baseUrl: stripTrailingSlash(url),
      username: opts.username,
      password: opts.password,
    };
    const ready = await waitForReadiness(server, opts.bootTimeoutMs);
    if (!ready.ok) {
      await handle.kill();
      return { ok: false, error: ready.error, handle: null };
    }
    return {
      ok: true,
      host: { server, port, handle },
    };
  }
  return {
    ok: false,
    error: lastError ?? diag("HOST", "002", "server boot failed after port retries"),
    handle: null,
  };
}

function isAddressInUse(stderr: string): boolean {
  return /eaddrinuse|address already in use/i.test(stderr);
}

function tail(text: string, lines: number): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

async function waitForBanner(handle: StreamingHandle, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = findListeningUrl(handle.stdout());
    if (url !== null) {
      return url;
    }
    await sleep(BOOT_POLL_INTERVAL_MS);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ReadinessResult = { ok: true } | { ok: false; error: Diagnostic };

/** Polls GET /api/plugin until the list is non-empty (builtins present). */
export async function waitForReadiness(
  server: ServerRef,
  timeoutMs: number,
): Promise<ReadinessResult> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fetchPluginList(server, 5_000);
    if ("error" in result) {
      if (result.error.code === "API002") {
        return { ok: false, error: result.error };
      }
      // API001 while booting is expected (connection refused before listen)
    } else if (result.plugins.length > 0 && builtinCount(result.plugins) > 0) {
      return { ok: true };
    }
    await sleep(BOOT_POLL_INTERVAL_MS);
  }
  return {
    ok: false,
    error: diag("HOST", "002", "host readiness timed out: plugin list never became non-empty"),
  };
}

export type LocateResult =
  | { ok: true; plugin: PluginInfo }
  | { ok: false; error: Diagnostic; plugin: PluginInfo | null };

/**
 * Polls the plugin list until the plugin under test appears (matched by id if
 * configured, otherwise by artifact path). Returns even a failed plugin so the
 * caller can surface HOST006.
 */
export async function locatePlugin(
  server: ServerRef,
  materializedDir: string,
  expectedId: string | null,
  timeoutMs: number,
): Promise<LocateResult> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fetchPluginList(server, 5_000);
    if ("error" in result) {
      if (result.error.code === "API002") {
        return { ok: false, error: result.error, plugin: null };
      }
    } else {
      const plugin = findPlugin(result.plugins, materializedDir, expectedId);
      if (plugin !== null) {
        return { ok: true, plugin };
      }
    }
    await sleep(BOOT_POLL_INTERVAL_MS);
  }
  return {
    ok: false,
    error: diag(
      "HOST",
      "005",
      `plugin was not discovered on the host (looked for ${expectedId ?? materializedDir})`,
    ),
    plugin: null,
  };
}

export async function stopHost(host: LiveHost): Promise<void> {
  await host.handle.kill();
}
