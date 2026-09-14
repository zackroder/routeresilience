# Testing

## Current State

The repository uses Vitest, ESLint, Prettier, Husky/lint-staged, and GitHub
Actions. The current suite has 127 passing tests in 11 files.

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

The committed fixture at `src/test/fixtures/gtfs-minimal/` is the default data
source for focused tests. It is plain text CSV so changes are reviewable and no
download is needed. Load it into a fresh in-memory repository with
`loadMinimalFixture()` from `src/test/helpers/fixtures.ts`, which imports through
the production `importGTFSIntoRepo()` path. A validation test at
`src/test/unit/gtfs/fixture.test.ts` guards the exact counts, IDs, shapes,
service days, block order, and detour/simulation corridors. The fixture contains:

- Two routes sharing a trunk and then branching.
- At least one route with populated `shapes.txt` and shape points in order.
- One trip with three or more stops and predictable times.
- Two trips in the same block, including a cross-midnight time if supported.
- Weekday calendar service plus a `calendar_dates` addition and removal.
- At least one trip without a shape, to test the fallback path explicitly.

Do not add a frequency-based case yet: the current loader does not import
`frequencies.txt`. Add that case only with the loader feature and its tests.

Keep identifiers stable and descriptive, for example `route-trunk`,
`trip-east-1`, `stop-a`, and `shape-trunk-east`. Add a fixture builder helper
only if maintaining the CSV by hand becomes harder than the behavior it
describes. Import it into an in-memory repository for unit tests and a temporary
file repository for persistence/reopen tests.

The initial fixture must provide these files and headers:

- `agency.txt`: `agency_id,agency_name,agency_url,agency_timezone`
- `routes.txt`: `route_id,route_short_name,route_long_name,route_type`
- `stops.txt`: `stop_id,stop_name,stop_lat,stop_lon`
- `trips.txt`: `route_id,service_id,trip_id,direction_id,trip_headsign,shape_id,block_id`
- `stop_times.txt`: `trip_id,arrival_time,departure_time,stop_id,stop_sequence`
- `shapes.txt`: `shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence`
- `calendar.txt`: weekday flags plus `service_id,start_date,end_date`
- `calendar_dates.txt`: `service_id,date,exception_type`

Use `route_type=3`, fixed service dates such as `20260715`, and easy-to-reason
about times. Use stable IDs such as `route-trunk`, `route-branch`,
`trip-trunk-1`, `trip-branch-1`, `trip-no-shape`, `service-weekday`, `stop-a`,
`stop-b`, `stop-c`, and `shape-trunk`. Keep every referenced ID consistent
across files. Shapes should contain at least four ordered points and stops
should lie along the corresponding geometry.

Fixture acceptance criteria:

- Import completes through `importGTFSIntoRepo()` without special test-only
  parsing or database code.
- Repository counts and known IDs are asserted exactly.
- At least one known trip returns ordered stop times and a populated shape.
- At least one known trip has no shape and exercises fallback behavior.
- `getActiveTrips()` returns a known set on the fixed service date, including
  the calendar exception cases.
- Block streaming returns the expected trips in block/time order.
- Detour tests can identify a known corridor and assert modified stop order.
- Simulation tests can spawn the known service set without depending on CTA
  volume or the current date.

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

### Optional curated real-feed subset

After the synthetic fixture is in use, a small curated subset of CTA can add
real-world irregularity coverage. It should be generated by a checked-in script
from a pinned source version, not produced by taking the first N rows of each
CSV. The script must select a closed set of routes/trips and retain all related
routes, stops, stop times, shapes, services, calendar exceptions, and blocks.
Record the source URL, feed date, selection criteria, and checksum. This is a
secondary fixture for robustness tests, not the fixture used for exact business
logic.

## Fixture Generation Workflow

1. Hand-author the minimal CSV files in `src/test/fixtures/gtfs-minimal/`. (done)
2. Add a fixture loader helper that imports that directory into an in-memory
   repository using the same `importGTFSIntoRepo()` production path. (done:
   `loadMinimalFixture()`)
3. Add a small validation test checking foreign-key-like references, populated
   shapes, ordered stop times, active service, and expected route/trip counts.
   (done: `src/test/unit/gtfs/fixture.test.ts`)
4. Use the fixture in repository, loader, detour, and simulation tests. (done:
   database, loader, detour engine, API routes, headway, simulation)
5. If zip extraction itself needs coverage, create a deterministic zip from
   the directory in a focused test or commit a generated zip alongside the
   reviewable CSV source. Do not make ordinary tests download anything.

## Assertion Remediation Plan

The first priority is replacing tests that can pass without testing their stated
behavior. Do this before adding broad new suites.

### Step 1: Make existing tests non-vacuous (done)

The focused GTFS repository, loader, detour engine, and API route suites were
migrated to the `gtfs-minimal` fixture in Step 2, which replaced the vacuous
assertions below with exact, known results.

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

### Step 2: Move focused suites to the synthetic fixture (done)

GTFS repository, loader, detour engine, API routes, headway service, and
simulation suites now run against the `gtfs-minimal` fixture with exact
assertions. The CTA feed remains only for the scale smoke tests in
`src/test/unit/gtfs/loader.test.ts`, which are named accordingly.

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
