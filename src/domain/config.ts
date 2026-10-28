import { readFile } from "node:fs/promises";
import path from "node:path";
import { type Diagnostic, diag } from "./diagnostics.js";
import type { RunMode } from "./types.js";

function CFG001(message: string): Diagnostic {
  return diag("CFG", "001", message);
}

export interface TestConfig {
  /** OpenCode targets to test against, in order. */
  targets: string[];
  mode: RunMode;
  /** Feature surfaces the plugin must expose, e.g. ["server"]. */
  surfaces: Array<"server" | "tui" | "rpc">;
  /** Path (relative to package root) of the module defining scenario suites, or null. */
  scenarios: string | null;
  /** Filter of scenario names to run (empty = all). */
  scenarioFilter: string[];
  bootTimeoutMs: number;
  scenarioTimeoutMs: number;
  packTimeoutMs: number;
  installTimeoutMs: number;
  reporter: "pretty" | "json" | "junit";
  keepSandbox: boolean;
  /** Plugin options handed to the host via the {package, options} config entry. */
  options: Record<string, unknown>;
  /** If set, the host plugin is matched by this id instead of by artifact path. */
  expectedPluginId: string | null;
}

export const DEFAULT_CONFIG: Readonly<TestConfig> = {
  targets: ["current"],
  mode: "packed",
  surfaces: ["server"],
  scenarios: null,
  scenarioFilter: [],
  bootTimeoutMs: 60_000,
  scenarioTimeoutMs: 30_000,
  packTimeoutMs: 120_000,
  installTimeoutMs: 300_000,
  reporter: "pretty",
  keepSandbox: false,
  options: {},
  expectedPluginId: null,
};

export const CONFIG_FILE_NAME = "plugin-test.config.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectPositiveNumber(key: string, value: unknown, errors: string[]): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    errors.push(`"${key}" must be a positive number`);
    return undefined;
  }
  return value;
}

function expectStringArray(key: string, value: unknown, errors: string[]): string[] | undefined {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    errors.push(`"${key}" must be an array of strings`);
    return undefined;
  }
  return value as string[];
}

const SURFACES = new Set(["server", "tui", "rpc"]);
const REPORTERS = new Set(["pretty", "json", "junit"]);
const MODES = new Set(["packed", "source"]);

/**
 * Validates a user-supplied partial config against the schema. Returns the
 * fully merged config or a CFG001 diagnostic describing every problem found.
 */
export function validateConfig(raw: unknown): { config: TestConfig } | { error: Diagnostic } {
  const errors: string[] = [];
  if (!isRecord(raw)) {
    return { error: CFG001("configuration root must be a JSON object") };
  }
  const merged: TestConfig = { ...DEFAULT_CONFIG };

  if (raw["targets"] !== undefined) {
    const v = expectStringArray("targets", raw["targets"], errors);
    if (v !== undefined) {
      if (v.length === 0) {
        errors.push('"targets" must not be empty');
      } else {
        merged.targets = [...v];
      }
    }
  }
  if (raw["mode"] !== undefined) {
    if (typeof raw["mode"] !== "string" || !MODES.has(raw["mode"])) {
      errors.push('"mode" must be "packed" or "source"');
    } else {
      merged.mode = raw["mode"] as RunMode;
    }
  }
  if (raw["surfaces"] !== undefined) {
    const v = expectStringArray("surfaces", raw["surfaces"], errors);
    if (v !== undefined) {
      const bad = v.filter((s) => !SURFACES.has(s));
      if (bad.length > 0) {
        errors.push(`"surfaces" contains unknown surface(s): ${bad.join(", ")}`);
      } else {
        merged.surfaces = [...v] as TestConfig["surfaces"];
      }
    }
  }
  if (raw["scenarios"] !== undefined) {
    if (raw["scenarios"] !== null && typeof raw["scenarios"] !== "string") {
      errors.push('"scenarios" must be a string path or null');
    } else {
      merged.scenarios = raw["scenarios"];
    }
  }
  if (raw["scenarioFilter"] !== undefined) {
    const v = expectStringArray("scenarioFilter", raw["scenarioFilter"], errors);
    if (v !== undefined) {
      merged.scenarioFilter = [...v];
    }
  }
  for (const key of [
    "bootTimeoutMs",
    "scenarioTimeoutMs",
    "packTimeoutMs",
    "installTimeoutMs",
  ] as const) {
    if (raw[key] !== undefined) {
      const v = expectPositiveNumber(key, raw[key], errors);
      if (v !== undefined) {
        merged[key] = v;
      }
    }
  }
  if (raw["reporter"] !== undefined) {
    if (typeof raw["reporter"] !== "string" || !REPORTERS.has(raw["reporter"])) {
      errors.push('"reporter" must be "pretty", "json" or "junit"');
    } else {
      merged.reporter = raw["reporter"] as TestConfig["reporter"];
    }
  }
  if (raw["keepSandbox"] !== undefined) {
    if (typeof raw["keepSandbox"] !== "boolean") {
      errors.push('"keepSandbox" must be a boolean');
    } else {
      merged.keepSandbox = raw["keepSandbox"];
    }
  }
  if (raw["options"] !== undefined) {
    if (!isRecord(raw["options"])) {
      errors.push('"options" must be an object');
    } else {
      merged.options = { ...raw["options"] };
    }
  }
  if (raw["expectedPluginId"] !== undefined) {
    if (raw["expectedPluginId"] !== null && typeof raw["expectedPluginId"] !== "string") {
      errors.push('"expectedPluginId" must be a string or null');
    } else {
      merged.expectedPluginId = raw["expectedPluginId"];
    }
  }

  const unknownKeys = Object.keys(raw).filter((k) => !(k in DEFAULT_CONFIG));
  if (unknownKeys.length > 0) {
    errors.push(`unknown key(s): ${unknownKeys.join(", ")}`);
  }

  if (errors.length > 0) {
    return { error: CFG001(`invalid configuration: ${errors.join("; ")}`) };
  }
  return { config: merged };
}

/** Reads and validates the config file at the given path. */
export async function readConfigFile(
  configPath: string,
): Promise<{ config: TestConfig } | { error: Diagnostic }> {
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch {
    return { error: diag("CFG", "002", `configuration file not readable: ${configPath}`) };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return {
      error: CFG001(`configuration file ${configPath} is not valid JSON: ${(e as Error).message}`),
    };
  }
  const result = validateConfig(raw);
  if ("error" in result) {
    return {
      error: CFG001(`${result.error.message} (in ${configPath})`),
    };
  }
  return result;
}

/** Default config path for a package root. */
export function defaultConfigPath(packageRoot: string): string {
  return path.join(packageRoot, CONFIG_FILE_NAME);
}

/** CLI layer over the file config: flags win. */
export interface CliOverrides {
  targets?: string[] | undefined;
  mode?: RunMode | undefined;
  reporter?: TestConfig["reporter"] | undefined;
  scenarioFilter?: string[] | undefined;
  bootTimeoutMs?: number | undefined;
  scenarioTimeoutMs?: number | undefined;
  keepSandbox?: boolean | undefined;
}

export function applyCliOverrides(base: TestConfig, overrides?: CliOverrides): TestConfig {
  const merged: TestConfig = { ...base };
  if (overrides === undefined) return merged;
  if (overrides.targets !== undefined) {
    merged.targets = [...overrides.targets];
  }
  if (overrides.mode !== undefined) {
    merged.mode = overrides.mode;
  }
  if (overrides.reporter !== undefined) {
    merged.reporter = overrides.reporter;
  }
  if (overrides.scenarioFilter !== undefined) {
    merged.scenarioFilter = [...overrides.scenarioFilter];
  }
  if (overrides.bootTimeoutMs !== undefined) {
    merged.bootTimeoutMs = overrides.bootTimeoutMs;
  }
  if (overrides.scenarioTimeoutMs !== undefined) {
    merged.scenarioTimeoutMs = overrides.scenarioTimeoutMs;
  }
  if (overrides.keepSandbox !== undefined) {
    merged.keepSandbox = overrides.keepSandbox;
  }
  return merged;
}
