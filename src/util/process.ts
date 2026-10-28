import { type ChildProcess, spawn } from "node:child_process";

export interface SpawnSpec {
  cmd: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface SpawnResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: string | null;
}

const KILL_GRACE_MS = 500;

/** Runs a process to completion, capturing output. */
export function runProcess(
  spec: SpawnSpec,
  deps: { spawnImpl?: typeof spawn } = {},
): Promise<SpawnResult> {
  const spawnImpl = deps.spawnImpl ?? spawn;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawnImpl(spec.cmd, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({
        code: null,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnError: (e as Error).message,
      });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          try {
            child.kill("SIGKILL");
          } catch {
            // already dead; nothing to do
          }
        }
      }, KILL_GRACE_MS);
    }, spec.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          code: null,
          signal: null,
          stdout,
          stderr,
          timedOut,
          spawnError: e.message,
        });
      }
    });
    child.on("close", (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code, signal, stdout, stderr, timedOut, spawnError: null });
      }
    });
  });
}

export interface StreamingHandle {
  child: ChildProcess;
  /** Accumulated stdout (incrementally useful for banner matching). */
  stdout: () => string;
  stderr: () => string;
  spawnError: string | null;
  kill: () => Promise<void>;
  /** Resolves when the process exits; never rejects. */
  exited: Promise<{ code: number | null; signal: string | null }>;
}

const KILL_GRACE = 300;

/**
 * Spawns a long-lived process (detached in its own process group so teardown
 * can kill the whole tree), streaming output into buffers.
 */
export function spawnStreaming(
  spec: Omit<SpawnSpec, "timeoutMs">,
  deps: { spawnImpl?: typeof spawn } = {},
): StreamingHandle {
  const spawnImpl = deps.spawnImpl ?? spawn;
  let stdout = "";
  let stderr = "";
  let child: ChildProcess | null = null;
  let spawnError: string | null = null;
  let exitInfo: { code: number | null; signal: string | null } | null = null;
  const exitResolvers: Array<(info: { code: number | null; signal: string | null }) => void> = [];
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    exitResolvers.push(resolve);
  });
  const notifyExit = (info: { code: number | null; signal: string | null }): void => {
    // exitResolvers[0] is registered in the Promise executor above, so it is
    // always present by the time an exit can be notified.
    exitResolvers[0]!(info);
  };

  try {
    child = spawnImpl(spec.cmd, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
  } catch (e) {
    spawnError = (e as Error).message;
    exitInfo = { code: null, signal: null };
    notifyExit(exitInfo);
  }

  if (child !== null) {
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (e) => {
      spawnError = e.message;
    });
    child.on("close", (code, signal) => {
      exitInfo = { code, signal };
      notifyExit(exitInfo);
    });
  }

  return {
    get child() {
      return child as ChildProcess;
    },
    stdout: () => stdout,
    stderr: () => stderr,
    get spawnError() {
      return spawnError;
    },
    kill: async () => {
      if (child === null || exitInfo !== null) {
        return;
      }
      const proc = child;
      try {
        if (proc.pid !== undefined) {
          process.kill(-proc.pid, "SIGTERM");
        } else {
          proc.kill("SIGTERM");
        }
      } catch {
        // already dead
        return;
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try {
            if (proc.pid !== undefined) {
              process.kill(-proc.pid, "SIGKILL");
            } else {
              proc.kill("SIGKILL");
            }
          } catch {
            // already dead
          }
          resolve();
        }, KILL_GRACE);
        proc.once("close", () => {
          clearTimeout(t);
          resolve();
        });
      });
    },
    exited,
  };
}

/** Extracts the `server listening on <url>` banner from host output. */
export function findListeningUrl(output: string): string | null {
  const match = /server listening on (http:\/\/[^\s]+)/i.exec(output);
  return match?.[1] ?? null;
}
