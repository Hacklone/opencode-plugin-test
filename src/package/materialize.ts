import { mkdir } from "node:fs/promises";
import path from "node:path";
import { type Diagnostic, diag } from "../domain/diagnostics.js";
import { runProcess } from "../util/process.js";
import { extractTarball, inspectArtifact } from "./artifact.js";
import { type PluginManifest, readManifest } from "./manifest.js";
import { packPackage } from "./pack.js";

export interface MaterializedPackage {
  dir: string;
  manifest: PluginManifest;
}

export interface MaterializeDeps {
  npmBin?: string;
  env?: NodeJS.ProcessEnv;
}

export type MaterializeResult =
  | { ok: true; value: MaterializedPackage; missingPackedFiles: string[] }
  | { ok: false; error: Diagnostic };

/**
 * Turns a package root into a loadable directory.
 * - packed mode: npm pack → extract → (npm install when the artifact declares runtime deps)
 * - source mode: use the checkout directly
 *
 * In packed mode the manifest that matters is the one INSIDE the tarball, since
 * that is what the host will load.
 */
export async function materializePackage(
  packageRoot: string,
  mode: "packed" | "source",
  workDir: string,
  timeouts: { packTimeoutMs: number; installTimeoutMs: number },
  deps: MaterializeDeps = {},
  prepackedTarball?: string,
): Promise<MaterializeResult> {
  if (mode === "source") {
    const manifestResult = await readManifest(packageRoot);
    if ("error" in manifestResult) {
      return { ok: false, error: manifestResult.error };
    }
    return {
      ok: true,
      value: { dir: packageRoot, manifest: manifestResult.manifest },
      missingPackedFiles: [],
    };
  }

  let tarballPath: string;
  if (prepackedTarball !== undefined) {
    tarballPath = prepackedTarball;
  } else {
    const packResult = await packPackage(packageRoot, workDir, timeouts.packTimeoutMs, deps);
    if ("error" in packResult) {
      return { ok: false, error: packResult.error };
    }
    tarballPath = packResult.artifact.tarballPath;
  }
  const extractDir = path.join(workDir, "extract");
  await mkdir(extractDir, { recursive: true });
  const extractResult = await extractTarball(tarballPath, extractDir);
  if ("error" in extractResult) {
    return { ok: false, error: extractResult.error };
  }
  const manifestResult = await readManifest(extractResult.dir);
  if ("error" in manifestResult) {
    return { ok: false, error: manifestResult.error };
  }
  const manifest = manifestResult.manifest;

  const inspection = await inspectArtifact(tarballPath, manifest);
  const missingPackedFiles = inspection.ok ? inspection.missing : [];
  if (!inspection.ok) {
    return { ok: false, error: inspection.error };
  }

  const depsList = manifest.dependencies ?? {};
  const runtimeDeps = Object.keys(depsList).filter((name) => name !== "@opencode/plugin");
  if (runtimeDeps.length > 0) {
    const install = await installRuntimeDeps(extractResult.dir, timeouts.installTimeoutMs, deps);
    if (!install.ok) {
      return { ok: false, error: install.error };
    }
  }

  return {
    ok: true,
    value: { dir: extractResult.dir, manifest },
    missingPackedFiles,
  };
}

async function installRuntimeDeps(
  dir: string,
  timeoutMs: number,
  deps: MaterializeDeps,
): Promise<{ ok: true } | { ok: false; error: Diagnostic }> {
  const result = await runProcess({
    cmd: deps.npmBin ?? "npm",
    args: ["install", "--no-audit", "--no-fund", "--loglevel=error"],
    cwd: dir,
    env: deps.env ?? process.env,
    timeoutMs,
  });
  if (result.spawnError !== null) {
    return {
      ok: false,
      error: diag("PKG", "011", `could not run npm install: ${result.spawnError}`),
    };
  }
  if (result.code !== 0) {
    return {
      ok: false,
      error: diag(
        "PKG",
        "011",
        `npm install of runtime dependencies failed with exit code ${String(result.code)}`,
        result.stderr.trim().split("\n").slice(-3).join("\n"),
      ),
    };
  }
  return { ok: true };
}
