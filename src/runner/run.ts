import {
  applyCliOverrides,
  type CliOverrides,
  DEFAULT_CONFIG,
  defaultConfigPath,
  readConfigFile,
  type TestConfig,
} from "../domain/config.js";
import type { Diagnostic } from "../domain/diagnostics.js";
import type { CheckOutcome, RunMode, RunResult } from "../domain/types.js";
import { inspectArtifact } from "../package/artifact.js";
import { artifactCheckOutcome, manifestCheckOutcome } from "../package/checks.js";
import { readManifest } from "../package/manifest.js";
import { packPackage } from "../package/pack.js";
import type { PluginTestSuite } from "../scenarios/define.js";
import { loadScenarioSuites } from "../scenarios/load.js";
import { createTempDir, removeDir, resolvePackageRoot } from "../util/dirs.js";
import { runTarget, type TargetDeps } from "./pipeline.js";

export interface RunPluginTestsOptions {
  /** Package root containing package.json. Defaults to cwd. */
  packageRoot?: string | undefined;
  /** Programmatic overrides applied over the config file / defaults. */
  overrides?: CliOverrides | undefined;
  /** Programmatic scenario suites; skips config-file scenario loading. */
  suites?: PluginTestSuite[] | undefined;
  onEvent?: ((event: RunEvent) => void) | undefined;
  /** Injection seam for tests: per-target pipeline implementation. */
  runTargetImpl?: typeof runTarget | undefined;
  /** Injection seam for tests: per-target pipeline dependencies. */
  targetDeps?: TargetDeps | undefined;
}

export type RunEvent =
  | { kind: "phase"; target: string; phase: string }
  | { kind: "scenario"; target: string; name: string; status: "pass" | "fail" };

function mergeConfig(base: TestConfig, overrides?: CliOverrides): TestConfig {
  return applyCliOverrides(base, overrides);
}

/**
 * Programmatic entry point: full conformance run across the target matrix.
 * Never throws; every problem lands in the RunResult.
 */
export async function runPluginTests(options: RunPluginTestsOptions = {}): Promise<RunResult> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const packageRoot = resolvePackageRoot(options.packageRoot);
  const events = options.onEvent;

  // 1. Config resolution: defaults < config file < programmatic overrides.
  let config: TestConfig = DEFAULT_CONFIG;
  const configResult = await readConfigFile(defaultConfigPath(packageRoot));
  if ("config" in configResult) {
    config = configResult.config;
  } else if (!isDefaultConfigMissing(configResult.error)) {
    return failRun(packageRoot, config.mode, startedAt, 0, [], [configResult.error]);
  }
  config = mergeConfig(config, options.overrides);

  const runTmp = await createTempDir();
  try {
    // 2. Manifest.
    const manifestResult = await readManifest(packageRoot);
    if ("error" in manifestResult) {
      return failRun(
        packageRoot,
        config.mode,
        startedAt,
        elapsed(startedAtMs),
        [],
        [manifestResult.error],
      );
    }
    const packageChecks: CheckOutcome[] = [manifestCheckOutcome(manifestResult.manifest)];

    // 3. Pack once (packed mode); the artifact is shared across targets.
    let prepackedTarball: string | null = null;
    if (config.mode === "packed") {
      events?.({ kind: "phase", target: "*", phase: "pack" });
      const packResult = await packPackage(packageRoot, runTmp, config.packTimeoutMs);
      if ("error" in packResult) {
        return failRun(packageRoot, config.mode, startedAt, elapsed(startedAtMs), packageChecks, [
          packResult.error,
        ]);
      }
      prepackedTarball = packResult.artifact.tarballPath;
      const inspection = await inspectArtifact(prepackedTarball, manifestResult.manifest);
      if (!inspection.ok) {
        return failRun(packageRoot, config.mode, startedAt, elapsed(startedAtMs), packageChecks, [
          inspection.error,
        ]);
      }
      packageChecks.push(artifactCheckOutcome(inspection.missing));
    }

    // 4. Scenarios.
    let suites: PluginTestSuite[] = options.suites ?? [];
    if (options.suites === undefined && config.scenarios !== null) {
      const loadResult = await loadScenarioSuites(config.scenarios, packageRoot);
      if ("error" in loadResult) {
        return failRun(packageRoot, config.mode, startedAt, elapsed(startedAtMs), packageChecks, [
          loadResult.error,
        ]);
      }
      suites = loadResult.suites;
    }

    // 5. Target matrix.
    const targets = [];
    const targetImpl = options.runTargetImpl ?? runTarget;
    for (const spec of config.targets) {
      events?.({ kind: "phase", target: spec, phase: "target-start" });
      const outcome = await targetImpl({
        packageRoot,
        spec,
        config,
        prepackedTarball,
        suites,
        deps: options.targetDeps,
      });
      for (const scenario of outcome.scenarios) {
        events?.({ kind: "scenario", target: spec, name: scenario.name, status: scenario.status });
      }
      events?.({ kind: "phase", target: spec, phase: "target-end" });
      targets.push(outcome);
    }

    const diagnostics: Diagnostic[] = [
      ...packageChecks.flatMap((c) => c.diagnostics),
      ...targets.flatMap((t) => t.diagnostics),
    ];
    return {
      packageRoot,
      mode: config.mode,
      startedAt,
      durationMs: elapsed(startedAtMs),
      packageChecks,
      targets,
      status: worstRunStatus(packageChecks, targets),
      diagnostics,
    };
  } finally {
    if (!config.keepSandbox) {
      await removeDir(runTmp);
    }
  }
}

function elapsed(startedAtMs: number): number {
  return Date.now() - startedAtMs;
}

function isDefaultConfigMissing(error: Diagnostic): boolean {
  return error.code === "CFG002" && error.message.includes("plugin-test.config.json");
}

function failRun(
  packageRoot: string,
  mode: RunMode,
  startedAt: string,
  durationMs: number,
  packageChecks: CheckOutcome[],
  diagnostics: Diagnostic[],
): RunResult {
  return {
    packageRoot,
    mode,
    startedAt,
    durationMs,
    packageChecks,
    targets: [],
    status: "fail",
    diagnostics: [...packageChecks.flatMap((c) => c.diagnostics), ...diagnostics],
  };
}

function worstRunStatus(
  packageChecks: CheckOutcome[],
  targets: RunResult["targets"],
): RunResult["status"] {
  const statuses = [...packageChecks.map((c) => c.status), ...targets.map((t) => t.status)];
  if (statuses.includes("fail")) {
    return "fail";
  }
  if (statuses.includes("warn")) {
    return "warn";
  }
  return "pass";
}
