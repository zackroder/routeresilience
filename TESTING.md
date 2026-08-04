# Testing

## Current State

The repository uses Vitest, ESLint, Prettier, Husky/lint-staged, and GitHub
Actions. The current suite has 110 passing tests in 10 files.

Verification commands:

```bash
npm run test:run
npm run test:coverage
npm run lint
npm run format:check
npm run build
```

The suite currently reports useful coverage for stores, detour logic, headway
calculations, simulation controls, GTFS repository queries, and API contracts.
The coverage percentage is not a quality target; assertion quality takes
priority over adding test count or reaching a percentage threshold.

## Test Data Policy

Use the smallest data source that can prove the behavior under test.

### Synthetic fixture: default for focused tests

Add a small authored fixture under `src/test/fixtures/gtfs-minimal/`. It should
be committed as plain text CSV so changes are reviewable and no download is
needed. The fixture should contain:

- Two routes sharing a trunk and then branching.
- At least one route with populated `shapes.txt` and shape points in order.
- One trip with three or more stops and predictable times.
- Two trips in the same block, including a cross-midnight time if supported.
- Weekday calendar service plus a `calendar_dates` addition and removal.
- One frequency-based trip if the loader supports `frequencies.txt` behavior.
- At least one trip without a shape, to test the fallback path explicitly.

Keep identifiers stable and descriptive, for example `route-trunk`,
`trip-east-1`, `stop-a`, and `shape-trunk-east`. Add a fixture builder helper
only if maintaining the CSV by hand becomes harder than the behavior it
describes. Import it into an in-memory repository for unit tests and a temporary
file repository for persistence/reopen tests.

The committed Google GTFS sample remains optional for parser/conformance
cases. It has a header-only `shapes.txt`, so it must not be used to prove shape
loading, shape stitching, route geometry, or simulation movement along shapes.
Source: https://github.com/google/transit/blob/master/gtfs/spec/en/examples/sample-feed-1.zip

### CTA feed: scale smoke test only

The CTA feed is a realistic, production-sized smoke test. It is downloaded and
cached as `data/test/gtfs.db`, opened read-only, and should not be the default
dependency of focused tests. It validates scale, real-world feed irregularity,
and production-like query behavior. It is mutable and network-dependent, so CI
should eventually run it separately or use a pinned checksum/artifact.

Force a one-time rebuild before workers start with:

```bash
REBUILD_TEST_DB=1 npm run test:run
```

The global setup owns this rebuild. Test workers must only open the resulting
database read-only.

## Assertion Remediation Plan

The first priority is replacing tests that can pass without testing their stated
behavior. Do this before adding broad new suites.

### Step 1: Make existing tests non-vacuous

- `src/test/unit/gtfs/database.test.ts`: select a known fixture trip, assert
  stop times are non-empty, and assert exact ascending sequences. Replace the
  route-id-as-trip-id lookup.
- `src/test/unit/gtfs/loader.test.ts`: replace `if (...) return` with explicit
  preconditions and assertions for computed bounds, stop IDs, and directions.
- `src/test/unit/detour/engine.test.ts`: use known fixture corridors and assert
  affected trip IDs, modified stop order, skipped stops, and replacement times.
- `src/test/unit/api/routes.test.ts`: derive IDs from the fixture or repository
  setup instead of hard-coding CTA route `1`; assert response contents where
  the setup guarantees data.
- Replace assertions such as `Array.isArray(value)` or `length >= 0` with a
  known result, or document explicitly that the test is only a smoke test.
- Remove every conditional early return from tests unless the test is
  deliberately a property over an empty result, in which case assert that
  empty result directly.

### Step 2: Move focused suites to the synthetic fixture

Prioritize GTFS repository, loader, detour engine, and API setup. Each test
should arrange only the rows needed for its behavior and assert both positive
and negative cases. CTA-backed tests should be renamed or tagged as scale
smoke tests so their runtime and data dependency are honest.

### Step 3: Add missing high-value contracts

- GTFS-RT feed generation and protobuf encode/decode, including detour and
  replacement trip entities.
- API authentication and rate limiting middleware.
- OSRM success, timeout, malformed response, and no-route behavior.
- Simulation detour shape stitching and no-shape fallback.

## Isolation Rules

- Prefer `createInMemoryRepository()` for unit tests.
- Use temporary file repositories only when persistence or reopening matters.
- Store tests must use isolated temporary directories.
- Avoid process-global test configuration such as `PERSISTENT_DATA_DIR` when a
  constructor dependency can be introduced.
- External HTTP services must be mocked; tests must not require OSRM or a live
  network except for the explicitly separate CTA smoke test.

## Organization

This file is the canonical testing document. `README.md` contains only the
quick-start commands, while `AGENTS.md` contains contributor conventions. Do
not create separate plan, handoff, or retrospective documents for routine test
infrastructure changes; update this file instead.

Manual scripts under `src/test/e2e/` and `src/test/verification/` are not
Vitest tests because they do not use `*.test.ts`. Move them to `scripts/` or
give them explicit npm commands if they remain useful.
