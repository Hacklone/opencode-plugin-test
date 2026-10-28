import { realpathSync } from "node:fs";
import { type Diagnostic, diag } from "../domain/diagnostics.js";
import type { PluginFeatures, PluginInfo, PluginSource, PluginState } from "../domain/types.js";
import { type FetchOutcome, fetchJson } from "../util/fetcher.js";

export interface ServerRef {
  baseUrl: string;
  username: string;
  password: string;
}

function parseState(raw: unknown): PluginState | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (r["status"] === "active") {
    return { status: "active" };
  }
  if (r["status"] === "failed" && typeof r["error"] === "string") {
    const state: PluginState = { status: "failed", error: r["error"] };
    if (typeof r["ref"] === "string") {
      return { ...state, ref: r["ref"] };
    }
    return state;
  }
  return null;
}

function parseSource(raw: unknown): PluginSource | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  switch (r["type"]) {
    case "builtin":
      return { type: "builtin" };
    case "sdk":
      return { type: "sdk" };
    case "local":
      return typeof r["path"] === "string" ? { type: "local", path: r["path"] } : null;
    case "package":
      return typeof r["target"] === "string" ? { type: "package", target: r["target"] } : null;
    default:
      return null;
  }
}

function parseFeatures(raw: unknown): PluginFeatures | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const features: PluginFeatures = {};
  if (r["server"] === true) {
    features.server = true;
  }
  if (r["tui"] === true) {
    features.tui = true;
  }
  if (r["rpc"] === true) {
    features.rpc = true;
  }
  return features;
}

/** Structural validation of one Plugin.Info entry; null when the shape is wrong. */
export function parsePluginInfo(raw: unknown): PluginInfo | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const source = parseSource(r["source"]);
  const features = parseFeatures(r["features"]);
  const state = parseState(r["state"]);
  if (source === null || features === null || state === null) {
    return null;
  }
  const info: PluginInfo = { source, features, state };
  if (typeof r["id"] === "string") {
    info.id = r["id"];
  }
  return info;
}

export function parsePluginList(body: unknown): PluginInfo[] {
  if (typeof body !== "object" || body === null) {
    return [];
  }
  const data = (body as Record<string, unknown>)["data"];
  if (!Array.isArray(data)) {
    return [];
  }
  const plugins: PluginInfo[] = [];
  for (const entry of data) {
    const info = parsePluginInfo(entry);
    if (info !== null) {
      plugins.push(info);
    }
  }
  return plugins;
}

export type PluginListResult = { plugins: PluginInfo[] } | { error: Diagnostic };

/** Fetches the plugin list. 401 → API002; network failure → API001 throw. */
export async function fetchPluginList(
  server: ServerRef,
  timeoutMs: number,
): Promise<PluginListResult> {
  let response: FetchOutcome;
  try {
    response = await fetchJson({
      url: `${server.baseUrl}/api/plugin`,
      username: server.username,
      password: server.password,
      timeoutMs,
    });
  } catch (e) {
    return {
      error:
        (e as { diagnostic?: Diagnostic }).diagnostic ??
        diag("API", "001", `request failed: ${(e as Error).message}`),
    };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      error: diag(
        "API",
        "002",
        "OpenCode server rejected the credentials",
        "check OPENCODE_SERVER_PASSWORD handling",
      ),
    };
  }
  if (response.status !== 200) {
    return { error: diag("API", "001", `GET /api/plugin returned HTTP ${response.status}`) };
  }
  return { plugins: parsePluginList(response.body) };
}

export function builtinCount(plugins: readonly PluginInfo[]): number {
  return plugins.filter((p) => p.source.type === "builtin").length;
}

/** True when the plugin entry corresponds to the materialized artifact directory. */
export function matchesMaterializedDir(info: PluginInfo, materializedDir: string): boolean {
  if (info.source.type !== "local") {
    return false;
  }
  const candidates = new Set([materializedDir]);
  try {
    candidates.add(realpathSync(materializedDir));
  } catch {
    // keep raw path only
  }
  const pluginPath = info.source.path;
  for (const candidate of candidates) {
    if (pluginPath === candidate || pluginPath.startsWith(`${candidate}/`)) {
      return true;
    }
  }
  return false;
}

export function findPlugin(
  plugins: readonly PluginInfo[],
  materializedDir: string,
  expectedId: string | null,
): PluginInfo | null {
  if (expectedId !== null) {
    const byId = plugins.find((p) => p.id === expectedId);
    if (byId !== undefined) {
      return byId;
    }
  }
  return plugins.find((p) => matchesMaterializedDir(p, materializedDir)) ?? null;
}
