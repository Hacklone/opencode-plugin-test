import { type Diagnostic, diag } from "../domain/diagnostics.js";
import type { PluginInfo, ResolvedTarget } from "../domain/types.js";
import { parsePluginInfo, type ServerRef } from "../opencode/client.js";
import type { SandboxPaths } from "../opencode/sandbox.js";
import { apiRequestFailed, type FetchOutcome } from "../util/fetcher.js";

/**
 * A scenario is one behavioral test the plugin author writes; it runs against
 * a live, fully isolated OpenCode host with the real artifact loaded.
 */
export interface Scenario {
  name: string;
  run: (ctx: ScenarioContext) => Promise<void> | void;
}

export interface ScenarioContext {
  suite: string;
  scenario: string;
  target: ResolvedTarget;
  plugin: PluginInfo;
  server: ServerRef;
  paths: SandboxPaths;
  /** Plugin options from the config, as delivered to the host. */
  options: Record<string, unknown>;
  /** Authenticated request helper against the sandbox server. */
  request: (path: string, init?: RequestInit) => Promise<FetchOutcome>;
  /** Re-fetches the plugin's current status (for polling scenarios). */
  pluginStatus: () => Promise<PluginInfo | Diagnostic>;
}

export interface PluginTestSuite {
  name: string;
  scenarios: Scenario[];
}

/**
 * Declares a scenario suite. `scenarios` may be an array of Scenario objects
 * or a record mapping names to run functions.
 */
export function definePluginTestSuite(suite: {
  name: string;
  scenarios: Scenario[] | Record<string, Scenario["run"]>;
}): PluginTestSuite {
  const scenarios = Array.isArray(suite.scenarios)
    ? [...suite.scenarios]
    : Object.entries(suite.scenarios).map(([name, run]) => ({ name, run }));
  return { name: suite.name, scenarios };
}

/** Authenticated request helper bound to the sandbox server. */
export async function makeRequest(
  server: ServerRef,
  requestPath: string,
  init?: RequestInit,
): Promise<FetchOutcome> {
  const url = `${server.baseUrl}${requestPath.startsWith("/") ? requestPath : `/${requestPath}`}`;
  const headers = new Headers(init?.headers);
  headers.set(
    "Authorization",
    `Basic ${Buffer.from(`${server.username}:${server.password}`).toString("base64")}`,
  );
  try {
    const response = await fetch(url, { ...init, headers });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: response.status, body, text };
  } catch (e) {
    throw apiRequestFailed(url, e as Error);
  }
}

export function makePluginStatusFn(server: ServerRef): () => Promise<PluginInfo | Diagnostic> {
  return async () => {
    try {
      const outcome = await makeRequest(server, "/api/plugin");
      if (outcome.status !== 200 || typeof outcome.body !== "object" || outcome.body === null) {
        return diag("API", "001", `GET /api/plugin returned HTTP ${outcome.status}`);
      }
      const data = (outcome.body as Record<string, unknown>)["data"];
      if (!Array.isArray(data)) {
        return diag("API", "001", "GET /api/plugin returned no data array");
      }
      // Find any non-builtin plugin (the one under test is the only non-builtin in a sandbox).
      for (const entry of data) {
        const parsed = parsePluginInfo(entry);
        if (parsed !== null && parsed.source.type !== "builtin") {
          return parsed;
        }
      }
      return diag("HOST", "005", "plugin no longer present on the host");
    } catch (e) {
      return (
        (e as { diagnostic?: Diagnostic }).diagnostic ?? diag("API", "001", (e as Error).message)
      );
    }
  };
}
