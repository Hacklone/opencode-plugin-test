import os from "node:os";
import path from "node:path";
import { worstStatus } from "../domain/aggregation.js";
import type { TestConfig } from "../domain/config.js";
import type { Diagnostic } from "../domain/diagnostics.js";
import type { TargetOutcome } from "../domain/types.js";
import { type BootOptions, bootHost, locatePlugin, stopHost } from "../opencode/boot.js";
import { createSandbox, destroySandbox, writeProjectConfig } from "../opencode/sandbox.js";
import { resolveTarget } from "../opencode/target.js";
import { artifactCheckOutcome, pluginRegistrationCheckOutcome } from "../package/checks.js";
import { materializePackage } from "../package/materialize.js";
import type { PluginTestSuite, ScenarioContext } from "../scenarios/define.js";
import { makePluginStatusFn, makeRequest } from "../scenarios/define.js";
import { runScenario } from "../scenarios/run.js";

export interface TargetDeps {
  resolveTargetImpl?: typeof resolveTarget;
  materializeImpl?: typeof materializePackage;
  bootImpl?: typeof bootHost;
  locateImpl?: typeof locatePlugin;
  runScenarioImpl?: typeof runScenario;
}

export interface TargetInput {
  packageRoot: string;
  spec: string;
  config: TestConfig;
  prepackedTarball: string | null;
  suites: PluginTestSuite[];
  deps?: TargetDeps | undefined;
}

/** Shared on-disk cache for npm-installed OpenCode targets. */
export function defaultCacheDir(): string {
  return path.join(os.tmpdir(), "opencode-plugin-test-cache");
}

/** Runs the full pipeline for one target: sandbox → materialize → boot → checks → scenarios → teardown. */
export async function runTarget(input: TargetInput): Promise<TargetOutcome> {
  const { config } = input;
  const diagnostics: Diagnostic[] = [];
  const targetDeps = input.deps ?? {};
  const cacheDir = defaultCacheDir();

  const resolveResult = await (targetDeps.resolveTargetImpl ?? resolveTarget)(input.spec, cacheDir);
  if ("error" in resolveResult) {
    return {
      spec: input.spec,
      status: "fail",
      version: null,
      host: null,
      checks: [],
      scenarios: [],
      diagnostics: [resolveResult.error],
    };
  }
  const target = resolveResult.target;

  const sandbox = await createSandbox(path.dirname(target.binaryPath), {});
  try {
    const materialize = await (targetDeps.materializeImpl ?? materializePackage)(
      input.packageRoot,
      config.mode,
      sandbox.paths.work,
      { packTimeoutMs: config.packTimeoutMs, installTimeoutMs: config.installTimeoutMs },
      {},
      input.prepackedTarball ?? undefined,
    );
    if (!materialize.ok) {
      diagnostics.push(materialize.error);
      return finish(input.spec, target.version, null, null, [], [], diagnostics);
    }
    // Now that the loadable directory is known, register it in the sandbox
    // project config (packed mode: the extracted artifact; source mode: the
    // checkout itself).
    await writeProjectConfig(sandbox.paths.project, materialize.value.dir);

    const bootOpts: BootOptions = {
      binaryPath: target.binaryPath,
      cwd: sandbox.paths.project,
      env: sandbox.hostEnv,
      username: sandbox.username,
      password: sandbox.password,
      bootTimeoutMs: config.bootTimeoutMs,
    };
    const boot = await (targetDeps.bootImpl ?? bootHost)(bootOpts);
    if (!boot.ok) {
      diagnostics.push(boot.error);
      return finish(input.spec, target.version, null, null, [], [], diagnostics);
    }

    try {
      const locate = await (targetDeps.locateImpl ?? locatePlugin)(
        boot.host.server,
        materialize.value.dir,
        config.expectedPluginId,
        config.bootTimeoutMs,
      );
      if (!locate.ok) {
        diagnostics.push(locate.error);
        return finish(input.spec, target.version, baseUrl(boot), null, [], [], diagnostics);
      }
      const registration = pluginRegistrationCheckOutcome(locate.plugin, config.surfaces);
      const artifactCheck = artifactCheckOutcome(materialize.missingPackedFiles);
      const checks = [artifactCheck, registration];

      if (registration.status === "fail") {
        return finish(
          input.spec,
          target.version,
          baseUrl(boot),
          locate.plugin.id ?? null,
          checks,
          [],
          diagnostics,
        );
      }

      const outcomes = [];
      for (const suite of input.suites) {
        for (const scenario of suite.scenarios) {
          if (config.scenarioFilter.length > 0 && !config.scenarioFilter.includes(scenario.name)) {
            continue;
          }
          const ctx: ScenarioContext = {
            suite: suite.name,
            scenario: scenario.name,
            target,
            plugin: locate.plugin,
            server: boot.host.server,
            paths: sandbox.paths,
            options: config.options,
            request: (p, init) => makeRequest(boot.host.server, p, init),
            pluginStatus: makePluginStatusFn(boot.host.server),
          };
          const outcome = await (targetDeps.runScenarioImpl ?? runScenario)(
            suite,
            scenario,
            ctx,
            config.scenarioTimeoutMs,
          );
          outcomes.push(outcome);
        }
      }
      return finish(
        input.spec,
        target.version,
        baseUrl(boot),
        locate.plugin.id ?? null,
        checks,
        outcomes,
        diagnostics,
      );
    } finally {
      await stopHost(boot.host);
    }
  } finally {
    if (!config.keepSandbox) {
      await destroySandbox(sandbox.paths);
    }
  }
}

function baseUrl(boot: { host: { server: { baseUrl: string } } }): string {
  return boot.host.server.baseUrl;
}

function finish(
  spec: string,
  version: string | null,
  hostBaseUrl: string | null,
  pluginId: string | null,
  checks: TargetOutcome["checks"],
  scenarios: TargetOutcome["scenarios"],
  diagnostics: Diagnostic[],
): TargetOutcome {
  const status = worstStatus([
    ...checks.map((c) => c.status),
    ...scenarios.map((s) => s.status),
    ...(diagnostics.length > 0 ? (["fail"] as const) : []),
  ]);
  return {
    spec,
    status,
    version,
    host: hostBaseUrl === null ? null : { baseUrl: hostBaseUrl, version, pluginId },
    checks,
    scenarios,
    diagnostics,
  };
}
