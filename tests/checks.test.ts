import { describe, expect, it } from "vitest";
import type { PluginInfo, PluginState } from "../src/domain/types.js";
import {
  artifactCheckOutcome,
  manifestCheckOutcome,
  pluginRegistrationCheckOutcome,
} from "../src/package/checks.js";
import type { PluginManifest } from "../src/package/manifest.js";

const good: PluginManifest = {
  name: "p",
  version: "1.0.0",
  type: "module",
  exports: { ".": "./index.ts" },
  dependencies: null,
  raw: {},
};

function makePlugin(features: PluginInfo["features"], state: PluginState): PluginInfo {
  return { source: { type: "local", path: "/somewhere/plugin" }, features, state };
}

describe("manifestCheckOutcome", () => {
  it("passes a fully valid manifest", () => {
    const outcome = manifestCheckOutcome(good);
    expect(outcome.name).toBe("package-manifest");
    expect(outcome.status).toBe("pass");
    expect(outcome.diagnostics).toEqual([]);
  });

  it("fails on each fatal diagnostic code", () => {
    const fatalVariants: Array<[PluginManifest, string]> = [
      [{ ...good, name: null }, "PKG003"],
      [{ ...good, version: null }, "PKG004"],
      [{ ...good, version: "banana" }, "PKG004"],
      [{ ...good, exports: null }, "PKG005"],
      [{ ...good, exports: { "./tui": "./tui.ts" } }, "PKG006"],
    ];
    for (const [manifest, code] of fatalVariants) {
      const outcome = manifestCheckOutcome(manifest);
      expect(outcome.status).toBe("fail");
      expect(outcome.diagnostics.map((d) => d.code)).toContain(code);
    }
  });

  it("only warns for PKG009 and PKG012", () => {
    const nonEsm = manifestCheckOutcome({ ...good, type: "commonjs" });
    expect(nonEsm.status).toBe("warn");
    expect(nonEsm.diagnostics.map((d) => d.code)).toEqual(["PKG012"]);

    const injectedSdk = manifestCheckOutcome({
      ...good,
      dependencies: { "@opencode/plugin": "^2" },
    });
    expect(injectedSdk.status).toBe("warn");
    expect(injectedSdk.diagnostics.map((d) => d.code)).toEqual(["PKG009"]);

    const both = manifestCheckOutcome({
      ...good,
      type: "commonjs",
      dependencies: { "@opencode/plugin": "^2" },
    });
    expect(both.status).toBe("warn");
    expect(both.diagnostics.map((d) => d.code).sort()).toEqual(["PKG009", "PKG012"]);
  });
});

describe("artifactCheckOutcome", () => {
  it("passes when nothing is missing", () => {
    const outcome = artifactCheckOutcome([]);
    expect(outcome.name).toBe("packed-artifact");
    expect(outcome.status).toBe("pass");
    expect(outcome.diagnostics).toEqual([]);
  });

  it("fails with one PKG007 per missing file", () => {
    const outcome = artifactCheckOutcome(["index.ts", "tui.ts"]);
    expect(outcome.status).toBe("fail");
    expect(outcome.diagnostics).toHaveLength(2);
    for (const d of outcome.diagnostics) {
      expect(d.code).toBe("PKG007");
      expect(d.hint).toContain("files field");
    }
    expect(outcome.diagnostics[0]?.message).toContain("index.ts");
    expect(outcome.diagnostics[1]?.message).toContain("tui.ts");
  });
});

describe("pluginRegistrationCheckOutcome", () => {
  it("passes when active and exposing all declared surfaces", () => {
    const plugin = makePlugin({ server: true, tui: true, rpc: true }, { status: "active" });
    const outcome = pluginRegistrationCheckOutcome(plugin, ["server", "tui", "rpc"]);
    expect(outcome.name).toBe("plugin-registration");
    expect(outcome.status).toBe("pass");
    expect(outcome.diagnostics).toEqual([]);
  });

  it("passes when exposed surfaces are a superset of the declared ones", () => {
    const plugin = makePlugin({ server: true, tui: true, rpc: true }, { status: "active" });
    const outcome = pluginRegistrationCheckOutcome(plugin, ["tui"]);
    expect(outcome.status).toBe("pass");
    expect(outcome.diagnostics).toEqual([]);
  });

  it("fails with HOST006 when the plugin state is failed", () => {
    const plugin = makePlugin({ server: true }, { status: "failed", error: "setup blew up" });
    const outcome = pluginRegistrationCheckOutcome(plugin, ["server"]);
    expect(outcome.status).toBe("fail");
    expect(outcome.diagnostics).toHaveLength(1);
    expect(outcome.diagnostics[0]?.code).toBe("HOST006");
    expect(outcome.diagnostics[0]?.message).toContain("setup blew up");
  });

  it("fails with HOST007 when a declared surface is not exposed", () => {
    const plugin = makePlugin({ server: true }, { status: "active" });
    const outcome = pluginRegistrationCheckOutcome(plugin, ["server", "tui", "rpc"]);
    expect(outcome.status).toBe("fail");
    expect(outcome.diagnostics).toHaveLength(1);
    expect(outcome.diagnostics[0]?.code).toBe("HOST007");
    expect(outcome.diagnostics[0]?.message).toContain("tui, rpc");
  });

  it("fails with both HOST006 and HOST007 when applicable", () => {
    const plugin = makePlugin({ server: true }, { status: "failed", error: "boom" });
    const outcome = pluginRegistrationCheckOutcome(plugin, ["server", "tui"]);
    expect(outcome.status).toBe("fail");
    expect(outcome.diagnostics.map((d) => d.code)).toEqual(["HOST006", "HOST007"]);
  });
});
