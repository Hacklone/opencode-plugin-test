/**
 * Diagnostic model. Every failure the tool produces is a `Diagnostic` carrying a
 * stable machine-readable code from the catalog below.
 *
 * Families:
 * - PKG   — problems with the plugin package or its packed artifact
 * - HOST  — problems booting/observing the OpenCode host
 * - API   — problems talking to the OpenCode server API
 * - SCEN  — problems with scenarios (authoring, loading, execution)
 * - CFG   — invocation/configuration problems (exit code 2)
 * - ENV   — environment/target problems such as OpenCode installs (exit code 2)
 * - SYS   — unexpected internal errors (exit code 2)
 */
export type DiagnosticFamily = "PKG" | "HOST" | "API" | "SCEN" | "CFG" | "ENV" | "SYS";

export interface Diagnostic {
  code: string;
  family: DiagnosticFamily;
  message: string;
  hint?: string;
}

/** Exit code when every check passed. */
export const EXIT_OK = 0;
/** Exit code when a plugin conformance/test failure was detected. */
export const EXIT_TEST_FAILURE = 1;
/** Exit code for invocation, configuration, environment or internal errors. */
export const EXIT_INVOCATION = 2;

/**
 * The authoritative catalog of diagnostic codes. Descriptions here feed the
 * documentation and tests assert that every raised code is cataloged.
 */
export const CODE_CATALOG: Readonly<Record<string, string>> = {
  PKG001: "package.json could not be read",
  PKG002: "package.json is not valid JSON",
  PKG003: "package.json is missing the name field",
  PKG004: "package.json version is missing or not a valid semver",
  PKG005: "package.json has no exports map",
  PKG006: "no server export (. or ./server) in the exports map",
  PKG007: "exported file missing from the packed tarball",
  PKG008: "npm pack failed",
  PKG009: "@opencode/plugin declared as runtime dependency (host injects it)",
  PKG010: "tarball extraction failed",
  PKG011: "npm install of runtime dependencies failed",
  PKG012: "package is not an ES module (type: module)",
  HOST001: "OpenCode server process failed to spawn",
  HOST002: "OpenCode server did not become ready in time",
  HOST003: "OpenCode server exited before becoming ready",
  HOST004: "could not determine the OpenCode binary version",
  HOST005: "plugin was not discovered by the OpenCode host",
  HOST006: "plugin failed during setup on the host",
  HOST007: "plugin does not expose all declared feature surfaces",
  API001: "HTTP request to the OpenCode server failed",
  API002: "OpenCode server rejected the credentials",
  SCEN001: "scenario failed",
  SCEN002: "scenario timed out",
  SCEN003: "scenario suite could not be loaded",
  CFG001: "configuration file is invalid",
  CFG002: "configuration file could not be read",
  CFG003: "invalid CLI invocation",
  ENV001: "OpenCode target installation failed",
  ENV002: "OpenCode target spec is invalid or binary missing",
  SYS001: "unexpected internal error",
};

const FAMILY_EXIT: Readonly<Record<DiagnosticFamily, number>> = {
  PKG: EXIT_TEST_FAILURE,
  HOST: EXIT_TEST_FAILURE,
  API: EXIT_TEST_FAILURE,
  SCEN: EXIT_TEST_FAILURE,
  CFG: EXIT_INVOCATION,
  ENV: EXIT_INVOCATION,
  SYS: EXIT_INVOCATION,
};

export function diag(
  family: DiagnosticFamily,
  code: string,
  message: string,
  hint?: string,
): Diagnostic {
  const full = `${family}${code}`;
  if (!(full in CODE_CATALOG)) {
    throw new Error(`Unknown diagnostic code ${full}; add it to CODE_CATALOG`);
  }
  const d: Diagnostic = { code: full, family, message };
  if (hint !== undefined) {
    d.hint = hint;
  }
  return d;
}

/** Highest-severity exit code implied by a set of diagnostics (0 when empty). */
export function exitCodeForDiagnostics(diagnostics: readonly Diagnostic[]): number {
  let worst = EXIT_OK;
  for (const d of diagnostics) {
    const exit = FAMILY_EXIT[d.family];
    if (exit > worst) {
      worst = exit;
    }
  }
  return worst;
}
