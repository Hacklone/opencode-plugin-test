import path from "node:path";

export interface SandboxEnvInput {
  home: string;
  xdgConfig: string;
  xdgCache: string;
  xdgData: string;
  xdgState: string;
  /** Directories prepended to PATH (target binary dir first). */
  extraPath: string[];
  serverPassword: string;
  serverUsername?: string;
}

/**
 * Builds a minimal, sanitized environment for the OpenCode host so it can
 * never observe the user's real global config, plugins, or cache. Nothing is
 * inherited: every variable the host gets is listed here.
 */
export function sandboxEnvironment(input: SandboxEnvInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: [...input.extraPath, "/usr/bin", "/bin"].join(path.delimiter),
    HOME: input.home,
    XDG_CONFIG_HOME: input.xdgConfig,
    XDG_CACHE_HOME: input.xdgCache,
    XDG_DATA_HOME: input.xdgData,
    XDG_STATE_HOME: input.xdgState,
    OPENCODE_SERVER_PASSWORD: input.serverPassword,
  };
  if (input.serverUsername !== undefined) {
    env["OPENCODE_SERVER_USERNAME"] = input.serverUsername;
  }
  return env;
}

export function generateServerPassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
