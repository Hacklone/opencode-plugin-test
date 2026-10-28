# ADR 0001: Register materialized artifacts by absolute local path

Date: 2026-10-28
Status: Accepted

## Context

The tool must test the plugin's real packed npm artifact against a real
OpenCode host. Two candidate registration strategies:

1. Register the npm package name in the sandbox `opencode.json` and let the
   host `npm install` the plugin into its own data directory.
2. Extract the packed tarball ourselves and register the extracted directory
   by absolute local path.

## Decision

Strategy 2. The tool extracts the tarball, runs `npm install` inside the
extracted directory only when the artifact declares runtime dependencies, and
registers the extracted directory as a local plugin path in the sandbox
project config. OpenCode documents that a local directory with a package.json
`name` + `exports` loads "through them, like the published package".

## Consequences

- Missing files, broken exports, and unresolvable dependencies surface as
  load-time failures of exactly the artifact that will ship — no dependence
  on the host's private install pipeline.
- The host's data directory stays pristine; no network installs are mediated
  by OpenCode itself.
- Fidelity caveat: the host's package-plugin path (`source.type: "package"`)
  is not exercised. Registration-shape differences would not be caught.
  Accepted because the public load contract is the exports map, which both
  paths share.

Alternatives considered: registering the npm name (rejected: opaque install
into host-owned directories, harder diagnostics, network dependence),
`file://` URL entries (equivalent to local path; less explicit in logs).
