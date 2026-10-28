/**
 * Domain types shared across the tool. Mirrors of the OpenCode plugin status API
 * shapes live here next to the tool's own result model.
 */

/** Mirrors `Plugin.Info` from the OpenCode plugin status API. */
export interface PluginInfo {
  id?: string;
  source: PluginSource;
  features: PluginFeatures;
  state: PluginState;
}

export type PluginSource =
  | { type: "builtin" }
  | { type: "package"; target: string; version?: string; outdated?: boolean; updating?: boolean }
  | { type: "local"; path: string }
  | { type: "sdk" };

export interface PluginFeatures {
  server?: true;
  tui?: true;
  rpc?: true;
}

export type PluginState = { status: "active" } | { status: "failed"; error: string; ref?: string };

export type RunMode = "packed" | "source";

export type OutcomeStatus = "pass" | "fail" | "warn";

export interface CheckOutcome {
  name: string;
  status: OutcomeStatus;
  diagnostics: Diagnostic[];
}

export interface ScenarioOutcome {
  name: string;
  suite: string;
  status: "pass" | "fail";
  durationMs: number;
  error?: { message: string; stack?: string };
}

export interface ResolvedTarget {
  /** Original spec as given. */
  spec: string;
  kind: "current" | "latest" | "version" | "path";
  binaryPath: string;
  version: string | null;
}

export interface HostSummary {
  baseUrl: string;
  version: string | null;
  pluginId: string | null;
}

export interface TargetOutcome {
  spec: string;
  status: OutcomeStatus;
  version: string | null;
  host: HostSummary | null;
  checks: CheckOutcome[];
  scenarios: ScenarioOutcome[];
  diagnostics: Diagnostic[];
}

export interface RunResult {
  packageRoot: string;
  mode: RunMode;
  startedAt: string;
  durationMs: number;
  packageChecks: CheckOutcome[];
  targets: TargetOutcome[];
  status: OutcomeStatus;
  /** Aggregated diagnostics of the whole run (package + all targets). */
  diagnostics: Diagnostic[];
}

import type { Diagnostic } from "./diagnostics.js";
