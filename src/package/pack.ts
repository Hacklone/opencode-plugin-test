import path from "node:path";
import { type Diagnostic, diag } from "../domain/diagnostics.js";
import { runProcess } from "../util/process.js";

export interface PackedArtifact {
  tarballPath: string;
  filename: string;
}

export interface PackDeps {
  npmBin?: string;
  env?: NodeJS.ProcessEnv;
}

/** Runs `npm pack --json --pack-destination <dir>` in the package root. */
export async function packPackage(
  root: string,
  destination: string,
  timeoutMs: number,
  deps: PackDeps = {},
): Promise<{ artifact: PackedArtifact } | { error: Diagnostic }> {
  const npmBin = deps.npmBin ?? "npm";
  const result = await runProcess({
    cmd: npmBin,
    args: ["pack", "--json", "--pack-destination", destination],
    cwd: root,
    env: deps.env ?? process.env,
    timeoutMs,
  });
  if (result.spawnError !== null) {
    return { error: diag("PKG", "008", `could not run npm: ${result.spawnError}`) };
  }
  if (result.code !== 0) {
    return {
      error: diag(
        "PKG",
        "008",
        `npm pack failed with exit code ${String(result.code)}`,
        result.stderr.trim().split("\n").slice(-3).join("\n"),
      ),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return {
      error: diag(
        "PKG",
        "008",
        `npm pack produced unparseable output: ${result.stdout.slice(0, 200)}`,
      ),
    };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { error: diag("PKG", "008", "npm pack output did not contain a tarball entry") };
  }
  const entry = parsed[0] as Record<string, unknown>;
  const filename = typeof entry["filename"] === "string" ? entry["filename"] : null;
  if (filename === null) {
    return { error: diag("PKG", "008", "npm pack output entry has no filename") };
  }
  return { artifact: { tarballPath: path.join(destination, filename), filename } };
}
