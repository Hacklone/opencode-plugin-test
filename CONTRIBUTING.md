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

## Test structure

- **Unit**: every module tested with injected fakes for processes, npm, and
  HTTP. Coverage thresholds (100% across the board) are enforced in
  `vitest.config.ts`.
- **Integration** (`tests/integration.test.ts`): real `opencode serve` boots
  against real fixture plugins — happy path, missing packed files, invalid
  exports, startup throws, failed runtime deps, options delivery, scenario
  suites — verifying exit codes and diagnostics end to end.

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
