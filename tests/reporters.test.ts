import { describe, expect, it } from "vitest";
import { CODE_CATALOG, diag } from "../src/domain/diagnostics.js";
import type { CheckOutcome, RunResult, TargetOutcome } from "../src/domain/types.js";
import { type ReporterName, renderReport } from "../src/reporters/index.js";
import { renderJson } from "../src/reporters/json.js";
import { renderJunit } from "../src/reporters/junit.js";
import { renderPretty } from "../src/reporters/pretty.js";

function check(
  name: string,
  status: CheckOutcome["status"],
  diagnostics: CheckOutcome["diagnostics"] = [],
): CheckOutcome {
  return { name, status, diagnostics };
}

function target(overrides: Partial<TargetOutcome> = {}): TargetOutcome {
  return {
    spec: "current",
    status: "pass",
    version: "2.1.2",
    host: { baseUrl: "http://127.0.0.1:4096", version: "2.1.2", pluginId: "my-plugin" },
    checks: [],
    scenarios: [],
    diagnostics: [],
    ...overrides,
  };
}

function run(overrides: Partial<RunResult> = {}): RunResult {
  return {
    packageRoot: "/repo",
    mode: "packed",
    startedAt: "2026-10-28T00:00:00.000Z",
    durationMs: 123,
    packageChecks: [],
    targets: [],
    status: "pass",
    diagnostics: [],
    ...overrides,
  };
}

function passRun(): RunResult {
  return run({
    packageChecks: [check("manifest valid", "pass")],
    targets: [
      target({
        checks: [check("exports server", "pass")],
        scenarios: [{ name: "greets", suite: "my-plugin", status: "pass", durationMs: 42 }],
      }),
    ],
  });
}

function failRun(): RunResult {
  return run({
    status: "fail",
    targets: [
      target({
        spec: "current",
        status: "fail",
        version: null,
        host: null,
        checks: [
          check("npm pack", "pass"),
          check("exports server", "fail", [
            diag("PKG", "006", "no server export in the exports map", 'add "./server" to exports'),
          ]),
        ],
        scenarios: [
          {
            name: "greets",
            suite: "my-plugin",
            status: "fail",
            durationMs: 7,
            error: { message: "plugin is failed" },
          },
        ],
        diagnostics: [diag("SCEN", "001", "scenario failed")],
      }),
    ],
    diagnostics: [diag("SCEN", "001", "scenario failed")],
  });
}

function warnRun(): RunResult {
  return run({
    status: "warn",
    packageChecks: [
      check("version is semver", "warn", [
        diag("PKG", "004", "version is missing or not a valid semver"),
      ]),
    ],
  });
}

describe("renderPretty", () => {
  it("renders a passing run header and icons", () => {
    const out = renderPretty(passRun());
    expect(out).toContain("@coool/opencode-plugin-test — PASS");
    expect(out).toContain("package: /repo (mode: packed, 123ms)");
    expect(out).toContain("package checks:");
    expect(out).toContain("✓ manifest valid");
    expect(out).toContain("✓ target current (opencode 2.1.2)");
    expect(out).toContain("✓ exports server");
    expect(out).toContain("✓ greets (42ms)");
  });

  it("renders a failing run with diagnostics and hint text", () => {
    const out = renderPretty(failRun());
    expect(out).toContain("@coool/opencode-plugin-test — FAIL");
    expect(out).toContain("✗ target current (opencode ?)");
    expect(out).toContain("✗ exports server");
    expect(out).toContain("PKG006: no server export in the exports map");
    expect(out).toContain('hint: add "./server" to exports');
    expect(out).toContain("✗ greets (7ms)");
    expect(out).toContain("plugin is failed");
    expect(out).toContain("SCEN001: scenario failed");
  });

  it("renders a warn run with the ! icon", () => {
    const out = renderPretty(warnRun());
    expect(out).toContain("@coool/opencode-plugin-test — WARN");
    expect(out).toContain("! version is semver");
    expect(out).toContain("PKG004: version is missing or not a valid semver");
  });

  it("renders hints for target-level diagnostics", () => {
    const out = renderPretty(
      run({
        status: "fail",
        targets: [
          target({
            status: "fail",
            version: null,
            host: null,
            diagnostics: [diag("HOST", "002", "not ready in time", "raise --boot-timeout-ms")],
          }),
        ],
      }),
    );
    expect(out).toContain("HOST002: not ready in time");
    expect(out).toContain("hint: raise --boot-timeout-ms");
  });

  it("mentions that no targets were run", () => {
    expect(renderPretty(run())).toContain("no targets were run");
  });
});

describe("renderJson", () => {
  it("produces JSON.parse-able output that round-trips run fields", () => {
    const source = failRun();
    const parsed = JSON.parse(renderJson(source)) as RunResult;
    expect(parsed).toEqual(source);
    expect(parsed.status).toBe("fail");
    expect(parsed.packageRoot).toBe("/repo");
    expect(parsed.mode).toBe("packed");
    expect(parsed.durationMs).toBe(123);
    expect(parsed.targets[0]?.spec).toBe("current");
    expect(parsed.targets[0]?.checks[1]?.diagnostics[0]?.code).toBe("PKG006");
    expect(parsed.diagnostics[0]?.code).toBe("SCEN001");
  });

  it("round-trips a passing run", () => {
    const parsed = JSON.parse(renderJson(passRun())) as RunResult;
    expect(parsed).toEqual(passRun());
    expect(parsed.status).toBe("pass");
  });
});

describe("renderJunit", () => {
  it("escapes XML entities in diagnostic messages", () => {
    const evil = `<>&'"`;
    // Escape order in xmlEscape: & first, then < > " ' — so quotes come out as &apos;&quot;.
    const escaped = "&lt;&gt;&amp;&apos;&quot;";
    const out = renderJunit(
      run({
        status: "fail",
        targets: [
          target({
            spec: `evil-${evil}-spec`,
            status: "fail",
            checks: [check(`name ${evil}`, "fail", [diag("API", "001", evil)])],
          }),
        ],
      }),
    );
    expect(out).toContain(escaped);
    expect(out).toContain(`classname="evil-${escaped}-spec"`);
    expect(out).toContain(`name="check: name ${escaped}"`);
    expect(out).toContain(`message="API001: ${escaped}"`);
    expect(out).not.toContain(`<>&`);
  });

  it("counts tests and failures per testsuite", () => {
    const source = failRun(); // target: 1 pass check + 1 fail check + 1 fail scenario + 1 host diag
    const out = renderJunit(source);
    expect(out.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(out).toContain(
      '<testsuites name="@coool/opencode-plugin-test" tests="4" failures="3" status="failed">',
    );
    expect(out).toContain('<testsuite name="current" tests="4" failures="3">');
    expect(out).toContain("</testsuites>");
    // failing check / scenario / host diag carry <failure>
    expect(out).toContain('<failure message="PKG006: no server export in the exports map"/>');
    expect(out).toContain('<failure message="plugin is failed"/>');
    expect(out).toContain('<failure message="SCEN001: scenario failed"/>');
    // host diagnostic becomes a testcase
    expect(out).toContain('<testcase name="host: SCEN001" classname="current">');
  });

  it("renders a failing package check as a testcase failure in the package suite", () => {
    const out = renderJunit(
      run({
        status: "fail",
        packageChecks: [
          check("exports server", "fail", [
            diag("PKG", "006", "no server export in the exports map"),
          ]),
        ],
      }),
    );
    expect(out).toContain(
      '<testsuites name="@coool/opencode-plugin-test" tests="1" failures="1" status="failed">',
    );
    expect(out).toContain('<testsuite name="package" tests="1" failures="1">');
    expect(out).toContain(
      '<testcase name="check: exports server" classname="package"><failure message="PKG006: no server export in the exports map"/></testcase>',
    );
  });

  it("includes the package testsuite and reports zero failures on a pass", () => {
    const out = renderJunit(passRun());
    expect(out).toContain('<testsuites name="@coool/opencode-plugin-test" tests="3" failures="0">');
    expect(out).not.toContain('status="failed"');
    expect(out).toContain('<testsuite name="package" tests="1" failures="0">');
    expect(out).toContain('<testcase name="check: manifest valid" classname="package"></testcase>');
    expect(out).not.toContain("<failure");
  });

  it("formats scenario durations as seconds", () => {
    const out = renderJunit(
      run({
        targets: [
          target({
            scenarios: [{ name: "slow", suite: "s", status: "pass", durationMs: 2500 }],
          }),
        ],
      }),
    );
    expect(out).toContain('time="2.500"');
  });
});

describe("renderReport", () => {
  const source = failRun();

  it("dispatches to the pretty reporter", () => {
    expect(renderReport(source, "pretty")).toBe(renderPretty(source));
  });

  it("dispatches to the json reporter", () => {
    expect(renderReport(source, "json")).toBe(renderJson(source));
  });

  it("dispatches to the junit reporter", () => {
    expect(renderReport(source, "junit")).toBe(renderJunit(source));
  });

  it("returns undefined for an unknown format (no exhaustiveness guard)", () => {
    const unknown = "yaml" as unknown as ReporterName;
    expect(renderReport(source, unknown)).toBeUndefined();
  });
});

describe("diag / CODE_CATALOG", () => {
  it("builds a cataloged diagnostic", () => {
    const d = diag("CFG", "003", "invalid CLI invocation");
    expect(d).toEqual({ code: "CFG003", family: "CFG", message: "invalid CLI invocation" });
    expect(CODE_CATALOG["CFG003"]).toBe("invalid CLI invocation");
  });

  it("attaches an optional hint", () => {
    const d = diag("SCEN", "002", "scenario timed out", "raise --scenario-timeout-ms");
    expect(d.hint).toBe("raise --scenario-timeout-ms");
  });

  it("rejects unknown codes", () => {
    expect(() => diag("CFG", "999", "nope")).toThrow(/Unknown diagnostic code CFG999/);
    // A code number that does not exist under the CFG family is rejected too.
    expect(() => diag("CFG", "201", "no CFG201 in the catalog")).toThrow(
      /Unknown diagnostic code CFG201/,
    );
  });
});
