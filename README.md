# opencode-plugin-test

A standalone dev tool and test library that verifies **OpenCode v2 plugins**
against their **real packed npm artifact** and **real OpenCode releases** in
fully isolated sandboxes.

```
npm install --save-dev opencode-plugin-test
opencode-plugin-test
```

## Why

OpenCode v2 loads plugins from npm packages with an `exports` map. Plenty of
things can go wrong between "works in my editor" and "works on a user's
machine": files missing from the tarball, exports pointing at nothing,
`setup()` throwing, options not arriving, TUI/RPC surfaces not registering.

This tool catches those problems by doing what a user's machine does:

1. **Discovers** your Plugin Package (directory with a `package.json`).
2. **Packs** it with `npm pack` — the exact bytes npm ships.
3. **Inspects** the tarball: every export target must be present in the
   packed artifact (catches overzealous `files` fields).
4. **Materializes** the artifact (extract + `npm install` of declared runtime
   dependencies) and registers it in a **Sandbox** — a throwaway project with
   its own `opencode.json`, isolated from your real global config by a fully
   sanitized environment.
5. **Boots a real OpenCode host** (`opencode serve`) in the sandbox with a
   generated password and waits for **Readiness** (the plugin list becoming
   non-empty — OpenCode v2 has no JSON health endpoint).
6. **Verifies** your plugin registers on the host with `state: active` and
   exposes the declared **Feature Surfaces** (`server`, `tui`, `rpc`).
7. **Runs your Scenarios** against the live host, then tears everything down.

Nothing outside the sandbox is ever touched or observed: your global
`~/.config/opencode`, plugins, database, and caches are invisible to the host.

## Quick start

```bash
# in your plugin repo
opencode-plugin-test --init
# edit plugin-test.scenarios.ts, then:
opencode-plugin-test
```

Exit codes: `0` pass, `1` a check or scenario failed, `2` invalid invocation /
config / environment error.

### Scenarios

Scenarios are author-written behavioral tests that run against a live host
with your real artifact loaded:

```ts
// plugin-test.scenarios.ts
import { definePluginTestSuite } from "opencode-plugin-test";

export default definePluginTestSuite({
  name: "my-plugin",
  scenarios: {
    "registers-active": async ({ plugin }) => {
      if (plugin.state.status !== "active") {
        throw new Error(`plugin is ${plugin.state.status}`);
      }
    },
    "creates-session": async ({ request }) => {
      const res = await request("/api/session", { method: "POST" });
      if (res.status !== 200) throw new Error(`got ${res.status}`);
    },
  },
});
```

The scenario context gives you `plugin` (live status), `request` (an
authenticated helper against the sandbox server), `target` (which OpenCode
version is running), `paths` (sandbox locations), and `options` (plugin
options from the config).

### Configuration

`plugin-test.config.json` next to your `package.json` (all keys optional):

```jsonc
{
  "targets": ["current", "latest", "2.1.2"], // OpenCode versions to test against
  "mode": "packed", // or "source" (skip packaging)
  "surfaces": ["server"], // features that must register
  "scenarios": "./plugin-test.scenarios.ts", // scenario module path
  "scenarioFilter": [], // subset of scenario names
  "bootTimeoutMs": 60000,
  "scenarioTimeoutMs": 30000,
  "reporter": "pretty", // pretty | json | junit
  "keepSandbox": false, // keep sandbox dirs for debugging
  "options": {}, // options delivered to scenario context (ADR 0003)
  "expectedPluginId": null // match plugin by id instead of path
}
```

CLI flags override the file: `--target` (repeatable), `--source`,
`--scenario` (repeatable), `--reporter`, `--output`, `--boot-timeout-ms`,
`--scenario-timeout-ms`, `--keep-sandbox`, `--init [dir]`, `--help`,
`--version`.

### Library use

```ts
import { runPluginTests, definePluginTestSuite } from "opencode-plugin-test";

const run = await runPluginTests({
  packageRoot: process.cwd(),
  suites: [
    definePluginTestSuite({
      name: "t",
      scenarios: {
        /* ... */
      },
    }),
  ],
});
if (run.status === "fail") process.exit(1);
```

### Diagnostics

Every problem is a structured `Diagnostic` with a stable code:

| Family    | Meaning                                                                                                   |
| --------- | --------------------------------------------------------------------------------------------------------- |
| `PKG###`  | package / packed artifact problems (missing files, bad manifest, pack/install failures)                   |
| `HOST###` | host boot/registration problems (server exited, readiness timeout, plugin failed setup, missing surfaces) |
| `API###`  | HTTP problems against the host server                                                                     |
| `SCEN###` | scenario authoring/execution problems                                                                     |
| `CFG###`  | invocation/configuration problems (exit 2)                                                                |
| `ENV###`  | OpenCode target problems (install failure, missing binary) (exit 2)                                       |
| `SYS###`  | unexpected internal errors (exit 2)                                                                       |

The full catalog with descriptions lives in
[`src/domain/diagnostics.ts`](src/domain/diagnostics.ts) (`CODE_CATALOG`).

### Reporters

- `pretty` (default): human summary.
- `json`: the complete `RunResult` — machine readable.
- `junit`: JUnit XML for CI.

## Test pyramid

- **Unit**: every module tested exhaustively (100% line/branch/function/statement
  coverage enforced) with injected fakes for processes, npm, and HTTP.
- **Integration**: real `opencode serve` boots against real fixture plugins —
  happy path, missing packed files, invalid exports, startup throws, failed
  runtime deps, options delivery, scenario suites — verifying exit codes and
  diagnostics end to end.

## Design decisions

- [ADR 0001](docs/adr/0001-register-materialized-artifacts-by-local-path.md):
  artifacts register by extracted local path, not via host-side npm install.
- [ADR 0002](docs/adr/0002-sanitized-environment-sandbox-isolation.md):
  sandboxes use a from-scratch sanitized environment; readiness comes from
  polling `GET /api/plugin`.

See [GLOSSARY.md](GLOSSARY.md) for canonical vocabulary and
[CONTRIBUTING.md](CONTRIBUTING.md) for development workflows.
