# Glossary

Canonical vocabulary for `@coool/opencode-plugin-test`. Implementation-free by design.

## Plugin Package

The npm package under test: a directory with a `package.json` that declares
an `exports` map with a server part (`.` or `./server`). The thing the user
wants to verify.

## Manifest

The `package.json` of a Plugin Package.

## Packed Artifact

The `.tgz` tarball produced by running `npm pack` on a Plugin Package — the
exact bytes npm would ship. The artifact of record for conformance testing.

## Materialized Package

A directory on disk the OpenCode host can actually load, derived from either
the Packed Artifact (extracted, with runtime dependencies installed when
declared) or, in source mode, the Plugin Package checkout itself.

## OpenCode Target

A specific OpenCode binary the tool tests against: `current` (on PATH),
`latest`, a concrete semver (installed from npm into a cache), or an explicit
binary path.

## Target Matrix

The cross-product of OpenCode Targets × Scenarios that a single run executes.

## Sandbox

A throwaway directory tree (project, config, cache, data, state, home) plus a
minimal environment in which an OpenCode host runs. Sandboxes guarantee the
host can never observe the user's real configuration, plugins, or data.

## Boot Host

The `opencode serve` process launched inside a Sandbox.

## Readiness

The state in which the Boot Host answers `GET /api/plugin` with a non-empty
plugin list (builtins present). OpenCode v2 has no JSON health endpoint;
the plugin list is the readiness probe.

## Feature Surface

A runtime context a plugin can serve: `server`, `tui`, or `rpc`, as exposed
through the exports map and reported by the host.

## Check

A boolean conformance observation about the Manifest, the Packed Artifact,
or the plugin's registration/state on a Boot Host. Checks produce
Diagnostics but never throw.

## Scenario

An author-written behavioral test that runs against a live Boot Host with the
Materialized Package loaded. Scenarios receive a context (plugin status,
authenticated request helper, sandbox paths, options) and fail by throwing.

## Scenario Suite

A named collection of Scenarios declared via `definePluginTestSuite`.

## Diagnostic

A structured observation with a stable code (`PKG###`, `HOST###`, `API###`,
`SCEN###`, `CFG###`, `ENV###`, `SYS###`), a human message, and an optional
hint. The only way the tool reports problems.

## Run Result

The root of the report tree: package checks, one outcome per OpenCode Target,
each holding its checks and scenario outcomes, plus aggregated status and
diagnostics.

## Modes

### Packed Mode

Default mode: test the Packed Artifact. Canonical because it validates what
users actually install.

### Source Mode

Escape hatch: test the Plugin Package checkout directly, skipping packaging.
