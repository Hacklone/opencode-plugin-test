import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { extractTarball, inspectArtifact, listTarballFiles } from "../src/package/artifact.js";
import { type PluginManifest, requiredExportFiles } from "../src/package/manifest.js";

const tempDirs: string[] = [];

async function trackDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

const baseManifest: PluginManifest = {
  name: "p",
  version: "1.0.0",
  type: "module",
  exports: null,
  dependencies: null,
  raw: {},
};

/** Stages files and packs them into a real gzipped tarball (one tar.c call). */
async function makeTarball(files: Record<string, string>, tarArgs: string[]): Promise<string> {
  const staging = await trackDir("stage-");
  for (const [rel, contents] of Object.entries(files)) {
    const target = path.join(staging, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  const tarballPath = path.join(staging, "pkg.tgz");
  await tar.c({ cwd: staging, file: tarballPath }, tarArgs);
  return tarballPath;
}

/** Stages `package/`-rooted files and packs them into an npm-style tarball. */
async function makeNpmStyleTarball(files: Record<string, string>): Promise<string> {
  return makeTarball(files, ["package"]);
}

describe("listTarballFiles", () => {
  it("lists package-rooted entries stripped of the package/ prefix", async () => {
    const tarballPath = await makeNpmStyleTarball({
      "package/package.json": "{}",
      "package/index.ts": "export {}",
      "package/lib/util.ts": "export {}",
    });
    const result = await listTarballFiles(tarballPath);
    if ("files" in result) {
      expect(result.files.sort()).toEqual(["index.ts", "lib/util.ts", "package.json"]);
    } else {
      expect.unreachable();
    }
  });

  it("ignores directory entries and files outside the package/ root", async () => {
    const tarballPath = await makeTarball(
      { "package/index.ts": "export {}", "stray.txt": "outside the root" },
      ["package", "stray.txt"],
    );
    const result = await listTarballFiles(tarballPath);
    if ("files" in result) {
      expect(result.files).toEqual(["index.ts"]);
    } else {
      expect.unreachable();
    }
  });

  it("reports PKG010 for an unreadable tarball", async () => {
    // Corrupted bytes are treated as an empty archive by tar.t, so exercise
    // the failure with a path that cannot be read at all.
    const staging = await trackDir("stage-");
    const tarballPath = path.join(staging, "missing.tgz");
    const result = await listTarballFiles(tarballPath);
    if ("error" in result) {
      expect(result.error.code).toBe("PKG010");
      expect(result.error.message).toContain("could not read tarball");
    } else {
      expect.unreachable();
    }
  });
});

describe("extractTarball", () => {
  it("extracts an npm tarball into destDir/package", async () => {
    const tarballPath = await makeNpmStyleTarball({
      "package/package.json": "{}",
      "package/index.ts": "export default 1",
    });
    const destDir = await trackDir("extract-");
    const result = await extractTarball(tarballPath, destDir);
    if ("dir" in result) {
      expect(result.dir).toBe(path.join(destDir, "package"));
      await access(path.join(result.dir, "index.ts"));
      await access(path.join(result.dir, "package.json"));
    } else {
      expect.unreachable();
    }
  });

  it("falls back to destDir for tarballs without a package/ root", async () => {
    const tarballPath = await makeTarball(
      { "package.json": "{}", "index.ts": "export default 1" },
      ["package.json", "index.ts"],
    );
    const destDir = await trackDir("extract-");
    const result = await extractTarball(tarballPath, destDir);
    if ("dir" in result) {
      expect(result.dir).toBe(destDir);
      await access(path.join(result.dir, "index.ts"));
    } else {
      expect.unreachable();
    }
  });

  it("reports PKG010 when extraction of corrupt bytes fails", async () => {
    const staging = await trackDir("stage-");
    const tarballPath = path.join(staging, "corrupt.tgz");
    await writeFile(tarballPath, Buffer.from("this is not a gzip stream"));
    const destDir = await trackDir("extract-");
    const result = await extractTarball(tarballPath, destDir);
    if ("error" in result) {
      expect(result.error.code).toBe("PKG010");
      expect(result.error.message).toContain("could not extract tarball");
    } else {
      expect.unreachable();
    }
  });
});

describe("inspectArtifact", () => {
  it("reports no missing files when every required export exists in the tarball", async () => {
    const manifest: PluginManifest = {
      ...baseManifest,
      exports: { ".": "./index.ts", "./tui": "./tui.ts" },
    };
    const tarballPath = await makeNpmStyleTarball({
      "package/package.json": JSON.stringify({ name: "p", exports: manifest.exports }),
      "package/index.ts": "export {}",
      "package/tui.ts": "export {}",
    });
    const required = requiredExportFiles(manifest);
    expect(required).toEqual(["index.ts", "tui.ts"]);
    const result = await inspectArtifact(tarballPath, manifest);
    if (result.ok) {
      expect(result.missing).toEqual([]);
    } else {
      expect.unreachable();
    }
  });

  it("lists required export files missing from the tarball", async () => {
    const manifest: PluginManifest = {
      ...baseManifest,
      exports: { ".": "./index.ts", "./rpc": "./rpc.ts" },
    };
    // Tarball only ships index.ts; rpc.ts is missing.
    const tarballPath = await makeNpmStyleTarball({
      "package/package.json": "{}",
      "package/index.ts": "export {}",
    });
    const required = requiredExportFiles(manifest);
    expect(required).toEqual(["index.ts", "rpc.ts"]);
    const result = await inspectArtifact(tarballPath, manifest);
    if (result.ok) {
      expect(result.missing).toEqual(required.filter((f) => f !== "index.ts"));
    } else {
      expect.unreachable();
    }
  });

  it("fails with PKG010 when the tarball cannot be read", async () => {
    const staging = await trackDir("stage-");
    const tarballPath = path.join(staging, "missing.tgz");
    const manifest: PluginManifest = { ...baseManifest, exports: { ".": "./index.ts" } };
    const result = await inspectArtifact(tarballPath, manifest);
    if (!result.ok) {
      expect(result.error.code).toBe("PKG010");
    } else {
      expect.unreachable();
    }
  });
});
