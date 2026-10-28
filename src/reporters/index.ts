import type { RunResult } from "../domain/types.js";
import { renderJson } from "./json.js";
import { renderJunit } from "./junit.js";
import { renderPretty } from "./pretty.js";

export type ReporterName = "pretty" | "json" | "junit";

export function renderReport(run: RunResult, format: ReporterName): string {
  switch (format) {
    case "pretty":
      return renderPretty(run);
    case "json":
      return renderJson(run);
    case "junit":
      return renderJunit(run);
  }
}
