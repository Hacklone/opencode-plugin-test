#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
import { runExitCode } from "../domain/aggregation.js";
import { EXIT_INVOCATION, EXIT_OK, exitCodeForDiagnostics } from "../domain/diagnostics.js";
import { type ReporterName, renderReport } from "../reporters/index.js";
import { type RunEvent, runPluginTests } from "../runner/run.js";
import { runInit } from "./init.js";

const USAGE = `opencode-plugin-test — test OpenCode v2 plugins against real packed artifacts

Usage:
  opencode-plugin-test [packageRoot] [options]

Arguments:
  packageRoot              Package root containing package.json (default: cwd)

Options:
  --config <path>          Config file (default: <packageRoot>/plugin-test.config.json)
  --target <spec>          OpenCode target spec; repeatable ("current", "latest",
                           semver like 2.1.2, or a binary path)
  --source                 Test the source checkout instead of the packed artifact
  --scenario <name>        Only run scenarios matching the name; repeatable
  --reporter <format>      pretty | json | junit (default: pretty)
  --output <file>          Write the report to a file instead of stdout
  --boot-timeout-ms <n>    Host boot/readiness timeout (default: 60000)
  --scenario-timeout-ms <n>  Per-scenario timeout (default: 30000)
  --keep-sandbox           Keep sandbox directories for debugging
  --init [dir]             Generate a starter config + scenarios template
  --help                   Show this help
  --version                Show version

Exit codes:
  0  all checks and scenarios passed
  1  a conformance check or scenario failed
  2  invalid invocation, configuration, environment, or internal error`;

interface ParsedCli {
  packageRoot?: string;
  configPath?: string;
  targets?: string[];
  mode?: "packed" | "source";
  scenarioFilter?: string[];
  reporter?: ReporterName;
  output?: string;
  bootTimeoutMs?: number;
  scenarioTimeoutMs?: number;
  keepSandbox?: boolean;
  init?: string | undefined;
  help?: boolean;
  version?: boolean;
}

let cliError = false;

function parseCli(argv: string[]): ParsedCli {
  // `--init` takes an OPTIONAL value, which parseArgs cannot express in strict
  // mode (a bare `--init` throws "argument missing"). Normalize a bare flag
  // into `--init=.` before parsing; a following non-flag token stays the value.
  const normalized: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--init") {
      const next = argv[i + 1];
      normalized.push(next === undefined || next.startsWith("-") ? "--init=." : "--init");
    } else {
      normalized.push(token);
    }
  }
  const { values, positionals } = parseArgs({
    args: normalized,
    options: {
      config: { type: "string" },
      target: { type: "string", multiple: true },
      source: { type: "boolean" },
      packed: { type: "boolean" },
      scenario: { type: "string", multiple: true },
      reporter: { type: "string" },
      output: { type: "string" },
      "boot-timeout-ms": { type: "string" },
      "scenario-timeout-ms": { type: "string" },
      "keep-sandbox": { type: "boolean" },
      init: { type: "string" },
      help: { type: "boolean" },
      version: { type: "boolean" },
    },
    allowPositionals: true,
  });
  cliError = false;
  const parsed: ParsedCli = {};
  parsed.init = values.init;
  if (positionals.length > 1) {
    cliError = true;
  } else if (positionals.length === 1) {
    parsed.packageRoot = positionals[0]!;
  }
  if (values.config !== undefined) {
    parsed.configPath = values.config;
  }
  if (values.target !== undefined) {
    parsed.targets = [...values.target];
  }
  if (values.source === true) {
    parsed.mode = "source";
  }
  if (values.packed === true) {
    parsed.mode = "packed";
  }
  if (values.scenario !== undefined) {
    parsed.scenarioFilter = [...values.scenario];
  }
  if (values.reporter !== undefined) {
    if (values.reporter === "pretty" || values.reporter === "json" || values.reporter === "junit") {
      parsed.reporter = values.reporter;
    } else {
      cliError = true;
    }
  }
  if (values.output !== undefined) {
    parsed.output = values.output;
  }
  if (values["boot-timeout-ms"] !== undefined) {
    const n = Number(values["boot-timeout-ms"]);
    if (!Number.isFinite(n) || n <= 0) {
      cliError = true;
    } else {
      parsed.bootTimeoutMs = n;
    }
  }
  if (values["scenario-timeout-ms"] !== undefined) {
    const n = Number(values["scenario-timeout-ms"]);
    if (!Number.isFinite(n) || n <= 0) {
      cliError = true;
    } else {
      parsed.scenarioTimeoutMs = n;
    }
  }
  if (values["keep-sandbox"] === true) {
    parsed.keepSandbox = true;
  }
  if (values.help === true) {
    parsed.help = true;
  }
  if (values.version === true) {
    parsed.version = true;
  }
  return parsed;
}

function ownVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg = require("../../package.json") as { version?: string };
  return pkg.version ?? "0.0.0";
}

export async function main(
  argv: string[],
  deps: { runImpl?: typeof runPluginTests } = {},
): Promise<number> {
  const parsed = parseCli(argv);
  if (parsed.help === true) {
    console.log(USAGE);
    return EXIT_OK;
  }
  if (parsed.version === true) {
    console.log(`opencode-plugin-test v${ownVersion()}`);
    return EXIT_OK;
  }
  if (cliError) {
    console.error(USAGE);
    return EXIT_INVOCATION;
  }
  if (parsed.init !== undefined) {
    return runInit(parsed.init);
  }

  const runImpl = deps.runImpl ?? runPluginTests;
  const events: RunEvent[] = [];
  const run = await runImpl({
    packageRoot: parsed.packageRoot,
    overrides: {
      targets: parsed.targets,
      mode: parsed.mode,
      reporter: parsed.reporter,
      scenarioFilter: parsed.scenarioFilter,
      bootTimeoutMs: parsed.bootTimeoutMs,
      scenarioTimeoutMs: parsed.scenarioTimeoutMs,
      keepSandbox: parsed.keepSandbox,
    },
    onEvent: (e) => {
      events.push(e);
      if (e.kind === "phase" && process.env["OPT_VERBOSE"] !== undefined) {
        console.error(`[${e.target}] ${e.phase}`);
      }
    },
  });

  const report = renderReport(run, parsed.reporter ?? "pretty");
  if (parsed.output !== undefined) {
    await writeFile(path.resolve(parsed.output), `${report}\n`, "utf8");
  } else {
    console.log(report);
  }
  void events;
  return runExitCode(run);
}

/* istanbul ignore if */
if (process.env["OPT_ENTRY"] !== "test") {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}

export const __exitCodeForDiagnostics = exitCodeForDiagnostics;
