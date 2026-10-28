import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createTempDir, ensureDir, removeDir } from "../util/dirs.js";
import { generateServerPassword, sandboxEnvironment } from "../util/env.js";

export interface SandboxPaths {
  root: string;
  project: string;
  home: string;
  xdgConfig: string;
  xdgCache: string;
  xdgData: string;
  xdgState: string;
  work: string;
}

export interface SandboxOptions {
  extraPathDirs?: string[];
}

export interface Sandbox {
  paths: SandboxPaths;
  password: string;
  username: string;
  /** PATH value used for the host (first entry is the target binary dir). */
  hostEnv: NodeJS.ProcessEnv;
  configPath: string;
}

export async function createSandbox(
  targetBinaryDir: string,
  opts: SandboxOptions,
): Promise<Sandbox> {
  const root = await createTempDir();
  const paths: SandboxPaths = {
    root,
    project: path.join(root, "project"),
    home: path.join(root, "home"),
    xdgConfig: path.join(root, "config"),
    xdgCache: path.join(root, "cache"),
    xdgData: path.join(root, "data"),
    xdgState: path.join(root, "state"),
    work: path.join(root, "work"),
  };
  for (const dir of Object.values(paths)) {
    await ensureDir(dir);
  }
  const password = generateServerPassword();
  const username = "opencode";
  const configPath = path.join(paths.project, "opencode.json");
  const hostEnv = sandboxEnvironment({
    home: paths.home,
    xdgConfig: paths.xdgConfig,
    xdgCache: paths.xdgCache,
    xdgData: paths.xdgData,
    xdgState: paths.xdgState,
    extraPath: [targetBinaryDir, ...(opts.extraPathDirs ?? [])],
    serverPassword: password,
    serverUsername: username,
  });
  return { paths, password, username, hostEnv, configPath };
}

export function destroySandbox(paths: SandboxPaths): Promise<void> {
  return removeDir(paths.root);
}

/**
 * Writes the sandbox project's opencode.json. The plugin is registered by
 * absolute local path — the verified way to load a materialized artifact
 * "like the published package" without letting OpenCode npm-install into its
 * own data directory.
 *
 * The `{package, options}` config form is deliberately NOT used: verified
 * against OpenCode 2.1.2 and 2.2.0, it does not resolve local paths, relative
 * paths, file:// URLs, node_modules names or tarball paths (it npm-installs
 * registry names only), so a `{package: <local dir>}` entry silently fails to
 * load the plugin. Options reach scenarios via the tool's own config instead
 * (see ADR 0003).
 */
export async function writeProjectConfig(projectDir: string, pluginDir: string): Promise<string> {
  const config = {
    $schema: "https://opencode.ai/config.json",
    plugin: [pluginDir],
  };
  const configPath = path.join(projectDir, "opencode.json");
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}
