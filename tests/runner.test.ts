import type { ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { DEFAULT_CONFIG, type TestConfig } from "../src/domain/config.js";
import { type Diagnostic, diag } from "../src/domain/diagnostics.js";
import type { PluginInfo, ScenarioOutcome, TargetOutcome } from "../src/domain/types.js";
import type { BootOptions, BootResult, LocateResult, locatePlugin } from "../src/opencode/boot.js";
import type { ServerRef } from "../src/opencode/client.js";
import type { ResolvedTarget } from "../src/opencode/target.js";
import type { PluginManifest } from "../src/package/manifest.js";
import type { MaterializeResult, materializePackage } from "../src/package/materialize.js";
import {
  defaultCacheDir,
  runTarget,
  type TargetDeps,
  type TargetInput,
} from "../src/runner/pipeline.js";
import { type RunEvent, runPluginTests } from "../src/runner/run.js";
import type { PluginTestSuite, ScenarioContext } from "../src/scenarios/define.js";
import type { runScenario } from "../src/scenarios/run.js";
import type { StreamingHandle } from "../src/util/process.js";

// Record every removeDir call (run temp dir + sandbox teardown) while keeping
// the real implementation, so keepSandbox behavior stays observable.
const dirMocks = vi.hoisted(() => ({ removeDir: vi.fn() }));

vi.mock("../src/util/dirs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/util/dirs.js")>();
  return {
    ...actual,
    removeDir: (dir: string): Promise<void> => {
      dirMocks.removeDir(dir);
      return actual.removeDir(dir);
    },
  };
});

const tempDirs: string[] = [];

async function trackDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

let restoreFakeNpmEnv: (() => void) | null = null;

/**
 * A fake `npm` that shadows the real one on PATH for run-level packed-mode
 * tests (run.ts calls packPackage with the hard-wired "npm" binary).
 * - FAKE_NPM_EXIT set: exits with that code (npm pack failure → PKG008).
 * - FAKE_TARBALL_SRC set: copies a prebuilt tarball into the pack destination
 *   ($4) and prints the matching `npm pack --json` entry.
 * - Neither: prints an entry for a tarball that does not exist (→ PKG010).
 */
const FAKE_NPM_SCRIPT = `#!/bin/sh
if [ -n "$FAKE_NPM_EXIT" ]; then
  echo "fake npm failure" >&2
  exit "$FAKE_NPM_EXIT"
fi
if [ -n "$FAKE_TARBALL_SRC" ]; then
  cp "$FAKE_TARBALL_SRC" "$4/" || exit 1
  printf '[{"filename":"%s"}]' "$(basename "$FAKE_TARBALL_SRC")"
else
  printf '[{"filename":"ghost.tgz"}]'
fi
`;

async function useFakeNpm(tarballSrc: string | null, exitCode: string | null): Promise<void> {
  const binDir = await trackDir("fakebin-");
  const npmBin = path.join(binDir, "npm");
  await writeFile(npmBin, FAKE_NPM_SCRIPT);
  await chmod(npmBin, 0o755);
  const saved = {
    pathEnv: process.env["PATH"],
    tarballSrc: process.env["FAKE_TARBALL_SRC"],
    exitCode: process.env["FAKE_NPM_EXIT"],
  };
  process.env["PATH"] = `${binDir}${path.delimiter}${process.env["PATH"] ?? ""}`;
  if (tarballSrc !== null) {
    process.env["FAKE_TARBALL_SRC"] = tarballSrc;
  } else {
    delete process.env["FAKE_TARBALL_SRC"];
  }
  if (exitCode !== null) {
    process.env["FAKE_NPM_EXIT"] = exitCode;
  } else {
    delete process.env["FAKE_NPM_EXIT"];
  }
  restoreFakeNpmEnv = () => {
    if (saved.pathEnv === undefined) {
      delete process.env["PATH"];
    } else {
      process.env["PATH"] = saved.pathEnv;
    }
    if (saved.tarballSrc === undefined) {
      delete process.env["FAKE_TARBALL_SRC"];
    } else {
      process.env["FAKE_TARBALL_SRC"] = saved.tarballSrc;
    }
    if (saved.exitCode === undefined) {
      delete process.env["FAKE_NPM_EXIT"];
    } else {
      process.env["FAKE_NPM_EXIT"] = saved.exitCode;
    }
    restoreFakeNpmEnv = null;
  };
}

afterEach(async () => {
  restoreFakeNpmEnv?.();
  dirMocks.removeDir.mockClear();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

const GOOD_PACKAGE_JSON = JSON.stringify({
  name: "p",
  version: "1.0.0",
  type: "module",
  exports: { ".": "./index.js" },
});

async function makePackageRoot(files: Record<string, string>): Promise<string> {
  const root = await trackDir("runner-pkg-");
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(path.join(root, name), contents);
  }
  return root;
}

/** Stages `package/`-rooted files and packs a real npm-style tarball. */
async function makeTarball(files: Record<string, string>): Promise<string> {
  const staging = await trackDir("runner-stage-");
  for (const [rel, contents] of Object.entries(files)) {
    const target = path.join(staging, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  const tarballPath = path.join(staging, "fake.tgz");
  await tar.c({ cwd: staging, file: tarballPath }, ["package"]);
  return tarballPath;
}

function firstArg<T>(fn: { mock: { calls: Array<[T]> } }): T {
  const call = fn.mock.calls[0];
  if (call === undefined) {
    throw new Error("expected the mock to be called at least once");
  }
  return call[0];
}

function testConfig(overrides: Partial<TestConfig> = {}): TestConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function resolvedTarget(): ResolvedTarget {
  return { spec: "current", kind: "current", binaryPath: "/bin/opencode", version: "2.1.2" };
}

const manifest: PluginManifest = {
  name: "p",
  version: "1.0.0",
  type: "module",
  exports: { ".": "./index.js" },
  dependencies: null,
  raw: {},
};

function activePlugin(id: string | null): PluginInfo {
  const info: PluginInfo = {
    source: { type: "local", path: "/work/extract" },
    features: { server: true },
    state: { status: "active" },
  };
  if (id !== null) {
    info.id = id;
  }
  return info;
}

/** A fake booted host whose handle records stopHost teardown. */
function fakeBoot(): { result: BootResult; kill: Mock<() => Promise<void>> } {
  const kill = vi.fn(async (): Promise<void> => {});
  const handle: StreamingHandle = {
    child: {} as unknown as ChildProcess,
    stdout: () => "",
    stderr: () => "",
    spawnError: null,
    kill,
    exited: Promise.resolve({ code: null, signal: null }),
  };
  return {
    kill,
    result: {
      ok: true,
      host: {
        server: { baseUrl: "http://127.0.0.1:59999", username: "opencode", password: "pw" },
        port: 59999,
        handle,
      },
    },
  };
}

function okResolve(): NonNullable<TargetDeps["resolveTargetImpl"]> {
  return async () => ({ target: resolvedTarget() });
}

function okMaterialize(): NonNullable<TargetDeps["materializeImpl"]> {
  return async () => ({
    ok: true,
    value: { dir: "/work/extract", manifest },
    missingPackedFiles: [],
  });
}

function okBootImpl(boot?: { result: BootResult }): NonNullable<TargetDeps["bootImpl"]> {
  return async () => (boot ?? fakeBoot()).result;
}

function okLocate(id: string | null): NonNullable<TargetDeps["locateImpl"]> {
  return async () => ({ ok: true, plugin: activePlugin(id) });
}

function passScenarioImpl(): NonNullable<TargetDeps["runScenarioImpl"]> {
  return async (suite, scenario) => ({
    name: scenario.name,
    suite: suite.name,
    status: "pass",
    durationMs: 2,
  });
}

function suiteWith(...names: string[]): PluginTestSuite {
  return { name: "unit-suite", scenarios: names.map((name) => ({ name, run: () => {} })) };
}

function passScenario(name: string, suite: string): ScenarioOutcome {
  return { name, suite, status: "pass", durationMs: 1 };
}

function failScenario(name: string, suite: string): ScenarioOutcome {
  return { name, suite, status: "fail", durationMs: 1, error: { message: "boom" } };
}

function passTarget(spec: string): TargetOutcome {
  return {
    spec,
    status: "pass",
    version: "2.1.2",
    host: null,
    checks: [],
    scenarios: [],
    diagnostics: [],
  };
}

function pluginTargetImpl(
  outcome: Partial<TargetOutcome> = {},
): Mock<(input: TargetInput) => Promise<TargetOutcome>> {
  return vi.fn((input: TargetInput): Promise<TargetOutcome> => {
    return Promise.resolve({ ...passTarget(input.spec), ...outcome });
  });
}

describe("defaultCacheDir", () => {
  it("is the shared npm cache under the OS temp dir", () => {
    expect(defaultCacheDir()).toBe(path.join(os.tmpdir(), "opencode-plugin-test-cache"));
  });
});

describe("runTarget — injected-deps failure paths", () => {
  it("fails fast with the resolution error when resolveTargetImpl errors", async () => {
    const error = diag("ENV", "002", "bad target");
    const outcome = await runTarget({
      packageRoot: "/pkg",
      spec: "current",
      config: testConfig(),
      prepackedTarball: null,
      suites: [],
      deps: { resolveTargetImpl: async (): Promise<{ error: Diagnostic }> => ({ error }) },
    });
    expect(outcome).toEqual({
      spec: "current",
      status: "fail",
      version: null,
      host: null,
      checks: [],
      scenarios: [],
      diagnostics: [error],
    });
  });

  it("fails the target when materialization fails and tears the sandbox down", async () => {
    const seen: Array<Parameters<typeof materializePackage>> = [];
    const error = diag("PKG", "001", "synthetic materialize failure");
    const outcome = await runTarget({
      packageRoot: "/pkg",
      spec: "current",
      config: testConfig(),
      prepackedTarball: null,
      suites: [],
      deps: {
        resolveTargetImpl: okResolve(),
        materializeImpl: async (
          ...args: Parameters<typeof materializePackage>
        ): Promise<MaterializeResult> => {
          seen.push(args);
          return { ok: false, error };
        },
      },
    });
    const args = seen[0];
    expect(outcome.status).toBe("fail");
    expect(outcome.version).toBe("2.1.2");
    expect(outcome.host).toBeNull();
    expect(outcome.checks).toEqual([]);
    expect(outcome.diagnostics).toEqual([error]);
    expect(args?.[2]).toMatch(/work$/); // sandbox work dir
    expect(existsSync(args?.[2] ?? "")).toBe(false); // sandbox destroyed by default
  });

  it("fails the target when the host fails to boot", async () => {
    const seen: BootOptions[] = [];
    const error = diag("HOST", "002", "synthetic boot failure");
    const outcome = await runTarget({
      packageRoot: "/pkg",
      spec: "current",
      config: testConfig(),
      prepackedTarball: null,
      suites: [],
      deps: {
        resolveTargetImpl: okResolve(),
        materializeImpl: okMaterialize(),
        bootImpl: async (opts: BootOptions): Promise<BootResult> => {
          seen.push(opts);
          return { ok: false, error, handle: null };
        },
      },
    });
    expect(outcome.status).toBe("fail");
    expect(outcome.version).toBe("2.1.2");
    expect(outcome.host).toBeNull();
    expect(outcome.diagnostics).toEqual([error]);
    expect(seen[0]?.binaryPath).toBe("/bin/opencode");
    expect(existsSync(seen[0]?.cwd ?? "")).toBe(false); // sandbox destroyed by default
  });

  it("fails the target when the plugin cannot be located", async () => {
    const boot = fakeBoot();
    const seen: BootOptions[] = [];
    const error = diag("HOST", "005", "synthetic locate failure");
    const outcome = await runTarget({
      packageRoot: "/pkg",
      spec: "current",
      config: testConfig(),
      prepackedTarball: null,
      suites: [],
      deps: {
        resolveTargetImpl: okResolve(),
        materializeImpl: okMaterialize(),
        bootImpl: async (opts: BootOptions): Promise<BootResult> => {
          seen.push(opts);
          return boot.result;
        },
        locateImpl: async (): Promise<LocateResult> => ({ ok: false, error, plugin: null }),
      },
    });
    expect(outcome.status).toBe("fail");
    expect(outcome.host).toEqual({
      baseUrl: "http://127.0.0.1:59999",
      version: "2.1.2",
      pluginId: null,
    });
    expect(outcome.checks).toEqual([]);
    expect(outcome.diagnostics).toEqual([error]);
    expect(boot.kill).toHaveBeenCalledTimes(1); // stopHost ran
    expect(existsSync(seen[0]?.cwd ?? "")).toBe(false); // sandbox destroyed by default
  });
});

describe("runTarget — real-dependency fallbacks", () => {
  it("falls back to the real resolveTarget when deps are omitted entirely", async () => {
    const outcome = await runTarget({
      packageRoot: "/pkg",
      spec: "not-a-target!",
      config: testConfig(),
      prepackedTarball: null,
      suites: [],
    });
    expect(outcome.status).toBe("fail");
    expect(outcome.diagnostics[0]?.code).toBe("ENV002");
  });

  it("falls back to the real deps when an empty deps object is given", async () => {
    const outcome = await runTarget({
      packageRoot: "/pkg",
      spec: "still-not-valid",
      config: testConfig(),
      prepackedTarball: null,
      suites: [],
      deps: {},
    });
    expect(outcome.status).toBe("fail");
    expect(outcome.diagnostics[0]?.code).toBe("ENV002");
  });

  it("falls back to the real materializePackage (source mode, missing package.json)", async () => {
    const emptyRoot = await trackDir("runner-empty-");
    const outcome = await runTarget({
      packageRoot: emptyRoot,
      spec: "current",
      config: testConfig({ mode: "source" }),
      prepackedTarball: null,
      suites: [],
      deps: { resolveTargetImpl: okResolve() },
    });
    expect(outcome.status).toBe("fail");
    expect(outcome.version).toBe("2.1.2");
    expect(outcome.diagnostics[0]?.code).toBe("PKG001");
  });

  it("falls back to the real bootHost and reports HOST001 when the binary is missing", async () => {
    const missingBinary = path.join(os.tmpdir(), "no-such-opencode-binary-xyz");
    const outcome = await runTarget({
      packageRoot: "/pkg",
      spec: "current",
      config: testConfig({ bootTimeoutMs: 50 }),
      prepackedTarball: null,
      suites: [],
      deps: {
        resolveTargetImpl: async (): Promise<{ target: ResolvedTarget }> => ({
          target: { spec: "current", kind: "current", binaryPath: missingBinary, version: "2.1.2" },
        }),
        materializeImpl: okMaterialize(),
      },
    });
    expect(outcome.status).toBe("fail");
    expect(outcome.host).toBeNull();
    expect(outcome.diagnostics[0]?.code).toBe("HOST001");
  });

  it("falls back to the real locatePlugin and reports HOST005 when nothing matches", async () => {
    const outcome = await runTarget({
      packageRoot: "/pkg",
      spec: "current",
      config: testConfig({ bootTimeoutMs: 50 }),
      prepackedTarball: null,
      suites: [],
      deps: {
        resolveTargetImpl: okResolve(),
        materializeImpl: okMaterialize(),
        bootImpl: okBootImpl(),
      },
    });
    expect(outcome.status).toBe("fail");
    expect(outcome.host).toEqual({
      baseUrl: "http://127.0.0.1:59999",
      version: "2.1.2",
      pluginId: null,
    });
    expect(outcome.diagnostics[0]?.code).toBe("HOST005");
  });

  it("falls back to the real runScenario for every unfiltered scenario", async () => {
    const outcome = await runTarget({
      packageRoot: "/pkg",
      spec: "current",
      config: testConfig(),
      prepackedTarball: null,
      suites: [suiteWith("a", "b")],
      deps: {
        resolveTargetImpl: okResolve(),
        materializeImpl: okMaterialize(),
        bootImpl: okBootImpl(),
        locateImpl: okLocate(null),
      },
    });
    expect(outcome.status).toBe("pass");
    expect(outcome.scenarios.map((s) => s.name)).toEqual(["a", "b"]);
    expect(outcome.scenarios.every((s) => s.status === "pass")).toBe(true);
    expect(outcome.host).toEqual({
      baseUrl: "http://127.0.0.1:59999",
      version: "2.1.2",
      pluginId: null,
    });
  });
});

describe("runTarget — success path and teardown", () => {
  it("runs filtered scenarios with a fully wired context and tears everything down", async () => {
    const boot = fakeBoot();
    const seenMaterialize: Array<Parameters<typeof materializePackage>> = [];
    const seenBoot: BootOptions[] = [];
    const seenLocate: Array<Parameters<typeof locatePlugin>> = [];
    const seenScenario: Array<Parameters<typeof runScenario>> = [];
    const config = testConfig({
      bootTimeoutMs: 1234,
      scenarioTimeoutMs: 4321,
      scenarioFilter: ["a"],
      options: { foo: "bar" },
      expectedPluginId: "my-plugin",
    });
    const outcome = await runTarget({
      packageRoot: "/pkg",
      spec: "current",
      config,
      prepackedTarball: null,
      suites: [suiteWith("a", "b")],
      deps: {
        resolveTargetImpl: okResolve(),
        materializeImpl: async (
          ...args: Parameters<typeof materializePackage>
        ): Promise<MaterializeResult> => {
          seenMaterialize.push(args);
          return { ok: true, value: { dir: "/work/extract", manifest }, missingPackedFiles: [] };
        },
        bootImpl: async (opts: BootOptions): Promise<BootResult> => {
          seenBoot.push(opts);
          return boot.result;
        },
        locateImpl: async (...args: Parameters<typeof locatePlugin>): Promise<LocateResult> => {
          seenLocate.push(args);
          return { ok: true, plugin: activePlugin("my-plugin") };
        },
        runScenarioImpl: async (
          ...args: Parameters<typeof runScenario>
        ): Promise<ScenarioOutcome> => {
          seenScenario.push(args);
          // Exercise the ctx.request seam (nothing listens on the fake host port).
          await args[2].request("/ping").catch(() => {});
          return { name: args[1].name, suite: args[0].name, status: "pass", durationMs: 2 };
        },
      },
    });

    // materialize received the sandbox work dir and no prepacked tarball.
    expect(seenMaterialize[0]?.[2]).toMatch(/work$/);
    expect(seenMaterialize[0]?.[5]).toBeUndefined();
    // boot received the sandbox project dir and the sandbox host env.
    expect(seenBoot[0]?.cwd).toMatch(/project$/);
    expect(seenBoot[0]?.env).toBeTypeOf("object");
    // locate received the boot server, materialized dir, expected id and timeout.
    const server: ServerRef | undefined = boot.result.ok ? boot.result.host.server : undefined;
    expect(seenLocate[0]?.[0]).toEqual(server);
    expect(seenLocate[0]?.[1]).toBe("/work/extract");
    expect(seenLocate[0]?.[2]).toBe("my-plugin");
    expect(seenLocate[0]?.[3]).toBe(1234);

    // Exactly the unfiltered scenario ran, with a wired ScenarioContext.
    expect(seenScenario).toHaveLength(1);
    const ctx: ScenarioContext | undefined = seenScenario[0]?.[2];
    expect(seenScenario[0]?.[3]).toBe(4321);
    expect(ctx?.suite).toBe("unit-suite");
    expect(ctx?.scenario).toBe("a");
    expect(ctx?.target).toEqual(resolvedTarget());
    expect(ctx?.plugin).toEqual(activePlugin("my-plugin"));
    expect(ctx?.server.baseUrl).toBe("http://127.0.0.1:59999");
    expect(ctx?.paths.project).toBe(seenBoot[0]?.cwd);
    expect(ctx?.options).toEqual({ foo: "bar" });
    expect(typeof ctx?.request).toBe("function");
    expect(typeof ctx?.pluginStatus).toBe("function");

    expect(outcome).toEqual({
      spec: "current",
      status: "pass",
      version: "2.1.2",
      host: { baseUrl: "http://127.0.0.1:59999", version: "2.1.2", pluginId: "my-plugin" },
      checks: [
        { name: "packed-artifact", status: "pass", diagnostics: [] },
        { name: "plugin-registration", status: "pass", diagnostics: [] },
      ],
      scenarios: [{ name: "a", suite: "unit-suite", status: "pass", durationMs: 2 }],
      diagnostics: [],
    });
    expect(boot.kill).toHaveBeenCalledTimes(1); // stopHost ran
    expect(existsSync(seenBoot[0]?.cwd ?? "")).toBe(false); // sandbox destroyed by default
  });

  it("keeps the sandbox alive when keepSandbox is set", async () => {
    const boot = fakeBoot();
    const seen: BootOptions[] = [];
    const outcome = await runTarget({
      packageRoot: "/pkg",
      spec: "current",
      config: testConfig({ keepSandbox: true }),
      prepackedTarball: null,
      suites: [suiteWith("a")],
      deps: {
        resolveTargetImpl: okResolve(),
        materializeImpl: okMaterialize(),
        bootImpl: async (opts: BootOptions): Promise<BootResult> => {
          seen.push(opts);
          return boot.result;
        },
        locateImpl: okLocate("my-plugin"),
        runScenarioImpl: passScenarioImpl(),
      },
    });
    expect(outcome.status).toBe("pass");
    expect(boot.kill).toHaveBeenCalledTimes(1); // host still stopped
    expect(existsSync(seen[0]?.cwd ?? "")).toBe(true); // sandbox NOT destroyed
    expect(dirMocks.removeDir).not.toHaveBeenCalled();
  });

  it("fails the packed-artifact check when declared files are missing from the tarball", async () => {
    let seenTarball: string | undefined;
    const outcome = await runTarget({
      packageRoot: "/pkg",
      spec: "current",
      config: testConfig(),
      prepackedTarball: "/prepacked/fake.tgz",
      suites: [suiteWith("a")],
      deps: {
        resolveTargetImpl: okResolve(),
        materializeImpl: async (
          ...args: Parameters<typeof materializePackage>
        ): Promise<MaterializeResult> => {
          seenTarball = args[5];
          return {
            ok: true,
            value: { dir: "/work/extract", manifest },
            missingPackedFiles: ["index.js"],
          };
        },
        bootImpl: okBootImpl(),
        locateImpl: okLocate("my-plugin"),
        runScenarioImpl: passScenarioImpl(),
      },
    });
    expect(seenTarball).toBe("/prepacked/fake.tgz");
    expect(outcome.status).toBe("fail");
    // Registration passed, so scenarios still ran; the failure lives in the check.
    expect(outcome.scenarios).toHaveLength(1);
    expect(outcome.diagnostics).toEqual([]);
    const artifact = outcome.checks[0];
    expect(artifact?.name).toBe("packed-artifact");
    expect(artifact?.status).toBe("fail");
    expect(artifact?.diagnostics[0]?.code).toBe("PKG007");
    expect(outcome.checks[1]?.name).toBe("plugin-registration");
  });

  it("aggregates failing scenarios into the target status and null plugin id", async () => {
    const outcome = await runTarget({
      packageRoot: "/pkg",
      spec: "current",
      config: testConfig(),
      prepackedTarball: null,
      suites: [suiteWith("a", "b")],
      deps: {
        resolveTargetImpl: okResolve(),
        materializeImpl: okMaterialize(),
        bootImpl: okBootImpl(),
        locateImpl: okLocate(null), // plugin without id
        runScenarioImpl: async (suite, scenario) => failScenario(scenario.name, suite.name),
      },
    });
    expect(outcome.status).toBe("fail");
    expect(outcome.scenarios).toHaveLength(2);
    expect(outcome.scenarios.every((s) => s.status === "fail")).toBe(true);
    expect(outcome.host).toEqual({
      baseUrl: "http://127.0.0.1:59999",
      version: "2.1.2",
      pluginId: null,
    });
  });

  it("short-circuits scenarios when plugin registration fails", async () => {
    const runScenario = vi.fn(passScenarioImpl());
    const failedPlugin: PluginInfo = {
      id: "bad-plugin",
      source: { type: "local", path: "/work/extract" },
      features: { server: true },
      state: { status: "failed", error: "setup exploded" },
    };
    const outcome = await runTarget({
      packageRoot: "/pkg",
      spec: "current",
      config: testConfig(),
      prepackedTarball: null,
      suites: [suiteWith("a")],
      deps: {
        resolveTargetImpl: okResolve(),
        materializeImpl: okMaterialize(),
        bootImpl: okBootImpl(),
        locateImpl: async (): Promise<LocateResult> => ({ ok: true, plugin: failedPlugin }),
        runScenarioImpl: runScenario,
      },
    });
    expect(outcome.status).toBe("fail");
    expect(outcome.scenarios).toEqual([]);
    expect(runScenario).not.toHaveBeenCalled();
    const registration = outcome.checks[1];
    expect(registration?.name).toBe("plugin-registration");
    expect(registration?.status).toBe("fail");
    expect(registration?.diagnostics[0]?.code).toBe("HOST006");
    expect(outcome.host).toEqual({
      baseUrl: "http://127.0.0.1:59999",
      version: "2.1.2",
      pluginId: "bad-plugin",
    });
  });

  it("fails registration when a declared surface is missing (plugin without id)", async () => {
    const plugin: PluginInfo = {
      source: { type: "local", path: "/work/extract" },
      features: {}, // "server" surface declared in config is missing
      state: { status: "active" },
    };
    const outcome = await runTarget({
      packageRoot: "/pkg",
      spec: "current",
      config: testConfig(),
      prepackedTarball: null,
      suites: [suiteWith("a")],
      deps: {
        resolveTargetImpl: okResolve(),
        materializeImpl: okMaterialize(),
        bootImpl: okBootImpl(),
        locateImpl: async (): Promise<LocateResult> => ({ ok: true, plugin }),
        runScenarioImpl: passScenarioImpl(),
      },
    });
    expect(outcome.status).toBe("fail");
    expect(outcome.scenarios).toEqual([]);
    const registration = outcome.checks[1];
    expect(registration?.diagnostics[0]?.code).toBe("HOST007");
    expect(outcome.host).toEqual({
      baseUrl: "http://127.0.0.1:59999",
      version: "2.1.2",
      pluginId: null,
    });
  });
});

describe("runPluginTests — config resolution", () => {
  it("uses cwd as the default package root and fails on a missing manifest", async () => {
    const root = await trackDir("runner-empty-");
    const repoCwd = process.cwd();
    process.chdir(root);
    try {
      const result = await runPluginTests();
      // macOS reports cwd under the resolved /private prefix.
      expect(result.packageRoot).toBe(realpathSync(root));
      expect(result.mode).toBe("packed");
      expect(result.status).toBe("fail");
      expect(result.diagnostics[0]?.code).toBe("PKG001");
      expect(result.targets).toEqual([]);
      expect(result.packageChecks).toEqual([]);
    } finally {
      process.chdir(repoCwd);
    }
  });

  it("fails the run when the config file is not valid JSON (CFG001)", async () => {
    const root = await makePackageRoot({ "plugin-test.config.json": "{oops" });
    const result = await runPluginTests({ packageRoot: root });
    expect(result.status).toBe("fail");
    expect(result.targets).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe("CFG001");
    expect(result.diagnostics[0]?.message).toContain("not valid JSON");
    expect(result.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.durationMs).toBeTypeOf("number");
    expect(dirMocks.removeDir).not.toHaveBeenCalled(); // fails before the run sandbox exists
  });

  it("tolerates a missing default config file and loads scenarios from the config", async () => {
    const root = await makePackageRoot({
      "package.json": GOOD_PACKAGE_JSON,
      "plugin-test.config.json": JSON.stringify({
        targets: ["current"],
        mode: "source",
        scenarios: "./scenarios.js",
      }),
      "scenarios.js": `export default { name: "file-suite", scenarios: [{ name: "file-scenario", run() {} }] };\n`,
    });
    const captured: TargetInput[] = [];
    const impl = vi.fn((input: TargetInput): Promise<TargetOutcome> => {
      captured.push(input);
      return Promise.resolve({
        ...passTarget(input.spec),
        scenarios: [passScenario("file-scenario", "file-suite")],
      });
    });
    const events: RunEvent[] = [];
    const result = await runPluginTests({
      packageRoot: root,
      runTargetImpl: impl,
      onEvent: (e) => events.push(e),
    });
    expect(result.status).toBe("pass");
    expect(result.mode).toBe("source");
    const input = firstArg(impl);
    expect(input.config.targets).toEqual(["current"]);
    expect(input.config.mode).toBe("source");
    expect(input.config.scenarios).toBe("./scenarios.js");
    expect(input.suites).toHaveLength(1);
    expect(input.suites[0]?.name).toBe("file-suite");
    expect(input.suites[0]?.scenarios[0]?.name).toBe("file-scenario");
    expect(events).toEqual([
      { kind: "phase", target: "current", phase: "target-start" },
      { kind: "scenario", target: "current", name: "file-scenario", status: "pass" },
      { kind: "phase", target: "current", phase: "target-end" },
    ]);
  });

  it("fails the run when the configured scenario module cannot be loaded (SCEN003)", async () => {
    const root = await makePackageRoot({
      "package.json": GOOD_PACKAGE_JSON,
      "plugin-test.config.json": JSON.stringify({
        targets: ["current"],
        mode: "source",
        scenarios: "./does-not-exist.js",
      }),
    });
    const result = await runPluginTests({ packageRoot: root });
    expect(result.status).toBe("fail");
    expect(result.targets).toEqual([]);
    expect(result.packageChecks).toHaveLength(1); // manifest check ran
    expect(result.diagnostics[0]?.code).toBe("SCEN003");
    expect(result.diagnostics[0]?.message).toContain("could not load scenario module");
  });
});

describe("runPluginTests — manifest and artifact gates", () => {
  it("fails the run when the manifest cannot be read (PKG001)", async () => {
    const root = await trackDir("runner-empty-");
    const result = await runPluginTests({ packageRoot: root, overrides: { mode: "source" } });
    expect(result.status).toBe("fail");
    expect(result.mode).toBe("source");
    expect(result.targets).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe("PKG001");
    expect(dirMocks.removeDir).toHaveBeenCalledTimes(1); // run sandbox still cleaned up
  });

  it("surfaces manifest warnings as a warn run status", async () => {
    const root = await makePackageRoot({
      "package.json": JSON.stringify({
        name: "p",
        version: "1.0.0",
        type: "commonjs", // PKG012 warning, not fatal
        exports: { ".": "./index.js" },
      }),
    });
    const result = await runPluginTests({
      packageRoot: root,
      overrides: { mode: "source" },
      runTargetImpl: pluginTargetImpl(),
    });
    expect(result.packageChecks[0]?.status).toBe("warn");
    expect(result.diagnostics.map((d) => d.code)).toContain("PKG012");
    expect(result.status).toBe("warn");
  });
});

describe("runPluginTests — packed mode with a fake npm", () => {
  it("packs once, shares the tarball, and emits pack/target/scenario events", async () => {
    const root = await makePackageRoot({ "package.json": GOOD_PACKAGE_JSON });
    const tarball = await makeTarball({
      "package/package.json": "{}",
      "package/index.js": "export default {};",
    });
    await useFakeNpm(tarball, null);
    const targetDeps: TargetDeps = {};
    const captured: TargetInput[] = [];
    const impl = vi.fn((input: TargetInput): Promise<TargetOutcome> => {
      captured.push(input);
      return Promise.resolve({
        ...passTarget(input.spec),
        scenarios: [passScenario("greets", "greeting")],
      });
    });
    const events: RunEvent[] = [];
    const result = await runPluginTests({
      packageRoot: root,
      suites: [suiteWith("greets")],
      runTargetImpl: impl,
      targetDeps,
      onEvent: (e) => events.push(e),
    });
    expect(impl).toHaveBeenCalledTimes(1);
    const input = firstArg(impl);
    expect(input.packageRoot).toBe(root);
    expect(input.config.mode).toBe("packed");
    expect(input.suites).toHaveLength(1);
    expect(input.deps).toBe(targetDeps);
    expect(typeof input.prepackedTarball).toBe("string");
    expect(input.prepackedTarball?.endsWith("fake.tgz")).toBe(true);
    expect(events).toEqual([
      { kind: "phase", target: "*", phase: "pack" },
      { kind: "phase", target: "current", phase: "target-start" },
      { kind: "scenario", target: "current", name: "greets", status: "pass" },
      { kind: "phase", target: "current", phase: "target-end" },
    ]);
    expect(result.status).toBe("pass");
    expect(result.mode).toBe("packed");
    expect(result.packageChecks.map((c) => c.name)).toEqual([
      "package-manifest",
      "packed-artifact",
    ]);
    expect(result.packageChecks.every((c) => c.status === "pass")).toBe(true);
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]?.scenarios).toEqual([passScenario("greets", "greeting")]);
    expect(result.diagnostics).toEqual([]);
  });

  it("fails the run via PKG007 when the packed artifact misses declared files", async () => {
    const root = await makePackageRoot({ "package.json": GOOD_PACKAGE_JSON });
    const tarball = await makeTarball({ "package/package.json": "{}" }); // index.js missing
    await useFakeNpm(tarball, null);
    const impl = pluginTargetImpl();
    const result = await runPluginTests({ packageRoot: root, runTargetImpl: impl });
    expect(impl).toHaveBeenCalledTimes(1); // targets still ran
    const artifact = result.packageChecks[1];
    expect(artifact?.name).toBe("packed-artifact");
    expect(artifact?.status).toBe("fail");
    expect(artifact?.diagnostics[0]?.code).toBe("PKG007");
    expect(result.status).toBe("fail");
    expect(result.targets).toHaveLength(1);
  });

  it("fails the run via PKG008 when npm pack fails", async () => {
    const root = await makePackageRoot({ "package.json": GOOD_PACKAGE_JSON });
    await useFakeNpm(null, "3");
    const impl = pluginTargetImpl();
    const events: RunEvent[] = [];
    const result = await runPluginTests({
      packageRoot: root,
      runTargetImpl: impl,
      onEvent: (e) => events.push(e),
    });
    expect(impl).not.toHaveBeenCalled();
    expect(result.status).toBe("fail");
    expect(result.packageChecks).toHaveLength(1); // manifest check only
    expect(result.diagnostics[0]?.code).toBe("PKG008");
    expect(result.diagnostics[0]?.message).toContain("npm pack failed with exit code 3");
    expect(events).toEqual([{ kind: "phase", target: "*", phase: "pack" }]);
  });

  it("fails the run via PKG010 when the pack output cannot be inspected", async () => {
    const root = await makePackageRoot({ "package.json": GOOD_PACKAGE_JSON });
    await useFakeNpm(null, null); // prints ghost.tgz but never creates it
    const impl = pluginTargetImpl();
    const result = await runPluginTests({ packageRoot: root, runTargetImpl: impl });
    expect(impl).not.toHaveBeenCalled();
    expect(result.status).toBe("fail");
    expect(result.packageChecks).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("PKG010");
  });
});

describe("runPluginTests — targets and aggregation", () => {
  it("falls back to the real runTarget and fails for an unresolvable target spec", async () => {
    const root = await makePackageRoot({ "package.json": GOOD_PACKAGE_JSON });
    const events: RunEvent[] = [];
    const result = await runPluginTests({
      packageRoot: root,
      overrides: { mode: "source", targets: ["bogus-spec"] },
      onEvent: (e) => events.push(e),
    });
    expect(result.status).toBe("fail");
    expect(result.targets).toHaveLength(1);
    const target = result.targets[0];
    expect(target?.spec).toBe("bogus-spec");
    expect(target?.status).toBe("fail");
    expect(target?.version).toBeNull();
    expect(target?.host).toBeNull();
    expect(target?.diagnostics[0]?.code).toBe("ENV002");
    expect(result.diagnostics.map((d) => d.code)).toContain("ENV002");
    expect(events).toEqual([
      { kind: "phase", target: "bogus-spec", phase: "target-start" },
      { kind: "phase", target: "bogus-spec", phase: "target-end" },
    ]);
  });

  it("aggregates target failure statuses and scenario events", async () => {
    const root = await makePackageRoot({ "package.json": GOOD_PACKAGE_JSON });
    const impl = pluginTargetImpl({
      status: "fail",
      scenarios: [failScenario("broken", "greeting")],
    });
    const events: RunEvent[] = [];
    const result = await runPluginTests({
      packageRoot: root,
      overrides: { mode: "source" },
      runTargetImpl: impl,
      onEvent: (e) => events.push(e),
    });
    expect(result.status).toBe("fail"); // worstRunStatus over target statuses
    expect(result.targets[0]?.scenarios).toEqual([failScenario("broken", "greeting")]);
    expect(events).toEqual([
      { kind: "phase", target: "current", phase: "target-start" },
      { kind: "scenario", target: "current", name: "broken", status: "fail" },
      { kind: "phase", target: "current", phase: "target-end" },
    ]);
  });

  it("does not remove the run sandbox when keepSandbox is set", async () => {
    const root = await makePackageRoot({ "package.json": GOOD_PACKAGE_JSON });
    const result = await runPluginTests({
      packageRoot: root,
      overrides: { mode: "source", keepSandbox: true },
      runTargetImpl: pluginTargetImpl(),
    });
    expect(result.status).toBe("pass");
    expect(dirMocks.removeDir).not.toHaveBeenCalled();
  });
});
