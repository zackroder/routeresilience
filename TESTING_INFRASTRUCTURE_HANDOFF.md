# Testing Infrastructure Handoff

**Date**: 2026-08-04
**Status**: Phase 1 (foundation) + Phase 2 (initial coverage) implemented; Phases 3–5 partially done
**Branch**: `dev`

This document captures what was built, the key decisions and production-code changes, verification results, concerns, and the recommended next steps.

---

## 1. Summary

Implemented the testing infrastructure per `TESTING_INFRASTRUCTURE_PLAN.md`:

- **Vitest** test framework + `@vitest/coverage-v8`
- **ESLint 9** (flat config) + **Prettier** + `eslint-config-prettier`
- **Husky 9** pre-commit hook running **lint-staged**
- **GitHub Actions** CI workflow (format → lint → build → test:coverage)
- **110 tests across 10 files**, all passing
- Test data strategy: the **real CTA GTFS feed** (user's explicit choice) via a shared, cached, read-only test database

**Final verification** (all green on this machine):

| Check            | Result |
| ---------------- | ------ |
| `npm run test:run` | 10 files, 110 tests passed |
| `npm run test:coverage` | 110 passed; all-files lines 20.6% |
| `npm run lint`   | 0 errors (112 warnings, pre-existing) |
| `npm run format:check` | pass (codebase formatted) |
| `npm run build`  | pass (Vite client + `tsc`) |

---

## 2. What Was Built

### 2.1 Test framework & tooling

| File | Purpose |
| ---- | ------- |
| `vitest.config.ts` | Vitest config: `globals`, `globalSetup`, coverage (v8, excludes `src/test/`), 30s test timeout |
| `eslint.config.js` | ESLint 9 flat config. Lenient on purpose (see §4.3). Ignores `dist/`, `data/`, `*.js`, `src/client/**` |
| `.prettierrc.json` | Prettier config matching project style (no semicolons, single quotes, 2-space, trailing commas) |
| `.prettierignore` | `node_modules/`, `dist/`, `data/`, logs, `coverage/` |
| `tsconfig.eslint.json` | Extends `tsconfig.json` to include `src/test/**` for editors/future type-aware linting |
| `.husky/pre-commit` | Runs `npx lint-staged` |
| `.github/workflows/test.yml` | CI: format:check → lint → build → test:coverage + Codecov upload |
| `package.json` | Scripts: `test`, `test:run`, `test:coverage`, `lint`, `lint:fix`, `format`, `format:check`, `prepare` (husky); devDeps added; `lint-staged` block |

### 2.2 Test data strategy (important)

- The **CTA GTFS feed** is used for all tests (per user instruction; toy feeds rejected).
- A **shared read-only test DB** is built **once** from the extracted CTA feed and cached at `data/test/gtfs.db` (~750 MB).
  - Production opens `data/gtfs.db` read-only; tests mirror that pattern with their own copy.
  - Build cost: ~2 minutes one-time (spawn of ~787 vehicles and import). Subsequent test runs reopen in ~70 ms.
- `src/test/global-setup.ts` (Vitest `globalSetup`) builds the DB before any test file runs — avoids races when files run in parallel.
- Rebuild with `REBUILD_TEST_DB=1 npm run test:run`.
- Store isolation: all store-based tests set `PERSISTENT_DATA_DIR` to a fresh temp dir.
- For writable/empty DBs, tests use `createInMemoryRepository()`.

**Planned-but-blocked**: additional GTFS datasets (shape-less/frequency-based feeds). Placeholders exist in `src/test/fixtures/README.md` and the `FEEDS` registry in `src/test/helpers/fixtures.ts`.

### 2.3 Test suites

| Suite | File | Tests |
| ----- | ---- | ----- |
| GTFSRepository (CTA read-only queries) | `src/test/unit/gtfs/database.test.ts` | 19 |
| GTFSRepository (in-memory schema/isolation) | `src/test/unit/gtfs/database.test.ts` | part of above |
| GTFS loader pipeline (zip→extract→import→query) | `src/test/unit/gtfs/loader.test.ts` | 5 |
| CancellationStore | `src/test/unit/detour/cancellations.test.ts` | 9 |
| DetourStore | `src/test/unit/detour/store.test.ts` | 8 |
| DetourEngine | `src/test/unit/detour/engine.test.ts` | 9 |
| InstructionStore | `src/test/unit/instructions/store.test.ts` | 10 |
| HeadwayService (mock VehicleDataSource) | `src/test/unit/headway/service.test.ts` | 7 |
| SeededRng | `src/test/unit/simulation/rng.test.ts` | 6 |
| SimulationEngine (manual mode + seed) | `src/test/unit/simulation/engine.test.ts` | 11 |
| Express API routes (supertest) | `src/test/integration/api/routes.test.ts` | 26 |
| **Total** | | **110** |

Test helpers:
- `src/test/helpers/database.ts` — `createInMemoryRepository()`, `createTempFileRepository()`, `createTempDir()`
- `src/test/helpers/fixtures.ts` — `loadCTATestDatabase()`, `ctaTestDbExists()`, `FEEDS` registry
- `src/test/global-setup.ts` — builds shared test DB once

---

## 3. Production Code Changes Made

These changes were required to make the codebase testable. **All are backward-compatible** and the full build/test suite passes.

### 3.1 `src/server/gtfs/database.ts`
- Added `GTFSRepositoryOptions` with optional `dbPath` and `memory` fields.
- Constructor now honors them (defaults to the existing `data/gtfs.db` path).
- **Why**: tests need isolated DBs without touching dev data.

### 3.2 `src/server/gtfs/loader.ts`
- Extracted import logic into an exported `importGTFSIntoRepo(repo, gtfsDir)`.
- Extracted download/extract into exported `ensureCTAFeedExtracted()` (returns extracted dir).
- Exported `extractZip()`.
- Added `relax_column_count: true` to the CSV parser.
  - **Why**: real-world feeds (including Google's sample feed and ragged CTA rows) omit trailing columns in `stop_times.txt`; strict parsing previously threw "Invalid Record Length" on some feeds. This is a genuine robustness fix, not just a test shim.
- **Why**: tests reuse the exact production loader path.

### 3.3 Store persistence — `detour/store.ts`, `detour/cancellations.ts`, `instructions/store.ts`
- Changed `save()` from async fire-and-forget (`await fs.promises.writeFile`) to **synchronous** `fs.writeFileSync`.
- **Why**: (1) `DetourStore`'s own doc comment already states "All access is synchronous since we're single-threaded"; (2) the async version created a real **data-loss window** — a process exiting right after a mutation could lose the write; (3) tests were flaky because reload-reads raced in-flight writes.
- `cancellations.ts` also got `let current` → `const current` (lint `prefer-const` fix, no behavior change).

### 3.4 Formatting
- Ran `npm run format` across the codebase (one-time). This touched most server/client files (whitespace/line-length only — no logic changes). `src/server/api/routes.ts` needed a second pass.

---

## 4. Findings & Concerns

### 4.1 Test DB is heavy (CTA feed)
- The shared test DB is ~750 MB on disk. CI must download the CTA feed (~68 MB zip) + build it on first run → **several minutes per fresh CI run**.
- **Concern**: outbound access to `transitchicago.com` from CI could be flaky/blocked. Mitigations to consider:
  - GitHub Actions **cache** on `data/` (path cache keyed by a feed hash).
  - Pre-built test DB artifact uploaded somewhere.
  - Fall back to a smaller committed feed for CI only (later, once a shapes-bearing dataset is sourced).
- Local dev impact: after the first build, runs are fast (~30 s total including simulation).

### 4.2 SimulationEngine suite is the slow one (~16–23 s)
- Spawning ~787 vehicles per `beforeEach` takes ~5.5 s each; the determinism test spawns twice.
- Acceptable now; if it grows, reduce scope via `vi.spyOn`/smaller routes or cache spawns.

### 4.3 Lint is warnings-heavy (112 warnings, 0 errors)
- Warnings are dominated by `no-console` and `@typescript-eslint/no-explicit-any` in **pre-existing** server code (it logs heavily and casts a lot).
- Per plan risk-mitigation, we start lenient (`warn` not `error`) and tighten over time. Recommended tightening path in §6.
- `no-console` is set to allow `warn`/`error` only, which will flag `console.log` in new code — a useful gate for new work.

### 4.4 Coverage thresholds
- All-files coverage is **20.6% lines** because client, `scripts/`, `types.ts`, `proto.ts`, `feed.ts`, and `index.ts` are untested. **Server logic coverage is much better**: `detour/` 77%, `headway/` 80%, `gtfs/database.ts` 92%, `simulation/` 67%, `instructions/store.ts` 92%, `api/routes.ts` 53%.
- No thresholds enforced yet (per plan: track for visibility first, then set at ~30% after a month).

### 4.5 Coverage config
- Coverage excludes `src/test/`, `node_modules/`, `dist/`, `**/*.test.ts`, `**/*.d.ts`. It does **not** exclude client/scripts yet — that drags the headline number down. Consider excluding `src/client/**` and `scripts/**` from the coverage report so the headline reflects server code.

### 4.6 Legacy files handled
- Deleted root one-off scripts: `test-api.ts`, `test-blocks-details.ts`, `test-persistence.ts`, `test-stitching.ts`, `debug-db.ts`, `rewrite.sh`, `scratch/`. Useful logic (blocks endpoint) migrated into `routes.test.ts`.
- Deleted `src/test/unit/GTFSRepository.test.ts` (manual console script that touched the dev DB; superseded by real suites).
- `src/test/e2e/workflow.ts` and `src/test/verification/benchmark.ts` remain but are **not** `*.test.ts` so Vitest ignores them. They are manual scripts — consider moving to `scripts/` for consistency.

### 4.7 Google sample feed still present
- `src/test/fixtures/gtfs-sample.zip` was downloaded early on but is **not used** (user chose CTA). It is small (3 KB) and harmless; either keep as a placeholder or delete. Its `shapes.txt` is header-only, so it can't serve shape-dependent tests anyway.

### 4.8 `git status` shows many modified files
- The one-time `npm run format` touched most files. This is intentional per plan §5/4.1 ("single chore: apply formatting..."). Recommend committing the formatting separately from the feature/test work for a clean history.

---

## 5. Commands

```bash
npm install            # installs everything incl. new devDeps
npm run test           # watch mode
npm run test:run       # once (fast after first DB build)
npm run test:coverage  # once + coverage report
REBUILD_TEST_DB=1 npm run test:run   # force rebuild shared test DB
npm run lint / lint:fix
npm run format / format:check
npm run build
```

---

## 6. Recommended Next Steps

Short term (high value):
1. **Commit this work** in logical commits (see §4.8) — e.g. `feat(tests): add vitest + initial suites`, `chore: apply prettier formatting`, `refactor: testable GTFS repo/loader`, `fix: make store saves synchronous`.
2. **CI smoke**: push to `dev` and watch `.github/workflows/test.yml`. Confirm CTA download works in CI; if not, add a `data/` cache or pre-built DB.
3. **Add a second/third GTFS dataset** (shape-less / frequency-based) once sourced, to widen loader & simulation coverage. Register in `FEEDS` in `src/test/helpers/fixtures.ts`.
4. **Coverage for gap areas**: `feed.ts` (GTFS-RT generator), `proto.ts` (encode/decode), `prediction engine` edge cases, `simulation` detour-shape stitching, `api/middleware.ts` (auth + rate limit).

Medium term:
5. Add tests for `realtime/feed.ts` + `proto.ts` (feed content assertions — high value, currently 0%).
6. Add `scripts/`-style coverage exclusions or move `e2e/`/`verification/` scripts to `scripts/`.
7. Tighten lint gradually: enable `@typescript-eslint/no-explicit-any` as error only for new files, or add per-directory overrides for `scripts/`.
8. Set coverage thresholds (~30%) after a month of usage.

Longer term (matches plan):
9. OSRM HTTP mocking with `nock`/`msw` when detour path routing is tested against the real OSRM dependency (not yet exercised).
10. Client-side tests (`jsdom`/`happy-dom`) — out of scope for now; server-first per plan.
11. Consider `vitest --ui` / watch-based dev workflow adoption.

---

## 7. Files Added (new)

- `.github/workflows/test.yml`
- `.husky/pre-commit` (+ husky-generated `.husky/_/*`)
- `.prettierrc.json`, `.prettierignore`, `eslint.config.js`, `tsconfig.eslint.json`
- `vitest.config.ts`
- `src/test/global-setup.ts`
- `src/test/helpers/database.ts`, `src/test/helpers/fixtures.ts`
- `src/test/fixtures/README.md`, `src/test/fixtures/gtfs-sample.zip` (unused)
- `src/test/unit/gtfs/{database,loader}.test.ts`
- `src/test/unit/detour/{cancellations,store,engine}.test.ts`
- `src/test/unit/instructions/store.test.ts`
- `src/test/unit/headway/service.test.ts`
- `src/test/unit/simulation/{rng,engine}.test.ts`
- `src/test/integration/api/routes.test.ts`

## 8. Files Modified

- `package.json`, `package-lock.json` (scripts + devDeps)
- `src/server/gtfs/database.ts`, `src/server/gtfs/loader.ts`
- `src/server/detour/store.ts`, `src/server/detour/cancellations.ts`
- `src/server/instructions/store.ts`
- `README.md`, `AGENTS.md`, `.gitignore`
- Many server/client files reformatted by Prettier (whitespace only)

## 9. Files Deleted

- `test-api.ts`, `test-blocks-details.ts`, `test-persistence.ts`, `test-stitching.ts`, `debug-db.ts`, `rewrite.sh`, `scratch/`
- `src/test/unit/GTFSRepository.test.ts`

---

## 10. Open Questions for the User

1. **CI strategy for the CTA feed** — is a multi-minute, network-dependent first CI run acceptable, or should we add a GitHub Actions cache / pre-built DB?
2. **Where to put the new GTFS dataset(s)** you're sourcing — provide the URL/zip and I'll wire it into `FEEDS` + add shape/loading tests.
3. **Commit plan** — want me to split into the recommended commit sequence, or bundle as fewer commits?
4. **Coverage scoping** — should the coverage report exclude `src/client/**` and `scripts/**` so the headline reflects server code?
