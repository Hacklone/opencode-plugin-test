import { readFile } from "node:fs/promises";
import path from "node:path";
import { type Diagnostic, diag } from "../domain/diagnostics.js";

export type ExportsValue = string | Record<string, string | undefined>;
export type ExportsMap = Record<string, ExportsValue>;

export interface PluginManifest {
  name: string | null;
  version: string | null;
  type: string | null;
  exports: ExportsMap | null;
  dependencies: Record<string, string> | null;
  raw: Record<string, unknown>;
}

export type ManifestResult = { manifest: PluginManifest } | { error: Diagnostic };

/** Reads and structurally parses package.json (not yet validating content). */
export async function readManifest(root: string): Promise<ManifestResult> {
  const file = path.join(root, "package.json");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { error: diag("PKG", "001", `package.json not readable: ${file}`) };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { error: diag("PKG", "002", `package.json is not valid JSON: ${(e as Error).message}`) };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: diag("PKG", "002", "package.json root must be a JSON object") };
  }
  const record = raw as Record<string, unknown>;
  return {
    manifest: {
      name: typeof record["name"] === "string" ? record["name"] : null,
      version: typeof record["version"] === "string" ? record["version"] : null,
      type: typeof record["type"] === "string" ? record["type"] : null,
      exports: parseExports(record["exports"]),
      dependencies:
        typeof record["dependencies"] === "object" &&
        record["dependencies"] !== null &&
        !Array.isArray(record["dependencies"])
          ? (record["dependencies"] as Record<string, string>)
          : null,
      raw: record,
    },
  };
}

function parseExports(value: unknown): ExportsMap | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as ExportsMap;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;

/** Resolves the value of an exports entry (handles conditional submaps). */
export function resolveExportsValue(value: ExportsValue): string | null {
  if (typeof value === "string") {
    return value;
  }
  const conditionals = value as Record<string, string | undefined>;
  const chosen = conditionals["import"] ?? conditionals["default"];
  return typeof chosen === "string" ? chosen : null;
}

/** The server export entry: "." if present, otherwise "./server". Returns the specifier key and file path. */
export function serverExport(
  manifest: PluginManifest,
): { specifier: string; target: string } | null {
  const exportsMap = manifest.exports;
  if (exportsMap === null) {
    return null;
  }
  for (const specifier of [".", "./server"]) {
    const value = exportsMap[specifier];
    if (value === undefined) {
      continue;
    }
    const target = resolveExportsValue(value);
    if (target !== null) {
      return { specifier, target };
    }
  }
  return null;
}

/** Normalizes an export target to a package-relative POSIX path (strips leading ./). */
export function exportTargetPath(target: string): string {
  const normalized = target.replace(/^\.\//, "");
  const queryStart = normalized.indexOf("?");
  return queryStart === -1 ? normalized : normalized.slice(0, queryStart);
}

export function isValidSemver(version: string): boolean {
  return SEMVER.test(version);
}

/**
 * Structural validation of the manifest. Warnings are kept as diagnostics with
 * family PKG but never fatal by themselves; callers decide.
 */
export function validateManifest(manifest: PluginManifest): Diagnostic[] {
  const problems: Diagnostic[] = [];
  if (manifest.name === null) {
    problems.push(diag("PKG", "003", "package.json is missing the name field"));
  }
  if (manifest.version === null || !isValidSemver(manifest.version)) {
    problems.push(
      diag(
        "PKG",
        "004",
        `package.json version ${String(manifest.version)} is missing or not a valid semver`,
      ),
    );
  }
  if (manifest.exports === null) {
    problems.push(
      diag(
        "PKG",
        "005",
        "package.json has no exports map",
        "OpenCode v2 loads plugins through exports",
      ),
    );
  } else if (serverExport(manifest) === null) {
    problems.push(
      diag("PKG", "006", 'no server export: expected "." or "./server" in the exports map'),
    );
  }
  if (manifest.type !== "module") {
    problems.push(
      diag(
        "PKG",
        "012",
        'package is not an ES module: add "type": "module"',
        "OpenCode v2 plugins are ESM",
      ),
    );
  }
  if (manifest.dependencies !== null && manifest.dependencies["@opencode/plugin"] !== undefined) {
    problems.push(
      diag(
        "PKG",
        "009",
        "@opencode/plugin is declared as a runtime dependency",
        "the OpenCode host injects its own SDK; declaring it is unnecessary",
      ),
    );
  }
  return problems;
}

/** Which export targets (relative file paths) must exist in the artifact. */
export function requiredExportFiles(manifest: PluginManifest): string[] {
  const exportsMap = manifest.exports;
  if (exportsMap === null) {
    return [];
  }
  const files: string[] = [];
  for (const [specifier, value] of Object.entries(exportsMap)) {
    const resolved = resolveExportsValue(value);
    if (resolved !== null) {
      const target = exportTargetPath(resolved);
      if (target.length > 0) {
        if (
          specifier === "." ||
          specifier === "./server" ||
          specifier.startsWith("./tui") ||
          specifier.startsWith("./rpc") ||
          specifier.startsWith("./gui")
        ) {
          files.push(target);
        }
      }
    }
  }
  return files;
}
