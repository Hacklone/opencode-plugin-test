import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { INIT_EXIT_CODES, runInit } from "../src/cli/init.js";
import { diag, exitCodeForDiagnostics } from "../src/domain/diagnostics.js";
import type { RunResult } from "../src/domain/types.js";
import { renderReport } from "../src/reporters/index.js";
import type { RunEvent, RunPluginTestsOptions } from "../src/runner/run.js";

// Guard against the CLI auto-run at module bottom: set before the dynamic import.
process.env["OPT_ENTRY"] = "test";

// ownVersion() reads package.json via createRequire; the mock lets a test swap
// in a package.json without a version field to cover the "0.0.0" fallback.
const pkgMock = vi.hoisted(() => ({ fakePackageJson: false }));
vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  const realCreateRequire = actual.createRequire;
  const fakeCreateRequire = ((...args: Parameters<typeof realCreateRequire>) => {
    const req = realCreateRequire(...args);
    return ((id: string) => {
      if (pkgMock.fakePackageJson && id.endsWith("package.json")) {
        return { name: "mocked", version: undefined };
      }
      return req(id);
    }) as unknown as typeof req;
  }) as typeof realCreateRequire;
  return { ...actual, createRequire: fakeCreateRequire };
});

const { main } = await import("../src/cli/bin.js");

function run(overrides: Partial<RunResult> = {}): RunResult {
  return {
    packageRoot: "/repo",
    mode: "packed",
    startedAt: "2026-10-28T00:00:00.000Z",
    durationMs: 10,
    packageChecks: [],
    targets: [
      {
        spec: "current",
        status: "pass",
        version: "2.1.2",
        host: null,
        checks: [],
        scenarios: [],
        diagnostics: [],
      },
    ],
    status: "pass",
    diagnostics: [],
    ...overrides,
  };
}

function failRun(): RunResult {
  return run({ status: "fail", diagnostics: [diag("SCEN", "001", "scenario failed")] });
}

/** Capture console.log (stdout) and console.error (stderr); restored by afterEach. */
function captureConsole(): { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(" "));
  });
  return { logs, errors };
}

function fakeRunImpl(
  impl: (options?: RunPluginTestsOptions) => Promise<RunResult>,
): Mock<(options?: RunPluginTestsOptions) => Promise<RunResult>> {
  return vi.fn(async (options?: RunPluginTestsOptions): Promise<RunResult> => impl(options));
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env["OPT_VERBOSE"];
});

describe("bin main() — help/version", () => {
  it("--help prints usage and exits 0", async () => {
    const { logs } = captureConsole();
    const code = await main(["--help"]);
    expect(code).toBe(0);
    expect(logs[0]).toContain("Usage:");
    expect(logs[0]).toContain("opencode-plugin-test");
    expect(logs[0]).toContain("--reporter <format>");
  });

  it("--version prints the version and exits 0", async () => {
    const { logs } = captureConsole();
    const code = await main(["--version"]);
    expect(code).toBe(0);
    expect(logs[0]).toBe("@coool/opencode-plugin-test v0.1.0");
  });

  it("falls back to 0.0.0 when the required package.json has no version field", async () => {
    const { logs } = captureConsole();
    pkgMock.fakePackageJson = true;
    try {
      const code = await main(["--version"]);
      expect(code).toBe(0);
      expect(logs[0]).toBe("@coool/opencode-plugin-test v0.0.0");
    } finally {
      pkgMock.fakePackageJson = false;
    }
  });
});

describe("bin main() — invocation errors", () => {
  it("rejects more than one positional with exit code 2 and usage on stderr", async () => {
    const { errors } = captureConsole();
    const code = await main(["pkg-a", "pkg-b"]);
    expect(code).toBe(2);
    expect(errors[0]).toContain("Usage:");
    // CFG-family diagnostics map to the invocation exit code.
    expect(exitCodeForDiagnostics([diag("CFG", "003", "invalid CLI invocation")])).toBe(2);
  });

  it("rejects an invalid reporter with exit code 2", async () => {
    const { errors } = captureConsole();
    const code = await main([".", "--reporter", "yaml"]);
    expect(code).toBe(2);
    expect(errors[0]).toContain("Usage:");
  });

  it("rejects a non-numeric boot timeout with exit code 2", async () => {
    const { errors } = captureConsole();
    expect(await main([".", "--boot-timeout-ms", "abc"])).toBe(2);
    expect(errors[0]).toContain("Usage:");
  });

  it("rejects a non-positive scenario timeout with exit code 2", async () => {
    const { errors } = captureConsole();
    // parseArgs rejects a bare "-5" argument as ambiguous, so use the "=" form.
    expect(await main([".", "--scenario-timeout-ms=-5"])).toBe(2);
    expect(errors[0]).toContain("Usage:");
  });
});

describe("bin main() — --init", () => {
  it("creates the config and scenarios template in a temp dir and exits 0", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cli-init-"));
    const { logs } = captureConsole();
    const code = await main(["--init", dir]);
    expect(code).toBe(0);
    const config = JSON.parse(
      await readFile(path.join(dir, "plugin-test.config.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(config["targets"]).toEqual(["current"]);
    expect(config["mode"]).toBe("packed");
    expect(config["reporter"]).toBe("pretty");
    const scenarios = await readFile(path.join(dir, "plugin-test.scenarios.ts"), "utf8");
    expect(scenarios).toContain("definePluginTestSuite");
    expect(
      logs.some((l) => l.startsWith(`wrote ${path.join(dir, "plugin-test.config.json")}`)),
    ).toBe(true);
    expect(
      logs.some((l) => l.startsWith(`wrote ${path.join(dir, "plugin-test.scenarios.ts")}`)),
    ).toBe(true);
  });

  it("skips existing files with a notice on a second run", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cli-init-"));
    captureConsole();
    expect(await main(["--init", dir])).toBe(0);
    const { logs } = captureConsole();
    expect(await main(["--init", dir])).toBe(0);
    const notices = logs.filter((l) => l.endsWith("already exists; leaving it untouched."));
    expect(notices).toHaveLength(2);
    expect(notices.every((l) => l.startsWith(path.join(dir, "plugin-test.")))).toBe(true);
    expect(logs.some((l) => l.startsWith("wrote "))).toBe(false);
  });

  it("treats '.' as the cwd: templates land in cwd and the hint omits the dir", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cli-init-dot-"));
    const prevCwd = process.cwd();
    process.chdir(dir);
    const { logs } = captureConsole();
    try {
      expect(await runInit(".")).toBe(INIT_EXIT_CODES.ok);
    } finally {
      process.chdir(prevCwd);
    }
    // The templates were written into the (temp) cwd.
    await readFile(path.join(dir, "plugin-test.config.json"), "utf8");
    await readFile(path.join(dir, "plugin-test.scenarios.ts"), "utf8");
    // With dir === "." the "Run:" hint carries no directory suffix.
    const finalLog = logs[logs.length - 1] ?? "";
    expect(finalLog).toContain("3. Run: opencode-plugin-test");
    expect(finalLog.endsWith("opencode-plugin-test")).toBe(true);
  });

  // A bare `--init` defaults to the current directory: parseCli normalizes it
  // into `--init=.` before the strict parse, so parseArgs never sees a
  // missing argument.
  it("accepts a bare --init and defaults to the current directory", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cli-bare-init-"));
    const previousCwd = process.cwd();
    process.chdir(dir);
    try {
      const exit = await main(["--init"]);
      expect(exit).toBe(0);
      expect(existsSync(path.join(dir, "plugin-test.config.json"))).toBe(true);
      expect(existsSync(path.join(dir, "plugin-test.scenarios.ts"))).toBe(true);
    } finally {
      process.chdir(previousCwd);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("bin main() — run path", () => {
  it("prints the pretty report to stdout and exits 0 on a passing run", async () => {
    const { logs } = captureConsole();
    const source = run();
    const runImpl = fakeRunImpl(async () => source);
    const code = await main(["/repo"], { runImpl });
    expect(code).toBe(0);
    expect(logs[0]).toBe(renderReport(source, "pretty"));
  });

  it("propagates the run exit code for a failing run", async () => {
    const { logs } = captureConsole();
    const runImpl = fakeRunImpl(async () => failRun());
    const code = await main(["/repo"], { runImpl });
    expect(code).toBe(1);
    expect(logs[0]).toContain("FAIL");
  });

  it("writes the report to --output instead of stdout", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cli-run-"));
    const out = path.join(dir, "report.xml");
    const { logs } = captureConsole();
    const source = failRun();
    const runImpl = fakeRunImpl(async () => source);
    const code = await main([dir, "--reporter", "junit", "--output", out], { runImpl });
    expect(code).toBe(1);
    const content = await readFile(out, "utf8");
    expect(content).toBe(`${renderReport(source, "junit")}\n`);
    expect(logs.some((l) => l.includes("<testsuites"))).toBe(false);
  });

  it("passes --packed/--source/--target and other flags into the overrides", async () => {
    const runImpl = fakeRunImpl(async () => run());
    await main(
      [
        "/repo",
        "--target",
        "current",
        "--target",
        "latest",
        "--packed",
        "--scenario",
        "a",
        "--boot-timeout-ms",
        "1000",
        "--scenario-timeout-ms",
        "2000",
        "--keep-sandbox",
      ],
      { runImpl },
    );
    const call = runImpl.mock.calls[0];
    if (call === undefined) {
      throw new Error("runImpl was not called");
    }
    const options: RunPluginTestsOptions | undefined = call[0];
    expect(options?.packageRoot).toBe("/repo");
    expect(options?.overrides).toMatchObject({
      targets: ["current", "latest"],
      mode: "packed",
      scenarioFilter: ["a"],
      bootTimeoutMs: 1000,
      scenarioTimeoutMs: 2000,
      keepSandbox: true,
    });
  });

  it("--source sets the source mode override", async () => {
    const runImpl = fakeRunImpl(async () => run());
    await main(["/repo", "--source"], { runImpl });
    const call = runImpl.mock.calls[0];
    if (call === undefined) {
      throw new Error("runImpl was not called");
    }
    expect(call[0]?.overrides?.mode).toBe("source");
  });

  // --config is parsed (configPath) and the default runImpl is the real
  // runPluginTests: on an empty package root it fails fast on the manifest
  // check (PKG001) with no packing, spawning, or network.
  it("parses --config and falls back to the real runPluginTests without runImpl", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cli-realrun-"));
    const { logs } = captureConsole();
    const code = await main([dir, "--config", path.join(dir, "plugin-test.config.json")]);
    expect(code).toBe(1);
    expect(logs[0]).toContain("FAIL");
  });

  it("emits phase events to stderr under OPT_VERBOSE", async () => {
    const { errors } = captureConsole();
    const runImpl = fakeRunImpl(async (options?: RunPluginTestsOptions) => {
      const onEvent = options?.onEvent;
      const events: RunEvent[] = [
        { kind: "phase", target: "current", phase: "target-start" },
        { kind: "phase", target: "*", phase: "pack" },
        { kind: "scenario", target: "current", name: "greets", status: "pass" },
      ];
      for (const e of events) {
        onEvent?.(e);
      }
      return run();
    });
    process.env["OPT_VERBOSE"] = "1";
    try {
      await main(["/repo"], { runImpl });
    } finally {
      delete process.env["OPT_VERBOSE"];
    }
    expect(errors).toContain("[current] target-start");
    expect(errors).toContain("[*] pack");
    // Only phase events are logged, not scenario events.
    expect(errors.some((e) => e.includes("scenario"))).toBe(false);
  });
});

describe("init INIT_EXIT_CODES", () => {
  it("exports the ok/bad exit codes", () => {
    expect(INIT_EXIT_CODES).toEqual({ ok: 0, bad: 2 });
  });
});
