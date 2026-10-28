import type { RunResult } from "../domain/types.js";

function xmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * JUnit XML for CI integration. Each target becomes a <testsuite>; checks and
 * scenarios become <testcase> entries; failures carry the diagnostic codes.
 */
export function renderJunit(run: RunResult): string {
  const suites: string[] = [];
  let total = 0;
  let failures = 0;

  for (const target of run.targets) {
    const cases: string[] = [];
    let suiteFailures = 0;
    for (const check of target.checks) {
      total++;
      const failed = check.status === "fail";
      if (failed) {
        suiteFailures++;
      }
      const message = check.diagnostics.map((d) => `${d.code}: ${d.message}`).join("; ");
      cases.push(
        failed
          ? `    <testcase name="check: ${xmlEscape(check.name)}" classname="${xmlEscape(target.spec)}"><failure message="${xmlEscape(message)}"/></testcase>`
          : `    <testcase name="check: ${xmlEscape(check.name)}" classname="${xmlEscape(target.spec)}"/>`,
      );
    }
    for (const scenario of target.scenarios) {
      total++;
      if (scenario.status === "fail") {
        suiteFailures++;
      }
      const message = xmlEscape(scenario.error?.message ?? "scenario failed");
      cases.push(
        scenario.status === "fail"
          ? `    <testcase name="scenario: ${xmlEscape(scenario.name)}" classname="${xmlEscape(`${target.spec} ${scenario.suite}`)}" time="${(scenario.durationMs / 1000).toFixed(3)}"><failure message="${message}"/></testcase>`
          : `    <testcase name="scenario: ${xmlEscape(scenario.name)}" classname="${xmlEscape(`${target.spec} ${scenario.suite}`)}" time="${(scenario.durationMs / 1000).toFixed(3)}"/>`,
      );
    }
    for (const d of target.diagnostics) {
      total++;
      suiteFailures++;
      cases.push(
        `    <testcase name="host: ${xmlEscape(d.code)}" classname="${xmlEscape(target.spec)}"><failure message="${xmlEscape(`${d.code}: ${d.message}`)}"/></testcase>`,
      );
    }
    failures += suiteFailures;
    suites.push(
      `  <testsuite name="${xmlEscape(target.spec)}" tests="${cases.length}" failures="${suiteFailures}">\n${cases.join("\n")}\n  </testsuite>`,
    );
  }

  for (const check of run.packageChecks) {
    total++;
    const failed = check.status === "fail";
    if (failed) {
      failures++;
    }
    const message = check.diagnostics.map((d) => `${d.code}: ${d.message}`).join("; ");
    const body = failed ? `<failure message="${xmlEscape(message)}"/>` : "";
    suites.push(
      `  <testsuite name="package" tests="1" failures="${failed ? 1 : 0}">\n    <testcase name="check: ${xmlEscape(check.name)}" classname="package">${body}</testcase>\n  </testsuite>`,
    );
  }

  const suiteStatus = run.status === "fail";
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="@coool/opencode-plugin-test" tests="${total}" failures="${failures}"${suiteStatus ? ' status="failed"' : ""}>`,
    ...suites,
    "</testsuites>",
    "",
  ].join("\n");
}
