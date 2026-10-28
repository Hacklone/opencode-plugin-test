import { readdir } from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { type Diagnostic, diag } from "../domain/diagnostics.js";
import type { PluginManifest } from "./manifest.js";
import { requiredExportFiles } from "./manifest.js";

const TARBALL_ROOT = "package";

/** Lists file entry paths inside an npm tarball (relative to the tarball root). */
export async function listTarballFiles(
  tarballPath: string,
): Promise<{ files: string[] } | { error: Diagnostic }> {
  const files: string[] = [];
  try {
    await tar.t({
      file: tarballPath,
      onReadEntry: (entry) => {
        const p = entry.path;
        if (!p.endsWith("/")) {
          const stripped = stripTarballRoot(p);
          if (stripped !== null) {
            files.push(stripped);
          }
        }
      },
    });
  } catch (e) {
    return {
      error: diag("PKG", "010", `could not read tarball ${tarballPath}: ${(e as Error).message}`),
    };
  }
  return { files };
}

function stripTarballRoot(entryPath: string): string | null {
  const prefix = `${TARBALL_ROOT}/`;
  if (!entryPath.startsWith(prefix)) {
    return null;
  }
  // A bare `package/` root entry is filtered by callers (endsWith("/")), so
  // `rest` is always non-empty here.
  return entryPath.slice(prefix.length);
}

/** Extracts an npm tarball; returns the directory containing the package. */
export async function extractTarball(
  tarballPath: string,
  destDir: string,
): Promise<{ dir: string } | { error: Diagnostic }> {
  try {
    await tar.x({ file: tarballPath, cwd: destDir });
  } catch (e) {
    return {
      error: diag(
        "PKG",
        "010",
        `could not extract tarball ${tarballPath}: ${(e as Error).message}`,
      ),
    };
  }
  const rootEntry = path.join(destDir, TARBALL_ROOT);
  try {
    await readdir(rootEntry);
    return { dir: rootEntry };
  } catch {
    // Nonstandard tarball without a package/ root: fall back to destDir itself.
    return { dir: destDir };
  }
}

export type ArtifactInspection = { ok: true; missing: string[] } | { ok: false; error: Diagnostic };

/** Verifies every declared export target is present in the packed tarball. */
export async function inspectArtifact(
  tarballPath: string,
  manifest: PluginManifest,
): Promise<ArtifactInspection> {
  const listing = await listTarballFiles(tarballPath);
  if ("error" in listing) {
    return { ok: false, error: listing.error };
  }
  const present = new Set(listing.files);
  const missing: string[] = [];
  for (const required of requiredExportFiles(manifest)) {
    if (!present.has(required)) {
      missing.push(required);
    }
  }
  return { ok: true, missing };
}
