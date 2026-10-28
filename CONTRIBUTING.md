# Contributing

## Setup

```bash
npm install
npm run build
npm test
```

## Gates (all must pass before merge)

```bash
npm run typecheck   # tsc, strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
npm run lint        # biome check (format + lint)
npm run test        # vitest with 100% coverage thresholds
npm run build       # tsc build to dist/
npm run smoke       # real opencode run against fixtures/valid
```

## Layout

```
src/domain/       types, config, diagnostics (codes + exit mapping), aggregation
src/util/         process spawn wrappers, env builder, ports, dirs, fetcher
src/package/      manifest, pack, tarball artifact, materialization, checks
src/opencode/     target resolution, API client, sandbox, host boot
src/scenarios/    definePluginTestSuite, loading, execution
src/runner/       per-target pipeline + whole-run orchestration
src/reporters/    pretty | json | junit
src/cli/          bin + init
fixtures/         real plugin packages used by integration tests
tests/            unit tests per module + integration tests
```

## Conventions

- Every failure is a `Diagnostic` with a code from `CODE_CATALOG`. New codes
  must be added to the catalog.
- No silent failure: each diagnostic carries message and, where useful, hint.
- IoC for side-effectful operations (spawn, fetch, npm) so unit tests inject
  fakes; integration tests exercise the real thing.
- Terms come from [GLOSSARY.md](GLOSSARY.md); changes there accompany model
  changes.
