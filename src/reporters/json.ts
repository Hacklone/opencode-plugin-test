import type { RunResult } from "../domain/types.js";

export function renderJson(run: RunResult): string {
  return JSON.stringify(run, null, 2);
}
