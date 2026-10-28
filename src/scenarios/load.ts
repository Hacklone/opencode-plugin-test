import path from "node:path";
import { pathToFileURL } from "node:url";
import { type Diagnostic, diag } from "../domain/diagnostics.js";
import type { PluginTestSuite } from "./define.js";

function isSuite(value: unknown): value is PluginTestSuite {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)["name"] === "string" &&
    Array.isArray((value as Record<string, unknown>)["scenarios"])
  );
}

/**
 * Loads scenario suites from a module (TS via type stripping, or JS).
 * Accepts a default export of a suite, an array of suites, or named exports
 * of suites.
 */
export async function loadScenarioSuites(
  spec: string,
  packageRoot: string,
): Promise<{ suites: PluginTestSuite[] } | { error: Diagnostic }> {
  const resolved = path.isAbsolute(spec) ? spec : path.resolve(packageRoot, spec);
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
  } catch (e) {
    return {
      error: diag(
        "SCEN",
        "003",
        `could not load scenario module ${resolved}: ${(e as Error).message}`,
      ),
    };
  }
  const suites: PluginTestSuite[] = [];
  const pushIfSuite = (value: unknown) => {
    if (isSuite(value)) {
      suites.push(value);
    }
  };
  if (mod["default"] !== undefined) {
    if (Array.isArray(mod["default"])) {
      for (const entry of mod["default"]) {
        pushIfSuite(entry);
      }
    } else {
      pushIfSuite(mod["default"]);
    }
  }
  for (const [name, value] of Object.entries(mod)) {
    if (name === "default") {
      continue;
    }
    pushIfSuite(value);
  }
  if (suites.length === 0) {
    return {
      error: diag(
        "SCEN",
        "003",
        `scenario module ${resolved} exported no suites (use definePluginTestSuite)`,
      ),
    };
  }
  return { suites };
}
