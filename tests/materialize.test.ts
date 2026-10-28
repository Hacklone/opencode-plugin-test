import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { diag } from "../src/domain/diagnostics.js";
import { inspectArtifact } from "../src/package/artifact.js";
import { materializePackage } from "../src/package/materialize.js";

// inspectArtifact stays real everywhere; the one defensive-branch test below
// forces its not-ok path, which cannot be reached through real tarball I/O
// (any archive tar.x can extract is also listed successfully by tar.t).
vi.mock("../src/package/artifact.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/package/artifact.js")>();
  return { ...actual, inspectArtifact: vi.fn(actual.inspectArtifact) };
});

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

const timeouts = { packTimeoutMs: 60_000, installTimeoutMs: 60_000 };

/** Copies a fixture tree into a tracked temp dir (so tests never mutate fixtures). */
async function copyFixture(fixtureName: string): Promise<string> {
  const root = await trackDir("pkg-");
  const fixtureDir = path.join(import.meta.dirname, "..", "fixtures", fixtureName);
  for (const file of ["package.json", "index.ts"]) {
    const source = path.join(fixtureDir, file);
    await writeFile(path.join(root, file), await readFile(source, "utf8"));
  }
  return root;
}

/** Stages `package/`-rooted files and packs a real npm-style tarball. */
async function makeNpmStyleTarball(files: Record<string, string>): Promise<string> {
  const staging = await trackDir("stage-");
  for (const [rel, contents] of Object.entries(files)) {
    const target = path.join(staging, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  const tarballPath = path.join(staging, "pkg.tgz");
  await tar.c({ cwd: staging, file: tarballPath }, ["package"]);
  return tarballPath;
}

describe("materializePackage — source mode", () => {
  it("returns the checkout itself and reads the manifest in place", async () => {
    const root = await copyFixture("valid");
    const workDir = await trackDir("work-");
    const result = await materializePackage(root, "source", workDir, timeouts);
    if (result.ok) {
      expect(result.value.dir).toBe(root);
      expect(result.value.manifest.name).toBe("opt-fixture-valid");
      expect(result.missingPackedFiles).toEqual([]);
      // source mode never extracts
      await expect(access(path.join(workDir, "extract"))).rejects.toThrow();
    } else {
      expect.unreachable();
    }
  });

  it("reports PKG001 when the package root has no package.json", async () => {
    const root = await trackDir("empty-");
    const workDir = await trackDir("work-");
    const result = await materializePackage(root, "source", workDir, timeouts);
    if (!result.ok) {
      expect(result.error.code).toBe("PKG001");
    } else {
      expect.unreachable();
    }
  });
});

describe("materializePackage — packed mode with a prepacked tarball", () => {
  it("skips npm pack, extracts, and reads the manifest from the extracted dir", async () => {
    // npm pack must never run: a broken npm binary would make the run fail if invoked.
    const tarballPath = await makeNpmStyleTarball({
      "package/package.json": JSON.stringify({
        name: "packed-only-name",
        version: "3.2.1",
        type: "module",
        exports: { ".": "./index.ts" },
      }),
      "package/index.ts": "export default 1",
    });
    const workDir = await trackDir("work-");
    const result = await materializePackage(
      path.join(import.meta.dirname, "..", "fixtures", "valid"),
      "packed",
      workDir,
      timeouts,
      { npmBin: "definitely-not-npm-xyz" },
      tarballPath,
    );
    if (result.ok) {
      expect(result.value.dir).toBe(path.join(workDir, "extract", "package"));
      await access(path.join(result.value.dir, "index.ts"));
      // The manifest that matters is the one INSIDE the tarball.
      expect(result.value.manifest.name).toBe("packed-only-name");
      expect(result.value.manifest.version).toBe("3.2.1");
      expect(result.missingPackedFiles).toEqual([]);
      // materialize creates the extract dir itself.
      await access(path.join(workDir, "extract"));
    } else {
      expect.unreachable();
    }
  });

  it("reports missing declared files from the packed artifact", async () => {
    const tarballPath = await makeNpmStyleTarball({
      "package/package.json": JSON.stringify({
        name: "p",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./index.ts", "./tui": "./tui.ts" },
      }),
      "package/index.ts": "export default 1",
      // tui.ts deliberately absent
    });
    const workDir = await trackDir("work-");
    const result = await materializePackage(
      path.join(import.meta.dirname, "..", "fixtures", "valid"),
      "packed",
      workDir,
      timeouts,
      { npmBin: "definitely-not-npm-xyz" },
      tarballPath,
    );
    if (result.ok) {
      expect(result.missingPackedFiles).toEqual(["tui.ts"]);
      expect(result.value.dir).toBe(path.join(workDir, "extract", "package"));
    } else {
      expect.unreachable();
    }
  });
});

describe("materializePackage — packed mode failure propagation", () => {
  it("reports PKG008 when npm pack itself fails", async () => {
    const root = await copyFixture("valid");
    const workDir = await trackDir("work-");
    const result = await materializePackage(root, "packed", workDir, timeouts, {
      npmBin: "definitely-not-npm-xyz",
    });
    if (!result.ok) {
      expect(result.error.code).toBe("PKG008");
      expect(result.error.message).toContain("could not run npm");
    } else {
      expect.unreachable();
    }
  });

  it("reports PKG010 when the prepacked tarball cannot be extracted", async () => {
    const staging = await trackDir("corrupt-");
    const tarballPath = path.join(staging, "corrupt.tgz");
    await writeFile(tarballPath, Buffer.from("this is not a gzip stream"));
    const workDir = await trackDir("work-");
    const result = await materializePackage(
      path.join(import.meta.dirname, "..", "fixtures", "valid"),
      "packed",
      workDir,
      timeouts,
      { npmBin: "definitely-not-npm-xyz" },
      tarballPath,
    );
    if (!result.ok) {
      expect(result.error.code).toBe("PKG010");
      expect(result.error.message).toContain("could not extract tarball");
    } else {
      expect.unreachable();
    }
  });

  it("reports PKG001 when the extracted tarball has no package.json", async () => {
    const tarballPath = await makeNpmStyleTarball({ "package/index.ts": "export default 1" });
    const workDir = await trackDir("work-");
    const result = await materializePackage(
      path.join(import.meta.dirname, "..", "fixtures", "valid"),
      "packed",
      workDir,
      timeouts,
      { npmBin: "definitely-not-npm-xyz" },
      tarballPath,
    );
    if (!result.ok) {
      expect(result.error.code).toBe("PKG001");
    } else {
      expect.unreachable();
    }
  });

  it("fails with the artifact inspection error when the tarball cannot be listed", async () => {
    const tarballPath = await makeNpmStyleTarball({
      "package/package.json": JSON.stringify({
        name: "p",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./index.ts" },
      }),
      "package/index.ts": "export default 1",
    });
    vi.mocked(inspectArtifact).mockImplementationOnce(async () => ({
      ok: false,
      error: diag("PKG", "010", "synthetic inspection failure"),
    }));
    const workDir = await trackDir("work-");
    const result = await materializePackage(
      path.join(import.meta.dirname, "..", "fixtures", "valid"),
      "packed",
      workDir,
      timeouts,
      { npmBin: "definitely-not-npm-xyz" },
      tarballPath,
    );
    if (!result.ok) {
      expect(result.error.code).toBe("PKG010");
      expect(result.error.message).toContain("synthetic inspection failure");
    } else {
      expect.unreachable();
    }
  });
});

describe("materializePackage — packed mode runs npm pack itself", () => {
  it("packs a real fixture with real npm and extracts the artifact", async () => {
    const root = path.join(import.meta.dirname, "..", "fixtures", "valid");
    const workDir = await trackDir("work-");
    const result = await materializePackage(root, "packed", workDir, timeouts, { npmBin: "npm" });
    if (result.ok) {
      expect(result.value.dir).toBe(path.join(workDir, "extract", "package"));
      await access(path.join(result.value.dir, "package.json"));
      await access(path.join(result.value.dir, "index.ts"));
      expect(result.value.manifest.name).toBe("opt-fixture-valid");
      expect(result.value.manifest.version).toBe("1.0.0");
      expect(result.missingPackedFiles).toEqual([]);
    } else {
      expect.unreachable();
    }
  }, 60_000);
});

describe("materializePackage — runtime dependency install", () => {
  it("runs npm install when the packed package declares runtime deps", async () => {
    const tarballPath = await makeNpmStyleTarball({
      "package/package.json": JSON.stringify({
        name: "p",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./index.ts" },
        dependencies: { "totally-nonexistent-pkg-abc123xyz": "^1.0.0" },
      }),
      "package/index.ts": "export default 1",
    });
    const workDir = await trackDir("work-");
    const result = await materializePackage(
      path.join(import.meta.dirname, "..", "fixtures", "valid"),
      "packed",
      workDir,
      timeouts,
      { npmBin: "npm" },
      tarballPath,
    );
    if (!result.ok) {
      expect(result.error.code).toBe("PKG011");
      expect(result.error.message).toContain("npm install");
    } else {
      expect.unreachable();
    }
  }, 120_000);

  it("reports PKG011 when npm install cannot even be spawned", async () => {
    const tarballPath = await makeNpmStyleTarball({
      "package/package.json": JSON.stringify({
        name: "p",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./index.ts" },
        dependencies: { "some-runtime-dep": "^1.0.0" },
      }),
      "package/index.ts": "export default 1",
    });
    const workDir = await trackDir("work-");
    const result = await materializePackage(
      path.join(import.meta.dirname, "..", "fixtures", "valid"),
      "packed",
      workDir,
      timeouts,
      { npmBin: "definitely-not-npm-xyz" },
      tarballPath,
    );
    if (!result.ok) {
      expect(result.error.code).toBe("PKG011");
      expect(result.error.message).toContain("could not run npm install");
    } else {
      expect.unreachable();
    }
  });

  it("reports PKG011 when the install binary exits nonzero", async () => {
    const tarballPath = await makeNpmStyleTarball({
      "package/package.json": JSON.stringify({
        name: "p",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./index.ts" },
        dependencies: { "some-runtime-dep": "^1.0.0" },
      }),
      "package/index.ts": "export default 1",
    });
    const binDir = await trackDir("installbin-");
    const npmBin = path.join(binDir, "fake-npm.sh");
    await writeFile(
      npmBin,
      '#!/bin/sh\necho "f1" >&2\necho "f2" >&2\necho "f3" >&2\necho "f4" >&2\nexit 7\n',
    );
    await chmod(npmBin, 0o755);
    const workDir = await trackDir("work-");
    const result = await materializePackage(
      path.join(import.meta.dirname, "..", "fixtures", "valid"),
      "packed",
      workDir,
      timeouts,
      { npmBin },
      tarballPath,
    );
    if (!result.ok) {
      expect(result.error.code).toBe("PKG011");
      expect(result.error.message).toContain(
        "npm install of runtime dependencies failed with exit code 7",
      );
      expect(result.error.hint).toBe("f2\nf3\nf4");
    } else {
      expect.unreachable();
    }
  });

  it("runs the install seam and succeeds when npm install exits 0", async () => {
    const tarballPath = await makeNpmStyleTarball({
      "package/package.json": JSON.stringify({
        name: "p",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./index.ts" },
        dependencies: { "some-runtime-dep": "^1.0.0" },
      }),
      "package/index.ts": "export default 1",
    });
    // The fake install drops a marker in its cwd, proving it ran in the
    // extracted package dir — and that a zero exit means success.
    const binDir = await trackDir("installbin-");
    const npmBin = path.join(binDir, "fake-npm.sh");
    await writeFile(npmBin, "#!/bin/sh\ntouch installed-marker\nexit 0\n");
    await chmod(npmBin, 0o755);
    const workDir = await trackDir("work-");
    const result = await materializePackage(
      path.join(import.meta.dirname, "..", "fixtures", "valid"),
      "packed",
      workDir,
      timeouts,
      { npmBin },
      tarballPath,
    );
    if (result.ok) {
      expect(result.value.dir).toBe(path.join(workDir, "extract", "package"));
      await access(path.join(result.value.dir, "installed-marker"));
      expect(result.missingPackedFiles).toEqual([]);
    } else {
      expect.unreachable();
    }
  });

  it("falls back to the default npm binary when MaterializeDeps.npmBin is unset", async () => {
    const tarballPath = await makeNpmStyleTarball({
      "package/package.json": JSON.stringify({
        name: "p",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./index.ts" },
        dependencies: { "some-runtime-dep": "^1.0.0" },
      }),
      "package/index.ts": "export default 1",
    });
    const workDir = await trackDir("work-");
    // npmBin omitted → the code must resolve to plain "npm". A child env whose
    // PATH contains no npm makes that spawn fail fast (no network round trip).
    const result = await materializePackage(
      path.join(import.meta.dirname, "..", "fixtures", "valid"),
      "packed",
      workDir,
      timeouts,
      { env: { PATH: "/nonexistent-no-npm-here" } },
      tarballPath,
    );
    if (!result.ok) {
      expect(result.error.code).toBe("PKG011");
      expect(result.error.message).toContain("could not run npm install");
    } else {
      expect.unreachable();
    }
  });

  it("skips npm install when only @opencode/plugin is declared", async () => {
    const tarballPath = await makeNpmStyleTarball({
      "package/package.json": JSON.stringify({
        name: "p",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./index.ts" },
        dependencies: { "@opencode/plugin": "^2.0.0" },
      }),
      "package/index.ts": "export default 1",
    });
    const workDir = await trackDir("work-");
    const result = await materializePackage(
      path.join(import.meta.dirname, "..", "fixtures", "valid"),
      "packed",
      workDir,
      timeouts,
      { npmBin: "definitely-not-npm-xyz" },
      tarballPath,
    );
    if (result.ok) {
      expect(result.value.dir).toBe(path.join(workDir, "extract", "package"));
      expect(result.missingPackedFiles).toEqual([]);
    } else {
      expect.unreachable();
    }
  });
});
