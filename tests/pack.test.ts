import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packPackage } from "../src/package/pack.js";

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

async function makeTinyPackage(): Promise<string> {
  const dir = await trackDir("packme-");
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "tiny-pkg", version: "2.0.1", type: "module" }),
  );
  return dir;
}

/** Writes an executable shell script standing in for the npm binary. */
async function makeNpmScript(contents: string): Promise<string> {
  const dir = await trackDir("packbin-");
  const script = path.join(dir, "fake-npm.sh");
  await writeFile(script, contents);
  await chmod(script, 0o755);
  return script;
}

describe("packPackage", () => {
  it("packs a real package and returns the tarball path", async () => {
    const root = await makeTinyPackage();
    const dest = await trackDir("dest-");
    const result = await packPackage(root, dest, 60_000);
    if ("artifact" in result) {
      expect(result.artifact.filename).toBe("tiny-pkg-2.0.1.tgz");
      await access(result.artifact.tarballPath);
    } else {
      expect.unreachable();
    }
  });

  it("reports npm failures", async () => {
    const root = await makeTinyPackage();
    const dest = await trackDir("dest-");
    const result = await packPackage(root, dest, 60_000, { npmBin: "definitely-not-npm-xyz" });
    if ("error" in result) {
      expect(result.error.code).toBe("PKG008");
    } else {
      expect.unreachable();
    }
  }, 30_000);

  it("reports unparseable npm output", async () => {
    const root = await makeTinyPackage();
    const dest = await trackDir("dest-");
    // Inject a fake npm binary through the PackDeps seam: a shell script that
    // exits 0 while printing garbage to stdout.
    const npmBin = await makeNpmScript('#!/bin/sh\necho "not json at all"\n');
    const result = await packPackage(root, dest, 60_000, { npmBin });
    if ("error" in result) {
      expect(result.error.code).toBe("PKG008");
      expect(result.error.message).toContain("unparseable output");
      expect(result.error.message).toContain("not json at all");
    } else {
      expect.unreachable();
    }
  }, 30_000);

  it("reports output without a tarball entry", async () => {
    const root = await makeTinyPackage();
    const dest = await trackDir("dest-");
    const npmBin = await makeNpmScript('#!/bin/sh\necho "[]"\n');
    const result = await packPackage(root, dest, 60_000, { npmBin });
    if ("error" in result) {
      expect(result.error.code).toBe("PKG008");
      expect(result.error.message).toContain("did not contain a tarball entry");
    } else {
      expect.unreachable();
    }
  }, 30_000);

  it("reports entries missing a filename", async () => {
    const root = await makeTinyPackage();
    const dest = await trackDir("dest-");
    const npmBin = await makeNpmScript('#!/bin/sh\necho \'[{"tarball":"x.tgz"}]\'\n');
    const result = await packPackage(root, dest, 60_000, { npmBin });
    if ("error" in result) {
      expect(result.error.code).toBe("PKG008");
      expect(result.error.message).toContain("no filename");
    } else {
      expect.unreachable();
    }
  }, 30_000);

  it("reports a nonzero npm exit code with the stderr tail", async () => {
    const root = await makeTinyPackage();
    const dest = await trackDir("dest-");
    // Inject a fake npm binary through the PackDeps seam: exits nonzero after
    // printing four stderr lines (the diagnostic keeps only the last three).
    const npmBin = await makeNpmScript(
      '#!/bin/sh\necho "boom1" >&2\necho "boom2" >&2\necho "boom3" >&2\necho "boom4" >&2\nexit 3\n',
    );
    const result = await packPackage(root, dest, 60_000, { npmBin });
    if ("error" in result) {
      expect(result.error.code).toBe("PKG008");
      expect(result.error.message).toContain("npm pack failed with exit code 3");
      expect(result.error.hint).toBe("boom2\nboom3\nboom4");
    } else {
      expect.unreachable();
    }
  }, 30_000);

  it("reports missing filename in output", async () => {
    const root = await makeTinyPackage();
    const dest = await trackDir("dest-");
    const result = await packPackage(root, dest, 60_000, { npmBin: "echo" });
    // echo with args will succeed but print nothing parseable
    if ("error" in result) {
      expect(result.error.code).toBe("PKG008");
    } else {
      expect.unreachable();
    }
  }, 30_000);
});
