import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyCliOverrides,
  CONFIG_FILE_NAME,
  DEFAULT_CONFIG,
  defaultConfigPath,
  readConfigFile,
  validateConfig,
} from "../src/domain/config.js";

describe("validateConfig", () => {
  it("accepts an empty object and returns defaults", () => {
    const result = validateConfig({});
    expect("config" in result && result.config).toEqual({ ...DEFAULT_CONFIG });
  });

  it("rejects non-object roots", () => {
    for (const bad of [null, "str", 42, []]) {
      const result = validateConfig(bad);
      expect("error" in result).toBe(true);
    }
  });

  it("validates targets", () => {
    expect(validateConfig({ targets: ["current"] })).toHaveProperty("config");
    expect(validateConfig({ targets: [] })).toHaveProperty("error");
    expect(validateConfig({ targets: ["current", 5] })).toHaveProperty("error");
    expect(validateConfig({ targets: "x" })).toHaveProperty("error");
  });

  it("validates mode", () => {
    expect(validateConfig({ mode: "source" })).toHaveProperty("config");
    expect(validateConfig({ mode: "nope" })).toHaveProperty("error");
  });

  it("validates surfaces", () => {
    expect(validateConfig({ surfaces: ["server", "tui", "rpc"] })).toHaveProperty("config");
    expect(validateConfig({ surfaces: ["bananas"] })).toHaveProperty("error");
    expect(validateConfig({ surfaces: 1 })).toHaveProperty("error");
  });

  it("validates scenarios", () => {
    expect(validateConfig({ scenarios: "./x.ts" })).toHaveProperty("config");
    expect(validateConfig({ scenarios: null })).toHaveProperty("config");
    expect(validateConfig({ scenarios: 7 })).toHaveProperty("error");
  });

  it("validates scenarioFilter", () => {
    expect(validateConfig({ scenarioFilter: ["a"] })).toHaveProperty("config");
    expect(validateConfig({ scenarioFilter: [3] })).toHaveProperty("error");
  });

  it("validates timeouts", () => {
    expect(
      validateConfig({
        bootTimeoutMs: 100,
        scenarioTimeoutMs: 100,
        packTimeoutMs: 100,
        installTimeoutMs: 100,
      }),
    ).toHaveProperty("config");
    expect(validateConfig({ bootTimeoutMs: 0 })).toHaveProperty("error");
    expect(validateConfig({ scenarioTimeoutMs: -1 })).toHaveProperty("error");
    expect(validateConfig({ packTimeoutMs: "x" })).toHaveProperty("error");
    expect(validateConfig({ installTimeoutMs: Number.NaN })).toHaveProperty("error");
  });

  it("validates reporter", () => {
    expect(validateConfig({ reporter: "json" })).toHaveProperty("config");
    expect(validateConfig({ reporter: "csv" })).toHaveProperty("error");
  });

  it("validates keepSandbox", () => {
    expect(validateConfig({ keepSandbox: true })).toHaveProperty("config");
    expect(validateConfig({ keepSandbox: "yes" })).toHaveProperty("error");
  });

  it("validates options", () => {
    expect(validateConfig({ options: { a: 1 } })).toHaveProperty("config");
    expect(validateConfig({ options: [1] })).toHaveProperty("error");
  });

  it("validates expectedPluginId", () => {
    expect(validateConfig({ expectedPluginId: "x" })).toHaveProperty("config");
    expect(validateConfig({ expectedPluginId: null })).toHaveProperty("config");
    expect(validateConfig({ expectedPluginId: 3 })).toHaveProperty("error");
  });

  it("reports unknown keys and merges everything", () => {
    const result = validateConfig({ nonsense: true, targets: ["2.1.2"], bootTimeoutMs: 5 });
    if ("error" in result) {
      expect(result.error.message).toContain("unknown key(s): nonsense");
    } else {
      expect.unreachable();
    }
  });

  it("clones arrays defensively", () => {
    const targets = ["current"];
    const result = validateConfig({ targets });
    if ("config" in result) {
      targets.push("latest");
      expect(result.config.targets).toEqual(["current"]);
    } else {
      expect.unreachable();
    }
  });
});

describe("readConfigFile", () => {
  it("reads a valid file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cfg-"));
    const file = path.join(dir, CONFIG_FILE_NAME);
    await writeFile(file, JSON.stringify({ targets: ["latest"] }));
    const result = await readConfigFile(file);
    expect("config" in result && result.config.targets).toEqual(["latest"]);
  });

  it("reports unreadable files", async () => {
    const result = await readConfigFile("/nonexistent/config.json");
    expect("error" in result && result.error.code).toBe("CFG002");
  });

  it("reports invalid JSON", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cfg-"));
    const file = path.join(dir, "bad.json");
    await writeFile(file, "{nope");
    const result = await readConfigFile(file);
    expect("error" in result && result.error.code).toBe("CFG001");
  });

  it("reports schema violations with the file path", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cfg-"));
    const file = path.join(dir, "bad.json");
    await writeFile(file, JSON.stringify({ mode: "weird" }));
    const result = await readConfigFile(file);
    if ("error" in result) {
      expect(result.error.code).toBe("CFG001");
      expect(result.error.message).toContain(file);
    } else {
      expect.unreachable();
    }
  });

  it("exposes the default config path", () => {
    expect(defaultConfigPath("/root")).toBe(`/root/${CONFIG_FILE_NAME}`);
  });
});

describe("applyCliOverrides", () => {
  it("applies only provided overrides", () => {
    const merged = applyCliOverrides(
      { ...DEFAULT_CONFIG },
      { mode: "source", targets: ["2.0.32"] },
    );
    expect(merged.mode).toBe("source");
    expect(merged.targets).toEqual(["2.0.32"]);
    expect(merged.reporter).toBe(DEFAULT_CONFIG.reporter);
  });

  it("returns the base untouched without overrides", () => {
    expect(applyCliOverrides({ ...DEFAULT_CONFIG })).toEqual({ ...DEFAULT_CONFIG });
  });

  it("leaves unset override fields at their base values", () => {
    const merged = applyCliOverrides({ ...DEFAULT_CONFIG }, { reporter: "json" });
    expect(merged.reporter).toBe("json");
    // targets/mode/scenarioFilter/timeouts/keepSandbox were not overridden.
    expect(merged.targets).toEqual(DEFAULT_CONFIG.targets);
    expect(merged.mode).toBe(DEFAULT_CONFIG.mode);
    expect(merged.scenarioFilter).toEqual(DEFAULT_CONFIG.scenarioFilter);
    expect(merged.bootTimeoutMs).toBe(DEFAULT_CONFIG.bootTimeoutMs);
    expect(merged.scenarioTimeoutMs).toBe(DEFAULT_CONFIG.scenarioTimeoutMs);
    expect(merged.keepSandbox).toBe(DEFAULT_CONFIG.keepSandbox);
  });

  it("applies every override field when set", () => {
    const merged = applyCliOverrides(
      { ...DEFAULT_CONFIG },
      {
        targets: ["2.1.2"],
        mode: "source",
        reporter: "junit",
        scenarioFilter: ["only-this"],
        bootTimeoutMs: 1_000,
        scenarioTimeoutMs: 2_000,
        keepSandbox: true,
      },
    );
    expect(merged).toEqual({
      ...DEFAULT_CONFIG,
      targets: ["2.1.2"],
      mode: "source",
      reporter: "junit",
      scenarioFilter: ["only-this"],
      bootTimeoutMs: 1_000,
      scenarioTimeoutMs: 2_000,
      keepSandbox: true,
    });
  });
});
