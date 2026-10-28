export { runExitCode, runStatus, targetStatus } from "./domain/aggregation.js";
export type { CliOverrides, TestConfig } from "./domain/config.js";
export {
  CODE_CATALOG,
  type Diagnostic,
  type DiagnosticFamily,
  EXIT_INVOCATION,
  EXIT_OK,
  EXIT_TEST_FAILURE,
} from "./domain/diagnostics.js";
export type {
  CheckOutcome,
  HostSummary,
  OutcomeStatus,
  PluginInfo,
  PluginSource,
  PluginState,
  ResolvedTarget,
  RunMode,
  RunResult,
  ScenarioOutcome,
  TargetOutcome,
} from "./domain/types.js";
export { type ReporterName, renderReport } from "./reporters/index.js";
export { runTarget, type TargetInput } from "./runner/pipeline.js";
export { type RunEvent, type RunPluginTestsOptions, runPluginTests } from "./runner/run.js";
export {
  definePluginTestSuite,
  type PluginTestSuite,
  type Scenario,
  type ScenarioContext,
} from "./scenarios/define.js";
