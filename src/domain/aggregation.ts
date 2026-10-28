import { EXIT_OK, EXIT_TEST_FAILURE, exitCodeForDiagnostics } from "./diagnostics.js";
import type { OutcomeStatus, RunResult, TargetOutcome } from "./types.js";

export function worstStatus(statuses: readonly OutcomeStatus[]): OutcomeStatus {
  if (statuses.includes("fail")) {
    return "fail";
  }
  if (statuses.includes("warn")) {
    return "warn";
  }
  return "pass";
}

export function targetStatus(target: TargetOutcome): OutcomeStatus {
  const failingDiagnostic = target.diagnostics.some((d) => exitCodeForDiagnostics([d]) !== EXIT_OK);
  return worstStatus([
    target.status,
    failingDiagnostic ? "fail" : "pass",
    ...target.checks.map((c) => c.status),
    ...target.scenarios.map((s) => s.status),
  ]);
}

export function runStatus(run: RunResult): OutcomeStatus {
  return worstStatus([
    ...run.packageChecks.map((c) => c.status),
    ...run.targets.map((t) => targetStatus(t)),
  ]);
}

export function runExitCode(run: RunResult): number {
  const diagnosticExit = exitCodeForDiagnostics(run.diagnostics);
  // A failing status (e.g. from a check- or scenario-level diagnostic that is
  // not repeated in run.diagnostics) always implies the test-failure exit.
  return run.status === "fail" ? Math.max(diagnosticExit, EXIT_TEST_FAILURE) : diagnosticExit;
}

export function countFailures(run: RunResult): number {
  let count = run.diagnostics.filter((d) => exitCodeForDiagnostics([d]) !== 0).length;
  for (const t of run.targets) {
    count += t.diagnostics.filter((d) => exitCodeForDiagnostics([d]) !== 0).length;
  }
  return count;
}
