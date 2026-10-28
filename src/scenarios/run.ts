import { type Diagnostic, diag } from "../domain/diagnostics.js";
import type { ScenarioOutcome } from "../domain/types.js";
import type { PluginTestSuite, Scenario, ScenarioContext } from "./define.js";

export interface ScenarioRunnerDeps {
  now?: () => number;
  setTimeoutImpl?: typeof setTimeout;
}

/** Runs one scenario with a timeout. Errors map to SCEN001; timeout to SCEN002. */
export async function runScenario(
  suite: PluginTestSuite,
  scenario: Scenario,
  ctx: ScenarioContext,
  timeoutMs: number,
  deps: ScenarioRunnerDeps = {},
): Promise<ScenarioOutcome> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  try {
    await withTimeout(scenario.run(ctx), timeoutMs, deps);
    return {
      name: scenario.name,
      suite: suite.name,
      status: "pass",
      durationMs: now() - startedAt,
    };
  } catch (e) {
    if (e instanceof ScenarioTimeoutError) {
      return {
        name: scenario.name,
        suite: suite.name,
        status: "fail",
        durationMs: now() - startedAt,
        error: withStack(`scenario timed out after ${timeoutMs}ms`, e.stack),
      };
    }
    return {
      name: scenario.name,
      suite: suite.name,
      status: "fail",
      durationMs: now() - startedAt,
      error: withStack((e as Error).message, (e as Error).stack),
    };
  }
}

export class ScenarioTimeoutError extends Error {
  constructor(ms: number) {
    super(`scenario exceeded ${ms}ms`);
  }
}

function withStack(
  message: string,
  stack: string | undefined,
): { message: string; stack?: string } {
  if (stack === undefined) {
    return { message };
  }
  return { message, stack };
}

function withTimeout(
  promise: Promise<void> | void,
  timeoutMs: number,
  deps: ScenarioRunnerDeps,
): Promise<void> {
  const setTimeoutImpl = deps.setTimeoutImpl ?? setTimeout;
  return new Promise((resolve, reject) => {
    const timer = setTimeoutImpl(() => {
      reject(new ScenarioTimeoutError(timeoutMs));
    }, timeoutMs);
    void Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function scenarioDiagnostic(outcome: {
  status: "pass" | "fail";
  error?: { message: string };
}): Diagnostic | null {
  if (outcome.status === "pass") {
    return null;
  }
  return diag("SCEN", "001", outcome.error?.message ?? "scenario failed");
}
