/**
 * Integration tests: REAL runs against the real OpenCode host on PATH.
 * Sequential because each test boots a real `opencode serve` in a sandbox.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RunResult } from "../src/index.js";
import { EXIT_OK, EXIT_TEST_FAILURE, runExitCode, runPluginTests } from "../src/index.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOOT_TIMEOUT_MS = 30_000;

function fixturePath(name: string): string {
  return path.join(REPO_ROOT, "fixtures", name);
}

/** Every diagnostic the run produced, at run, target AND check level. */
function allCodes(run: RunResult): string[] {
  return [
    ...run.diagnostics.map((d) => d.code),
    ...run.targets.flatMap((t) => [
      ...t.diagnostics.map((d) => d.code),
      ...t.checks.flatMap((c) => c.diagnostics.map((d) => d.code)),
    ]),
  ];
}

function firstTarget(run: RunResult) {
  const target = run.targets[0];
  if (target === undefined) throw new Error("expected a target outcome");
  return target;
}

describe.sequential("integration (real opencode host)", () => {
  it("valid plugin passes the whole packed pipeline", { timeout: 120_000 }, async () => {
    const run = await runPluginTests({
      packageRoot: fixturePath("valid"),
      overrides: { bootTimeoutMs: BOOT_TIMEOUT_MS },
    });
    expect(run.status).toBe("pass");
    expect(allCodes(run)).toEqual([]);
    const target = firstTarget(run);
    expect(target.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(target.host?.pluginId?.length ?? 0).toBeGreaterThan(0);
    const checkNames = target.checks.map((c) => c.name);
    expect(checkNames).toContain("packed-artifact");
    expect(checkNames).toContain("plugin-registration");
    expect(run.packageChecks.map((c) => c.name)).toContain("package-manifest");
    expect(runExitCode(run)).toBe(EXIT_OK);
  });

  it("missing packed file surfaces PKG007 and fails", { timeout: 120_000 }, async () => {
    const run = await runPluginTests({
      packageRoot: fixturePath("missing-packed-file"),
      overrides: { bootTimeoutMs: BOOT_TIMEOUT_MS },
    });
    expect(allCodes(run)).toContain("PKG007");
    expect(runExitCode(run)).toBe(EXIT_TEST_FAILURE);
  });

  it("invalid export (import-time throw) surfaces HOST006", { timeout: 120_000 }, async () => {
    const run = await runPluginTests({
      packageRoot: fixturePath("invalid-export"),
      overrides: { bootTimeoutMs: BOOT_TIMEOUT_MS },
    });
    expect(allCodes(run)).toContain("HOST006");
    expect(runExitCode(run)).toBe(EXIT_TEST_FAILURE);
  });

  it("setup throw surfaces HOST006", { timeout: 120_000 }, async () => {
    const run = await runPluginTests({
      packageRoot: fixturePath("startup-throw"),
      overrides: { bootTimeoutMs: BOOT_TIMEOUT_MS },
    });
    expect(allCodes(run)).toContain("HOST006");
    expect(runExitCode(run)).toBe(EXIT_TEST_FAILURE);
  });

  it("unresolvable runtime dependency surfaces PKG011", { timeout: 180_000 }, async () => {
    const run = await runPluginTests({
      packageRoot: fixturePath("failed-runtime-dep"),
      overrides: { bootTimeoutMs: BOOT_TIMEOUT_MS },
    });
    expect(allCodes(run)).toContain("PKG011");
    expect(runExitCode(run)).toBe(EXIT_TEST_FAILURE);
  });

  it("config options reach scenario context (ADR 0003 options channel)", {
    timeout: 120_000,
  }, async () => {
    // The {package, options} host config form does not resolve local
    // artifacts (verified 2.1.2/2.2.0), so options are verified through a
    // scenario that receives them from the tool's own config.
    const tmp = path.join(REPO_ROOT, "tmp", `options-it-${process.pid}`);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(path.join(tmp, "fixture"), { recursive: true });
    cpSync(fixturePath("options-plugin"), path.join(tmp, "fixture"), { recursive: true });
    // The scenario file self-imports the tool; under real module resolution
    // that needs node_modules (vitest's alias only covers in-root loaders).
    mkdirSync(path.join(tmp, "fixture", "node_modules"), { recursive: true });
    symlinkSync(
      REPO_ROOT,
      path.join(tmp, "fixture", "node_modules", "opencode-plugin-test"),
      "dir",
    );
    writeFileSync(
      path.join(tmp, "fixture", "plugin-test.config.json"),
      JSON.stringify({
        targets: ["current"],
        mode: "packed",
        surfaces: ["server"],
        bootTimeoutMs: BOOT_TIMEOUT_MS,
        scenarios: "./plugin-test.scenarios.ts",
        options: { greeting: "hi-from-config" },
      }),
    );
    writeFileSync(
      path.join(tmp, "fixture", "plugin-test.scenarios.ts"),
      [
        `import { definePluginTestSuite } from "opencode-plugin-test";`,
        ``,
        `export default definePluginTestSuite({`,
        `  name: "options-suite",`,
        `  scenarios: {`,
        `    "options-reach-scenarios": async (ctx) => {`,
        `      if (ctx.options["greeting"] !== "hi-from-config") {`,
        `        throw new Error("greeting was " + String(ctx.options["greeting"]));`,
        `      }`,
        `      const status = await ctx.pluginStatus();`,
        `      if ("message" in status) throw new Error(status.message);`,
        `      if (status.state.status !== "active") {`,
        `        throw new Error("plugin not active");`,
        `      }`,
        `    },`,
        `  },`,
        `});`,
        ``,
      ].join("\n"),
    );
    try {
      const run = await runPluginTests({ packageRoot: path.join(tmp, "fixture") });
      expect(allCodes(run)).toEqual([]);
      expect(runExitCode(run)).toBe(EXIT_OK);
      const target = firstTarget(run);
      expect(target.scenarios.map((s) => s.name)).toContain("options-reach-scenarios");
      expect(target.scenarios.every((s) => s.status === "pass")).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("scenario suite loads from the package config and passes", { timeout: 120_000 }, async () => {
    const run = await runPluginTests({ packageRoot: fixturePath("scenario-suite") });
    expect(allCodes(run)).toEqual([]);
    expect(runExitCode(run)).toBe(EXIT_OK);
    const target = firstTarget(run);
    const names = target.scenarios.map((s) => s.name);
    expect(names).toContain("plugin-is-active");
    expect(names).toContain("api-reachable");
    expect(target.scenarios.every((s) => s.status === "pass")).toBe(true);
  });

  it("CLI smoke: bin reports PASS for the valid fixture", { timeout: 120_000 }, () => {
    const stdout = execFileSync(
      "node",
      [path.join(REPO_ROOT, "dist", "cli", "bin.js"), fixturePath("valid")],
      {
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    expect(stdout).toContain("PASS");
  });
});
