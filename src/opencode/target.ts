import { access, constants } from "node:fs/promises";
import path from "node:path";
import { type Diagnostic, diag } from "../domain/diagnostics.js";
import { runProcess } from "../util/process.js";

export type TargetKind = "current" | "latest" | "version" | "path";

export interface ResolvedTarget {
  spec: string;
  kind: TargetKind;
  binaryPath: string;
  version: string | null;
}

export interface ResolveDeps {
  npmBin?: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests. */
  detectVersion?: (binaryPath: string) => Promise<string | null>;
  /** Injectable for tests. */
  pathExists?: (p: string) => Promise<boolean>;
  /** Injectable for tests. */
  latestNpmVersion?: (pkg: string) => Promise<string | null>;
  /** Injectable for tests. */
  installToDir?: (cacheDir: string, spec: string) => Promise<Diagnostic | null>;
}

const NPM_PACKAGE = "@opencode/cli";
const CLI_PACKAGE_SPEC = `${NPM_PACKAGE}@`;

export function isValidTargetSpec(spec: string): boolean {
  if (spec === "current" || spec === "latest") {
    return true;
  }
  if (/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(spec)) {
    return true;
  }
  // Path: anything containing a separator or starting with . / ~
  return (
    spec.startsWith("/") || spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("~")
  );
}

export function classifyTarget(spec: string): TargetKind {
  if (spec === "current") {
    return "current";
  }
  if (spec === "latest") {
    return "latest";
  }
  if (/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(spec)) {
    return "version";
  }
  return "path";
}

/** Reads the version of an opencode binary via `--version` (e.g. "opencode v2.1.2"). */
export async function detectBinaryVersion(
  binaryPath: string,
  deps: ResolveDeps = {},
): Promise<string | null> {
  if (deps.detectVersion) {
    return deps.detectVersion(binaryPath);
  }
  const result = await runProcess({
    cmd: binaryPath,
    args: ["--version"],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 15_000,
  });
  if (result.code !== 0) {
    return null;
  }
  return parseVersionOutput(result.stdout);
}

export function parseVersionOutput(output: string): string | null {
  const match = /opencode v?(\d+\.\d+\.\d+[^\s,)]*)/i.exec(output);
  return match?.[1] ?? null;
}

/** Locates `opencode` on PATH by scanning PATH entries (no shell). */
export async function findOnPath(name: string): Promise<string | null> {
  const dirs = (process.env["PATH"] ?? "").split(path.delimiter).filter((d) => d.length > 0);
  const suffixes = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, `${name}${suffix}`);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // keep scanning
      }
    }
  }
  return null;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function npmViewLatest(npmBin: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const result = await runProcess({
    cmd: npmBin,
    args: ["view", NPM_PACKAGE, "version", "--json"],
    cwd: process.cwd(),
    env,
    timeoutMs: 60_000,
  });
  if (result.code !== 0) {
    return null;
  }
  const trimmed = result.stdout.trim().replace(/^"|"$/g, "");
  return /^\d+\.\d+\.\d+/.test(trimmed) ? trimmed : null;
}

async function npmInstallToDir(
  npmBin: string,
  env: NodeJS.ProcessEnv,
  cacheDir: string,
  versionSpec: string,
): Promise<Diagnostic | null> {
  const result = await runProcess({
    cmd: npmBin,
    args: [
      "install",
      "--prefix",
      cacheDir,
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
      versionSpec,
    ],
    cwd: process.cwd(),
    env,
    timeoutMs: 600_000,
  });
  if (result.code !== 0) {
    return diag(
      "ENV",
      "001",
      `npm install ${versionSpec} failed with exit code ${String(result.code)}`,
      result.stderr.trim().split("\n").slice(-3).join("\n"),
    );
  }
  return null;
}

function cachedBinaryPath(cacheDir: string): string {
  const binName = process.platform === "win32" ? "opencode.cmd" : "opencode";
  return path.join(cacheDir, "node_modules", ".bin", binName);
}

/**
 * Resolves a target spec into a concrete binary.
 * - `current`: opencode found on PATH
 * - `latest`: npm dist-tag lookup then versioned install into cacheDir
 * - semver: versioned install into cacheDir
 * - path: used directly
 */
export async function resolveTarget(
  spec: string,
  cacheDir: string,
  deps: ResolveDeps = {},
): Promise<{ target: ResolvedTarget } | { error: Diagnostic }> {
  const npmBin = deps.npmBin ?? "npm";
  const env = deps.env ?? process.env;
  const exists = deps.pathExists ?? pathExists;
  const detect = deps.detectVersion ?? ((bin) => detectBinaryVersion(bin));

  if (!isValidTargetSpec(spec)) {
    return {
      error: diag(
        "ENV",
        "002",
        `"${spec}" is not a valid target`,
        'use "current", "latest", a semver, or a binary path',
      ),
    };
  }
  const kind = classifyTarget(spec);

  if (kind === "path") {
    const expanded = spec.startsWith("~")
      ? path.join(process.env["HOME"] ?? "", spec.slice(1))
      : spec;
    const abs = path.resolve(expanded);
    if (!(await exists(abs))) {
      return { error: diag("ENV", "002", `target binary does not exist: ${abs}`) };
    }
    const version = await detect(abs);
    return { target: { spec, kind, binaryPath: abs, version } };
  }

  if (kind === "current") {
    const found = await findOnPath("opencode");
    if (found === null) {
      return { error: diag("ENV", "002", 'no opencode binary found on PATH for target "current"') };
    }
    const version = await detect(found);
    return { target: { spec, kind, binaryPath: found, version } };
  }

  // latest / version → npm install into versioned cache dir
  let version: string | null;
  if (kind === "latest") {
    const latest = deps.latestNpmVersion ?? ((_pkg: string) => npmViewLatest(npmBin, env));
    version = await latest(NPM_PACKAGE);
    if (version === null) {
      return {
        error: diag("ENV", "001", `could not resolve latest version of ${CLI_PACKAGE_SPEC}`),
      };
    }
  } else {
    version = spec;
  }

  const versionDir = path.join(cacheDir, `${NPM_PACKAGE}@${version}`);
  const binary = cachedBinaryPath(versionDir);
  if (await exists(binary)) {
    const detected = await detect(binary);
    return { target: { spec, kind, binaryPath: binary, version: detected ?? version } };
  }
  const install =
    deps.installToDir ?? ((dir: string, vspec: string) => npmInstallToDir(npmBin, env, dir, vspec));
  const installError = await install(versionDir, `${CLI_PACKAGE_SPEC}${version}`);
  if (installError !== null) {
    return { error: installError };
  }
  if (!(await exists(binary))) {
    return { error: diag("ENV", "001", `npm install produced no binary at ${binary}`) };
  }
  const detected = await detect(binary);
  return { target: { spec, kind, binaryPath: binary, version: detected ?? version } };
}
