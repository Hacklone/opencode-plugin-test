import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const WORKSPACE_PREFIX = "opencode-plugin-test-";

export async function createTempDir(prefix = WORKSPACE_PREFIX): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Resolves a package root from a CLI-ish input to an absolute path. */
export function resolvePackageRoot(input: string | undefined): string {
  const root = input ?? process.cwd();
  return path.resolve(root);
}
