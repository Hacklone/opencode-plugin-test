# 0003 — Options reach scenarios via the tool config; the host's `{package, options}` entry cannot register local artifacts

Date: 2026-10-28

## Status

Accepted

## Context

OpenCode v2 documents plugin options via a config entry of the form
`{"package": "<name>", "options": {...}}` (the plugin then receives
`ctx.options` in `setup`). The tool's config therefore had an `options`
field, and the sandbox wrote a `{package, options}` entry into the sandbox
project's `opencode.json` whenever options were configured.

While verifying the tool end-to-end against real hosts, every variant of the
object form with a local artifact failed to load the plugin at all — the
plugin simply never appeared in `GET /api/plugin`:

- `{package: "/abs/path/to/materialized/dir", options}` — OpenCode 2.1.2 and 2.2.0
- `{package: "file:///abs/path", options}` — 2.1.2
- `{package: "./relative/dir", options}` — 2.1.2
- `{package: "npm-name"}` with the package symlinked into the sandbox project's `node_modules` — 2.1.2 and 2.2.0
- `{package: "/abs/path/to/tarball.tgz", options}` — 2.1.2

By contrast, the plain string entry (absolute local path) loads reliably on
both versions and is the basis of ADR 0001.

## Decision

1. `writeProjectConfig` always registers the materialized artifact as a plain
   string entry (absolute local path). The `{package, options}` object form is
   never emitted.
2. The tool's `options` config field is re-scoped: it delivers options to the
   **scenario context** (`ctx.options` inside scenario functions), not to the
   plugin's `setup()`. Scenarios can therefore assert option-driven behavior
   end-to-end against the real artifact.
3. The limitation above is documented (this ADR and the sandbox module docs)
   so future contributors do not re-introduce the object form.

## Consequences

- A plugin author cannot use this tool to verify that `ctx.options` arrives in
  `setup()` for locally registered artifacts, because the host itself has no
  working channel for that combination (verified 2.1.2/2.2.0). When OpenCode
  gains a working local-options channel, the sandbox and this ADR should be
  revisited.
- Scenario authors get options from the tool config — one canonical place,
  independent of host config semantics.
