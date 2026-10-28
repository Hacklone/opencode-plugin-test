import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyTarget,
  detectBinaryVersion,
  findOnPath,
  isValidTargetSpec,
  parseVersionOutput,
  resolveTarget,
} from "../src/opencode/target.js";

const tmpDirs: string[] = [];

function newTmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** Writes an executable shell script and returns its path. */
function writeScript(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

let savedPath: string | undefined;
let savedHome: string | undefined;

/** Temporarily swaps process.platform (read via process.platform, not a dep seam) and restores it. */
async function withPlatform(platform: NodeJS.Platform, fn: () => Promise<void>): Promise<void> {
  const saved = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  try {
    await fn();
  } finally {
    if (saved !== undefined) {
      Object.defineProperty(process, "platform", saved);
    }
  }
}

afterEach(() => {
  if (savedPath !== undefined) {
    process.env["PATH"] = savedPath;
    savedPath = undefined;
  }
  if (savedHome !== undefined) {
    process.env["HOME"] = savedHome;
    savedHome = undefined;
  }
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("isValidTargetSpec", () => {
  it("accepts keywords, semvers and paths", () => {
    expect(isValidTargetSpec("current")).toBe(true);
    expect(isValidTargetSpec("latest")).toBe(true);
    expect(isValidTargetSpec("1.2.3")).toBe(true);
    expect(isValidTargetSpec("1.2.3-beta.1")).toBe(true);
    expect(isValidTargetSpec("/usr/local/bin/opencode")).toBe(true);
    expect(isValidTargetSpec("./bin/oc")).toBe(true);
    expect(isValidTargetSpec("../bin/oc")).toBe(true);
    expect(isValidTargetSpec("~/bin/oc")).toBe(true);
  });

  it("rejects junk, partial semvers and v-prefixed semvers", () => {
    expect(isValidTargetSpec("banana")).toBe(false);
    expect(isValidTargetSpec("1.2")).toBe(false);
    expect(isValidTargetSpec("v1.2.3")).toBe(false);
    expect(isValidTargetSpec("")).toBe(false);
  });
});

describe("classifyTarget", () => {
  it("classifies current/latest/semver/path", () => {
    expect(classifyTarget("current")).toBe("current");
    expect(classifyTarget("latest")).toBe("latest");
    expect(classifyTarget("1.2.3")).toBe("version");
    expect(classifyTarget("1.2.3-rc.1")).toBe("version");
    expect(classifyTarget("/abs/path")).toBe("path");
    expect(classifyTarget("./rel")).toBe("path");
    expect(classifyTarget("~/home")).toBe("path");
    expect(classifyTarget("anything-else")).toBe("path");
  });
});

describe("parseVersionOutput", () => {
  it("parses 'opencode v2.1.2'", () => {
    expect(parseVersionOutput("opencode v2.1.2")).toBe("2.1.2");
  });

  it("parses 'opencode 2.1.2, something' stopping at the comma", () => {
    expect(parseVersionOutput("opencode 2.1.2, something")).toBe("2.1.2");
  });

  it("finds the version in multiline output", () => {
    expect(parseVersionOutput("booting...\nopencode v3.1.4 (abc123)\nready")).toBe("3.1.4");
  });

  it("is case-insensitive", () => {
    expect(parseVersionOutput("OpenCode v0.9.9")).toBe("0.9.9");
  });

  it("returns null when no version is present", () => {
    expect(parseVersionOutput("version: unknown")).toBeNull();
  });
});

describe("detectBinaryVersion", () => {
  it("uses the injected detector", async () => {
    const detect = vi.fn(async (_binaryPath: string) => "3.3.3");
    await expect(detectBinaryVersion("/any/bin", { detectVersion: detect })).resolves.toBe("3.3.3");
    expect(detect).toHaveBeenCalledWith("/any/bin");
  });

  it("returns the injected null", async () => {
    await expect(
      detectBinaryVersion("/any/bin", { detectVersion: async () => null }),
    ).resolves.toBeNull();
  });

  it("parses --version output from a real script", async () => {
    const dir = newTmpDir("target-bin-");
    const bin = writeScript(dir, "opencode", 'echo "opencode v2.1.2"');
    await expect(detectBinaryVersion(bin)).resolves.toBe("2.1.2");
  });

  it("returns null on non-zero exit", async () => {
    const dir = newTmpDir("target-bin-");
    const bin = writeScript(dir, "opencode", 'echo "boom" >&2\nexit 1');
    await expect(detectBinaryVersion(bin)).resolves.toBeNull();
  });

  it("returns null when the binary does not exist", async () => {
    const dir = newTmpDir("target-bin-");
    await expect(detectBinaryVersion(path.join(dir, "nope"))).resolves.toBeNull();
  });
});

describe("findOnPath", () => {
  it("finds an executable in a PATH dir", async () => {
    const dir = newTmpDir("target-path-");
    const bin = writeScript(dir, "opencode", "exit 0");
    savedPath = process.env["PATH"];
    process.env["PATH"] = dir;
    await expect(findOnPath("opencode")).resolves.toBe(bin);
  });

  it("skips non-executable entries and returns null", async () => {
    const dir = newTmpDir("target-path-");
    writeFileSync(path.join(dir, "opencode"), "not executable");
    chmodSync(path.join(dir, "opencode"), 0o644);
    savedPath = process.env["PATH"];
    process.env["PATH"] = dir;
    await expect(findOnPath("opencode")).resolves.toBeNull();
  });

  it("returns null when PATH is empty", async () => {
    savedPath = process.env["PATH"];
    process.env["PATH"] = "";
    await expect(findOnPath("opencode")).resolves.toBeNull();
  });

  it("returns null when PATH is unset entirely", async () => {
    savedPath = process.env["PATH"];
    delete process.env["PATH"];
    await expect(findOnPath("opencode")).resolves.toBeNull();
  });

  it("tries Windows suffixes when the platform is win32", async () => {
    const dir = newTmpDir("target-path-");
    const bin = writeScript(dir, "opencode.cmd", "exit 0");
    savedPath = process.env["PATH"];
    process.env["PATH"] = dir;
    await withPlatform("win32", async () => {
      await expect(findOnPath("opencode")).resolves.toBe(bin);
    });
  });
});

describe("resolveTarget — invalid spec", () => {
  it("rejects junk specs with ENV002", async () => {
    const result = await resolveTarget("banana", "/tmp/cache");
    if ("error" in result) {
      expect(result.error.code).toBe("ENV002");
      expect(result.error.message).toContain("banana");
    } else {
      expect.unreachable();
    }
  });
});

describe("resolveTarget — current", () => {
  it("resolves an opencode found on PATH", async () => {
    const dir = newTmpDir("target-current-");
    const bin = writeScript(dir, "opencode", "exit 0");
    savedPath = process.env["PATH"];
    process.env["PATH"] = dir;
    const detect = vi.fn(async (_binaryPath: string) => "1.0.0");
    const result = await resolveTarget("current", "/tmp/cache", { detectVersion: detect });
    if ("target" in result) {
      expect(result.target.spec).toBe("current");
      expect(result.target.kind).toBe("current");
      expect(result.target.binaryPath).toBe(bin);
      expect(result.target.version).toBe("1.0.0");
    } else {
      expect.unreachable();
    }
  });

  it("throws ENV002 when nothing is on PATH", async () => {
    const dir = newTmpDir("target-current-");
    savedPath = process.env["PATH"];
    process.env["PATH"] = dir;
    const result = await resolveTarget("current", "/tmp/cache", {
      detectVersion: async (_binaryPath: string) => "1.0.0",
    });
    if ("error" in result) {
      expect(result.error.code).toBe("ENV002");
      expect(result.error.message).toContain("no opencode binary found on PATH");
    } else {
      expect.unreachable();
    }
  });
});

describe("resolveTarget — latest", () => {
  it("uses latestNpmVersion then installToDir", async () => {
    const cacheDir = newTmpDir("target-cache-");
    const latestNpmVersion = vi.fn(async (_pkg: string) => "2.0.0");
    const installToDir = vi.fn(async (_cacheDir: string, _spec: string) => null);
    const pathExists = vi.fn(async (_p: string) => false);
    pathExists.mockResolvedValueOnce(false).mockResolvedValue(true);
    const detect = vi.fn(async (_binaryPath: string) => "2.0.0");
    const result = await resolveTarget("latest", cacheDir, {
      latestNpmVersion,
      installToDir,
      pathExists,
      detectVersion: detect,
    });
    if ("target" in result) {
      expect(result.target.spec).toBe("latest");
      expect(result.target.kind).toBe("latest");
      expect(latestNpmVersion).toHaveBeenCalledWith("@opencode/cli");
      expect(installToDir).toHaveBeenCalledWith(
        path.join(cacheDir, "@opencode/cli@2.0.0"),
        "@opencode/cli@2.0.0",
      );
      expect(result.target.binaryPath).toBe(
        path.join(cacheDir, "@opencode/cli@2.0.0", "node_modules", ".bin", "opencode"),
      );
      expect(result.target.version).toBe("2.0.0");
    } else {
      expect.unreachable();
    }
  });

  it("reports ENV001 when the dist-tag lookup fails", async () => {
    const result = await resolveTarget("latest", "/tmp/cache", {
      latestNpmVersion: async (_pkg: string) => null,
      pathExists: async (_p: string) => false,
      detectVersion: async (_binaryPath: string) => null,
    });
    if ("error" in result) {
      expect(result.error.code).toBe("ENV001");
      expect(result.error.message).toContain("could not resolve latest version");
    } else {
      expect.unreachable();
    }
  });

  it("reads the latest version via a fake npmBin printing JSON", async () => {
    const dir = newTmpDir("target-npmview-");
    const npmBin = writeScript(dir, "npm", 'echo "\\"3.4.5\\""\nexit 0');
    const detect = vi.fn(async (_binaryPath: string) => null);
    const result = await resolveTarget("latest", "/tmp/cache", {
      npmBin,
      env: {},
      pathExists: async (_p: string) => true,
      detectVersion: detect,
    });
    if ("target" in result) {
      expect(result.target.kind).toBe("latest");
      expect(result.target.version).toBe("3.4.5");
    } else {
      expect.unreachable();
    }
  });

  it("reports ENV001 when npm view prints garbage", async () => {
    const dir = newTmpDir("target-npmview-");
    const npmBin = writeScript(dir, "npm", 'echo "not-json"\nexit 0');
    const result = await resolveTarget("latest", "/tmp/cache", {
      npmBin,
      env: {},
      pathExists: async (_p: string) => true,
      detectVersion: async (_binaryPath: string) => null,
    });
    if ("error" in result) {
      expect(result.error.code).toBe("ENV001");
    } else {
      expect.unreachable();
    }
  });

  it("reports ENV001 when npm view exits non-zero", async () => {
    const dir = newTmpDir("target-npmview-");
    const npmBin = writeScript(dir, "npm", 'echo "network down" >&2\nexit 7');
    const result = await resolveTarget("latest", "/tmp/cache", {
      npmBin,
      env: {},
      pathExists: async (_p: string) => true,
      detectVersion: async (_binaryPath: string) => null,
    });
    if ("error" in result) {
      expect(result.error.code).toBe("ENV001");
      expect(result.error.message).toContain("could not resolve latest version");
    } else {
      expect.unreachable();
    }
  });
});

describe("resolveTarget — semver (npmInstallToDir)", () => {
  it("hits the cache without installing", async () => {
    const cacheDir = newTmpDir("target-cache-");
    const installToDir = vi.fn(async (_cacheDir: string, _spec: string) => null);
    const detect = vi.fn(async (_binaryPath: string) => null);
    const result = await resolveTarget("1.2.3", cacheDir, {
      installToDir,
      pathExists: async (_p: string) => true,
      detectVersion: detect,
    });
    if ("target" in result) {
      expect(result.target.spec).toBe("1.2.3");
      expect(result.target.kind).toBe("version");
      expect(result.target.binaryPath).toBe(
        path.join(cacheDir, "@opencode/cli@1.2.3", "node_modules", ".bin", "opencode"),
      );
      expect(result.target.version).toBe("1.2.3");
      expect(installToDir).not.toHaveBeenCalled();
    } else {
      expect.unreachable();
    }
  });

  it("installs via a fake npmBin and passes the package spec", async () => {
    const dir = newTmpDir("target-npminstall-");
    const argsFile = path.join(dir, "npm-args.log");
    const npmBin = writeScript(dir, "npm", 'echo "$@" >> "$ARGS_FILE"\nexit 0');
    const cacheDir = newTmpDir("target-cache-");
    const pathExists = vi.fn(async (_p: string) => false);
    pathExists.mockResolvedValueOnce(false).mockResolvedValue(true);
    const detect = vi.fn(async (_binaryPath: string) => null);
    const result = await resolveTarget("1.2.3", cacheDir, {
      npmBin,
      env: { ...process.env, ARGS_FILE: argsFile },
      pathExists,
      detectVersion: detect,
    });
    if ("target" in result) {
      const args = readFileSync(argsFile, "utf8").trim();
      const versionDir = path.join(cacheDir, "@opencode/cli@1.2.3");
      expect(args).toBe(
        `install --prefix ${versionDir} --no-audit --no-fund --loglevel=error @opencode/cli@1.2.3`,
      );
      expect(result.target.binaryPath).toBe(
        path.join(versionDir, "node_modules", ".bin", "opencode"),
      );
      expect(result.target.version).toBe("1.2.3");
    } else {
      expect.unreachable();
    }
  });

  it("throws diag ENV001 when npm install fails", async () => {
    const dir = newTmpDir("target-npminstall-");
    const npmBin = writeScript(dir, "npm", 'echo "ERR! boom" >&2\nexit 3');
    const result = await resolveTarget("1.2.3", "/tmp/cache", {
      npmBin,
      env: {},
      pathExists: async (_p: string) => false,
      detectVersion: async (_binaryPath: string) => null,
    });
    if ("error" in result) {
      expect(result.error.code).toBe("ENV001");
      expect(result.error.message).toContain("exit code 3");
      expect(result.error.hint).toContain("boom");
    } else {
      expect.unreachable();
    }
  });

  it("uses the .cmd binary name when the platform is win32", async () => {
    const cacheDir = newTmpDir("target-cache-");
    await withPlatform("win32", async () => {
      const result = await resolveTarget("1.2.3", cacheDir, {
        installToDir: async (_cacheDir: string, _spec: string) => null,
        pathExists: async (_p: string) => true,
        detectVersion: async (_binaryPath: string) => null,
      });
      if ("target" in result) {
        expect(result.target.binaryPath).toBe(
          path.join(cacheDir, "@opencode/cli@1.2.3", "node_modules", ".bin", "opencode.cmd"),
        );
        expect(result.target.version).toBe("1.2.3");
      } else {
        expect.unreachable();
      }
    });
  });

  it("reports ENV001 when the install produces no binary", async () => {
    const result = await resolveTarget("1.2.3", "/tmp/cache", {
      installToDir: async (_cacheDir: string, _spec: string) => null,
      pathExists: async (_p: string) => false,
      detectVersion: async (_binaryPath: string) => null,
    });
    if ("error" in result) {
      expect(result.error.code).toBe("ENV001");
      expect(result.error.message).toContain("produced no binary");
    } else {
      expect.unreachable();
    }
  });
});

describe("resolveTarget — path", () => {
  it("expands ~ using HOME", async () => {
    const home = newTmpDir("target-home-");
    const binDir = path.join(home, "mybin");
    mkdirSync(binDir, { recursive: true });
    const bin = writeScript(binDir, "opencode", "exit 0");
    savedHome = process.env["HOME"];
    process.env["HOME"] = home;
    const detect = vi.fn(async (_binaryPath: string) => "7.7.7");
    const result = await resolveTarget("~/mybin/opencode", "/tmp/cache", { detectVersion: detect });
    if ("target" in result) {
      expect(result.target.spec).toBe("~/mybin/opencode");
      expect(result.target.kind).toBe("path");
      expect(result.target.binaryPath).toBe(bin);
      expect(result.target.version).toBe("7.7.7");
    } else {
      expect.unreachable();
    }
  });

  it("resolves relative specs against cwd", async () => {
    const detect = vi.fn(async (_binaryPath: string) => null);
    const result = await resolveTarget("./bin/opencode", "/tmp/cache", {
      detectVersion: detect,
      pathExists: async (_p: string) => true,
    });
    if ("target" in result) {
      expect(result.target.binaryPath).toBe(path.resolve("./bin/opencode"));
    } else {
      expect.unreachable();
    }
  });

  it("uses the default --version detector when detectVersion is not injected", async () => {
    const dir = newTmpDir("target-defaultdetect-");
    const bin = writeScript(dir, "opencode", 'echo "opencode v9.9.9"');
    const result = await resolveTarget(bin, "/tmp/cache", {
      pathExists: async (_p: string) => true,
    });
    if ("target" in result) {
      expect(result.target.version).toBe("9.9.9");
    } else {
      expect.unreachable();
    }
  });

  it("expands ~ to the filesystem root when HOME is unset", async () => {
    savedHome = process.env["HOME"];
    delete process.env["HOME"];
    const detect = vi.fn(async (_binaryPath: string) => null);
    const result = await resolveTarget("~/bin/oc", "/tmp/cache", {
      detectVersion: detect,
      pathExists: async (_p: string) => true,
    });
    if ("target" in result) {
      expect(result.target.binaryPath).toBe("/bin/oc");
    } else {
      expect.unreachable();
    }
  });

  it("reports ENV002 when the path target does not exist", async () => {
    const missing = path.join(newTmpDir("target-missing-"), "nope");
    const result = await resolveTarget(missing, "/tmp/cache", {
      detectVersion: async (_binaryPath: string) => null,
    });
    if ("error" in result) {
      expect(result.error.code).toBe("ENV002");
      expect(result.error.message).toContain(missing);
    } else {
      expect.unreachable();
    }
  });
});
