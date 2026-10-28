import type { ChildProcess, spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { findListeningUrl, runProcess, spawnStreaming } from "../src/util/process.js";

const tempEnv = { ...process.env, OPT_ENTRY: undefined };

// ---------------------------------------------------------------------------
// Fake child process helpers
// ---------------------------------------------------------------------------

interface RecordedEvent {
  event: string;
  cb: (...args: unknown[]) => void;
}

interface FakeChildSpec {
  pid?: number;
  /** Per-signal behavior; throwing here simulates an already-dead child. */
  onKill?: (signal: NodeJS.Signals) => void;
  /** When false the fake child exposes no stdout/stderr streams. */
  pipes?: boolean;
}

function spawnReturning(child: ChildProcess): typeof spawn {
  return vi.fn(() => child) as unknown as typeof spawn;
}

function fakeChild(spec: FakeChildSpec = {}): {
  child: ChildProcess;
  kills: string[];
  events: RecordedEvent[];
} {
  const kills: string[] = [];
  const events: RecordedEvent[] = [];
  const child = {
    stdout:
      spec.pipes === false
        ? undefined
        : {
            on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
              events.push({ event: `stdout:${event}`, cb });
            }),
          },
    stderr:
      spec.pipes === false
        ? undefined
        : {
            on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
              events.push({ event: `stderr:${event}`, cb });
            }),
          },
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      events.push({ event, cb });
    }),
    once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      events.push({ event, cb });
    }),
    kill: vi.fn((signal: NodeJS.Signals) => {
      kills.push(signal);
      if (spec.onKill !== undefined) {
        spec.onKill(signal);
      }
      return true;
    }),
    pid: spec.pid,
    killed: false,
  };
  return { child: child as unknown as ChildProcess, kills, events };
}

function fire(events: RecordedEvent[], event: string, ...args: unknown[]): void {
  const found = events.find((e) => e.event === event);
  if (found !== undefined) {
    found.cb(...args);
  }
}

describe("runProcess", () => {
  it("captures stdout, stderr and exit code", async () => {
    const result = await runProcess({
      cmd: process.execPath,
      args: ["-e", 'console.log("out"); console.error("err"); process.exit(3)'],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 10_000,
    });
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
    expect(result.code).toBe(3);
    expect(result.timedOut).toBe(false);
    expect(result.spawnError).toBeNull();
  });

  it("times out long-running processes", async () => {
    const result = await runProcess({
      cmd: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 100,
    });
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGTERM");
  }, 10_000);

  it("reports spawn errors", async () => {
    const spawnImpl = vi.fn(() => {
      throw new Error("no such binary");
    });
    const result = await runProcess(
      { cmd: "nope", args: [], cwd: process.cwd(), env: process.env, timeoutMs: 1000 },
      { spawnImpl },
    );
    expect(result.spawnError).toContain("no such binary");
  });

  it("handles async spawn errors", async () => {
    const fake = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, cb: (e: Error) => void) => {
        if (event === "error") {
          cb(new Error("boom"));
        }
      }),
      kill: vi.fn(),
      killed: false,
    };
    const spawnImpl = vi.fn(() => fake as never);
    const result = await runProcess(
      { cmd: "x", args: [], cwd: process.cwd(), env: process.env, timeoutMs: 1000 },
      { spawnImpl },
    );
    expect(result.spawnError).toBe("boom");
  });

  it("ignores close once an error already settled the result", async () => {
    const { child, events } = fakeChild();
    const pending = runProcess(
      { cmd: "x", args: [], cwd: process.cwd(), env: process.env, timeoutMs: 1000 },
      { spawnImpl: spawnReturning(child) },
    );
    fire(events, "error", new Error("boom"));
    fire(events, "close", 0, null);
    const result = await pending;
    expect(result.spawnError).toBe("boom");
    expect(result.code).toBeNull();
  });

  it("ignores an error once close already settled the result", async () => {
    const { child, events } = fakeChild();
    const pending = runProcess(
      { cmd: "x", args: [], cwd: process.cwd(), env: process.env, timeoutMs: 1000 },
      { spawnImpl: spawnReturning(child) },
    );
    fire(events, "close", 0, null);
    fire(events, "error", new Error("late boom"));
    const result = await pending;
    expect(result.spawnError).toBeNull();
    expect(result.code).toBe(0);
  });

  it("escalates to SIGKILL after the grace period when the child never dies", async () => {
    vi.useFakeTimers();
    try {
      const { child, kills } = fakeChild({ pid: 4242, pipes: false });
      void runProcess(
        { cmd: "x", args: [], cwd: process.cwd(), env: process.env, timeoutMs: 100 },
        { spawnImpl: spawnReturning(child) },
      );
      await vi.advanceTimersByTimeAsync(700);
      expect(kills).toEqual(["SIGTERM", "SIGKILL"]);
      vi.clearAllTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  it("swallows errors thrown by the SIGKILL escalation", async () => {
    vi.useFakeTimers();
    try {
      const { child, kills } = fakeChild({
        pid: 4242,
        pipes: false,
        onKill: (signal) => {
          if (signal === "SIGKILL") {
            throw new Error("already dead");
          }
        },
      });
      void runProcess(
        { cmd: "x", args: [], cwd: process.cwd(), env: process.env, timeoutMs: 100 },
        { spawnImpl: spawnReturning(child) },
      );
      await vi.advanceTimersByTimeAsync(700);
      expect(kills).toEqual(["SIGTERM", "SIGKILL"]);
      vi.clearAllTimers();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("spawnStreaming", () => {
  it("streams output and supports kill", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "stream-"));
    const handle = spawnStreaming({
      cmd: process.execPath,
      args: [
        "-e",
        'setInterval(()=>console.log("tick"), 50); process.on("SIGTERM", ()=>process.exit(0))',
      ],
      cwd: dir,
      env: process.env,
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(handle.stdout()).toContain("tick");
    await handle.kill();
    const exit = await Promise.race([
      handle.exited,
      new Promise<null>((r) => setTimeout(() => r(null), 2000)),
    ]);
    expect(exit).not.toBeNull();
  }, 10_000);

  it("resolves exited on natural exit", async () => {
    const handle = spawnStreaming({
      cmd: process.execPath,
      args: ["-e", "process.exit(7)"],
      cwd: process.cwd(),
      env: process.env,
    });
    const exit = await handle.exited;
    expect(exit.code).toBe(7);
  }, 10_000);

  it("reports spawn errors and resolves exited", async () => {
    const spawnImpl = vi.fn(() => {
      throw new Error("spawn fail");
    });
    const handle = spawnStreaming(
      { cmd: "nope", args: [], cwd: ".", env: process.env },
      { spawnImpl },
    );
    expect(handle.spawnError).toContain("spawn fail");
    expect(await handle.exited).toEqual({ code: null, signal: null });
    await handle.kill();
  });

  it("kill is a no-op after natural exit", async () => {
    const handle = spawnStreaming({
      cmd: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: process.cwd(),
      env: process.env,
    });
    await handle.exited;
    await handle.kill();
  }, 10_000);

  it("escapes SIGKILL on already-dead processes", async () => {
    const handle = spawnStreaming({
      cmd: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: process.cwd(),
      env: process.env,
    });
    // kill twice: second call hits the exitInfo early return
    await handle.exited;
    await handle.kill();
    await handle.kill();
  }, 10_000);

  it("returns early when the pid-less child kill throws", async () => {
    const { child, kills } = fakeChild({
      pipes: false,
      onKill: () => {
        throw new Error("ESRCH");
      },
    });
    const handle = spawnStreaming(
      { cmd: "x", args: [], cwd: process.cwd(), env: process.env },
      { spawnImpl: spawnReturning(child) },
    );
    await handle.kill();
    expect(kills).toEqual(["SIGTERM"]);
  });

  it("escalates to child SIGKILL after the grace period when close never arrives", async () => {
    vi.useFakeTimers();
    try {
      const { child, kills } = fakeChild({
        pipes: false,
        onKill: (signal) => {
          if (signal === "SIGKILL") {
            throw new Error("already dead");
          }
        },
      });
      const handle = spawnStreaming(
        { cmd: "x", args: [], cwd: process.cwd(), env: process.env },
        { spawnImpl: spawnReturning(child) },
      );
      const killed = handle.kill();
      await vi.advanceTimersByTimeAsync(400);
      await killed;
      expect(kills).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("streams stdout/stderr, records async spawn errors and exposes the child", async () => {
    const { child, events } = fakeChild();
    const handle = spawnStreaming(
      { cmd: "x", args: [], cwd: process.cwd(), env: process.env },
      { spawnImpl: spawnReturning(child) },
    );
    fire(events, "stdout:data", Buffer.from("out "));
    fire(events, "stderr:data", Buffer.from("err "));
    fire(events, "error", new Error("stream boom"));
    fire(events, "close", 0, null);
    const exit = await handle.exited;
    expect(handle.stdout()).toBe("out ");
    expect(handle.stderr()).toBe("err ");
    expect(handle.spawnError).toBe("stream boom");
    expect(handle.child).toBe(child);
    expect(exit).toEqual({ code: 0, signal: null });
  });

  it("escalates to process-group SIGKILL when SIGTERM is ignored", async () => {
    const handle = spawnStreaming({
      cmd: process.execPath,
      args: ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      env: process.env,
    });
    // Let the child finish booting so its SIGTERM handler is registered.
    await new Promise((r) => setTimeout(r, 300));
    await handle.kill();
    const exit = await handle.exited;
    expect(exit.signal).toBe("SIGKILL");
  }, 10_000);
});

describe("findListeningUrl", () => {
  it("extracts the banner URL", () => {
    expect(findListeningUrl("boot...\nserver listening on http://127.0.0.1:4096\n")).toBe(
      "http://127.0.0.1:4096",
    );
  });
  it("returns null when absent", () => {
    expect(findListeningUrl("nothing here")).toBeNull();
  });
});

describe("temp env safety", () => {
  it("uses a plain env object", () => {
    expect(tempEnv).toBeDefined();
    expect(path.basename(path.dirname(path.join(os.tmpdir(), "x")))).toBe(
      path.basename(os.tmpdir()),
    );
  });
});
