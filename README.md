# @coool/opencode-plugin-test

A test tool for OpenCode v2 plugins. It packs your plugin with `npm pack`,
loads that packed artifact in a real OpenCode host running in a throwaway
sandbox, and tells you whether the plugin actually registers and works —
before your users find out it doesn't.

It works as a CLI (`opencode-plugin-test`) and as a library
(`runPluginTests()`), so you can run it in CI or wire it into your own
tooling.

## Why

OpenCode v2 loads plugins from npm packages with an `exports` map. Several
things break between "works in my editor" and "works on a user's machine":
files missing from the tarball, exports pointing at nothing, `setup()`
throwing, TUI/RPC surfaces not registering. Unit tests never see these
problems because they run against your source, not the packed artifact a
user's OpenCode actually loads.

This tool runs the same path a user's machine runs:

1. Finds your plugin package (a directory with a `package.json`).
2. Packs it with `npm pack` — the same bytes npm ships.
3. Inspects the tarball: every export target must be present (catches
   overzealous `files` fields).
4. Extracts the tarball, installs its declared runtime dependencies, and
   registers it in a sandbox — a throwaway project with its own
   `opencode.json`.
5. Boots a real OpenCode host (`opencode serve`) inside the sandbox with a
   generated password and waits for readiness (the plugin list becoming
   non-empty — OpenCode v2 has no JSON health endpoint).
6. Checks that your plugin registers with `state: active` and exposes the
   feature surfaces you declared (`server`, `tui`, `rpc`).
7. Runs your scenarios against the live host, then tears everything down.

The sandbox is isolated by construction: the host process runs with a
from-scratch environment (fresh `HOME` and XDG directories, no inherited
variables). Your global `~/.config/opencode`, plugins, database, and caches
are never touched or read.

## Install

```bash
npm install --save-dev @coool/opencode-plugin-test
```

## Quick start

```bash
# in your plugin repo
npx opencode-plugin-test --init
# edit plugin-test.scenarios.ts, then:
npx opencode-plugin-test
```

Exit codes: `0` pass, `1` a check or scenario failed, `2` invalid invocation /
config / environment error.

The scenario file imports `@coool/opencode-plugin-test`, so the tool must be
installed in the plugin repo (`npm install --save-dev @coool/opencode-plugin-test`).

### Scenarios

Scenarios are author-written behavioral tests that run against a live host
with your real artifact loaded:

```ts
// plugin-test.scenarios.ts
import { definePluginTestSuite } from "@coool/opencode-plugin-test";

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
  "options": {}, // delivered to the scenario context, not to the plugin (ADR 0003)
  "expectedPluginId": null // match plugin by id instead of path
}
```

Note on `options`: OpenCode v2 cannot load local artifacts through its
`{package, options}` config form, so options configured here reach your
scenario context (`ctx.options`) — not the plugin's `setup()`. See
[ADR 0003](docs/adr/0003-options-reach-scenarios-not-the-plugin-host-entry.md).

CLI flags override the file: `--target` (repeatable), `--source`,
`--scenario` (repeatable), `--reporter`, `--output`, `--boot-timeout-ms`,
`--scenario-timeout-ms`, `--keep-sandbox`, `--init [dir]`, `--help`,
`--version`.

### Library use

```ts
import { runPluginTests, definePluginTestSuite } from "@coool/opencode-plugin-test";

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

Every failure is a structured `Diagnostic` with a stable code:

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

## Design decisions

- [ADR 0001](docs/adr/0001-register-materialized-artifacts-by-local-path.md):
  artifacts register by extracted local path, not via host-side npm install.
- [ADR 0002](docs/adr/0002-sanitized-environment-sandbox-isolation.md):
  sandboxes use a from-scratch sanitized environment; readiness comes from
  polling `GET /api/plugin`.
- [ADR 0003](docs/adr/0003-options-reach-scenarios-not-the-plugin-host-entry.md):
  configured options reach the scenario context, not the plugin host entry —
  the host cannot resolve local paths in its `{package, options}` config form.

See [GLOSSARY.md](GLOSSARY.md) for canonical vocabulary and
[CONTRIBUTING.md](CONTRIBUTING.md) for development workflows (including how
this tool's own tests are organized).
