import { targetStatus } from "../domain/aggregation.js";
import type { CheckOutcome, RunResult, ScenarioOutcome, TargetOutcome } from "../domain/types.js";

function icon(status: "pass" | "fail" | "warn"): string {
  if (status === "fail") {
    return "✗";
  }
  if (status === "warn") {
    return "!";
  }
  return "✓";
}

function renderCheck(check: CheckOutcome, indent: string): string[] {
  const lines = [`${indent}${icon(check.status)} ${check.name}`];
  for (const d of check.diagnostics) {
    lines.push(`${indent}  ${d.code}: ${d.message}`);
    if (d.hint !== undefined) {
      lines.push(`${indent}    hint: ${d.hint}`);
    }
  }
  return lines;
}

function renderScenario(scenario: ScenarioOutcome, indent: string): string[] {
  const lines = [`${indent}${icon(scenario.status)} ${scenario.name} (${scenario.durationMs}ms)`];
  if (scenario.error !== undefined) {
    lines.push(`${indent}  ${scenario.error.message}`);
  }
  return lines;
}

function renderTarget(target: TargetOutcome, indent: string): string[] {
  const lines = [
    `${indent}${icon(targetStatus(target))} target ${target.spec} (opencode ${target.version ?? "?"})`,
  ];
  for (const check of target.checks) {
    lines.push(...renderCheck(check, `${indent}  `));
  }
  for (const scenario of target.scenarios) {
    lines.push(...renderScenario(scenario, `${indent}  `));
  }
  for (const d of target.diagnostics) {
    lines.push(`${indent}  ${d.code}: ${d.message}`);
    if (d.hint !== undefined) {
      lines.push(`${indent}    hint: ${d.hint}`);
    }
  }
  return lines;
}

export function renderPretty(run: RunResult): string {
  const lines: string[] = [];
  lines.push(`@coool/opencode-plugin-test — ${run.status.toUpperCase()}`);
  lines.push(`package: ${run.packageRoot} (mode: ${run.mode}, ${run.durationMs}ms)`);
  if (run.packageChecks.length > 0) {
    lines.push("package checks:");
    for (const check of run.packageChecks) {
      lines.push(...renderCheck(check, "  "));
    }
  }
  if (run.targets.length === 0) {
    lines.push("no targets were run");
  }
  for (const target of run.targets) {
    lines.push(...renderTarget(target, ""));
  }
  return lines.join("\n");
}
