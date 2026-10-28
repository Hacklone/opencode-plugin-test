# ADR 0002: Sanitized-environment sandbox isolation

Date: 2026-10-28
Status: Accepted

## Context

OpenCode reads global configuration and loads global plugins from the user's
real XDG directories (observed first-hand: a plain `opencode serve` with
inherited environment loaded the user's actual global plugins and wrote its
database and logs into the user's real `XDG_DATA_HOME`). A conformance tool
that spawns real hosts must never touch or observe that environment.

## Decision

The tool constructs the host environment from scratch: `HOME` plus all four
XDG variables (`XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`,
`XDG_STATE_HOME`) point into the per-run sandbox; `PATH` is minimal (target
binary dir + `/usr/bin` + `/bin`); the only other variable passed is the
generated `OPENCODE_SERVER_PASSWORD` (plus `OPENCODE_SERVER_USERNAME`).
Nothing is inherited from the invoking shell.

Readiness and plugin state are established by polling `GET /api/plugin` with
HTTP Basic auth. OpenCode v2 has no JSON health endpoint on the versions in
scope, so the plugin list itself is the readiness probe.

## Consequences

- The user's real global config is unreadable by the host (verified live).
- Host state (db, logs) is fully contained in the sandbox and deleted with it.
- Boot determinism: no user plugins can race with the plugin under test; the
  non-builtin plugin in the list is always the one under test.
- If OpenCode starts requiring additional environment in future versions,
  the minimal env becomes a compatibility risk; the env builder is a single
  function to extend.

Alternatives considered: inheriting env and filtering (rejected: one missed
variable breaks isolation invisibly), container runtimes (rejected: heavy
dependency for a dev tool).
