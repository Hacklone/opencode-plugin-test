import { describe, expect, it } from "vitest";
import { countFailures, runStatus, targetStatus, worstStatus } from "../src/domain/aggregation.js";
import { diag } from "../src/domain/diagnostics.js";
import type {
  CheckOutcome,
  RunResult,
  ScenarioOutcome,
  TargetOutcome,
} from "../src/domain/types.js";

function check(status: CheckOutcome["status"]): CheckOutcome {
  return { name: "c", status, diagnostics: [] };
}

function scenario(status: ScenarioOutcome["status"]): ScenarioOutcome {
  return { name: "s", suite: "t", status, durationMs: 1 };
}

function target(overrides: Partial<TargetOutcome>): TargetOutcome {
  return {
    spec: "current",
    status: "pass",
    version: "2.1.2",
    host: null,
    checks: [],
    scenarios: [],
    diagnostics: [],
    ...overrides,
  };
}

function run(overrides: Partial<RunResult>): RunResult {
  return {
    packageRoot: "/p",
    mode: "packed",
    startedAt: "now",
    durationMs: 1,
    packageChecks: [],
    targets: [],
    status: "pass",
    diagnostics: [],
    ...overrides,
  };
}

describe("aggregation", () => {
  it("worstStatus ranks fail > warn > pass", () => {
    expect(worstStatus(["pass", "pass"])).toBe("pass");
    expect(worstStatus(["pass", "warn"])).toBe("warn");
    expect(worstStatus(["warn", "fail", "pass"])).toBe("fail");
    expect(worstStatus([])).toBe("pass");
  });

  it("targetStatus combines checks, scenarios and diagnostics", () => {
    expect(targetStatus(target({}))).toBe("pass");
    expect(targetStatus(target({ checks: [check("warn")] }))).toBe("warn");
    expect(targetStatus(target({ scenarios: [scenario("fail")] }))).toBe("fail");
    expect(targetStatus(target({ diagnostics: [diag("HOST", "006", "x")] }))).toBe("fail");
  });

  it("runStatus combines package checks and targets", () => {
    expect(runStatus(run({ packageChecks: [check("warn")] }))).toBe("warn");
    expect(runStatus(run({ targets: [target({ status: "fail" })] }))).toBe("fail");
    expect(runStatus(run({}))).toBe("pass");
  });

  it("runExitCode maps families", () => {
    expect(runStatus(run({ diagnostics: [diag("CFG", "001", "x")] }))).toBe("pass");
  });

  it("countFailures counts diagnostics that imply exit != 0", () => {
    const r = run({
      diagnostics: [diag("PKG", "003", "x")],
      targets: [target({ diagnostics: [diag("CFG", "003", "x")] })],
    });
    expect(countFailures(r)).toBe(2);
    expect(countFailures(run({}))).toBe(0);
  });
});
