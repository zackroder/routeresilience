# GTFS Test Fixtures

This directory holds small, self-contained GTFS static feeds for focused
loader and edge-case tests. Each feed is imported into an isolated in-memory
or temp-file SQLite database by the helpers in `src/test/helpers/` — these
tests never touch the development database at `data/gtfs.db`.

The CTA feed is intentionally not stored here. It is a scale smoke test and is
downloaded and cached as `data/test/gtfs.db`; it should not be the default data
source for unit tests.

## Feeds

| File / dir                    | Source                                                              | Notes                                    |
| ----------------------------- | ------------------------------------------------------------------- | ---------------------------------------- |
| `gtfs-sample.zip`             | [Google GTFS sample-feed-1](https://github.com/google/transit/blob/master/gtfs/spec/en/examples/sample-feed-1.zip) | Small conformance fixture; `shapes.txt` is header-only. |
| `gtfs-minimal/`               | Authored synthetic fixture                                          | Primary deterministic fixture with populated shapes and branches. Load via `loadMinimalFixture()`. |
| Curated real-feed subset (planned) | Generated from a pinned CTA feed                              | Secondary robustness fixture, not for ordinary unit tests. |

## Adding a New Feed

1. Download or generate a GTFS `.zip` (or an extracted CSV directory).
2. Place it under `src/test/fixtures/`.
3. Register it in `src/test/helpers/fixtures.ts` by adding an entry to the
   `FEEDS` map with a stable key and the path/source.
4. Reference it from a test via `loadMinimalFixture()` (for the hand-authored
   fixture) or the CTA helpers (`loadCTATestDatabase()`).
5. Update this table.

## Notes

- The Google feed contains `agency.txt`, `calendar.txt`, `calendar_dates.txt`,
  `fare_attributes.txt`, `fare_rules.txt`, `frequencies.txt`, `routes.txt`,
  `shapes.txt`, `stop_times.txt`, `stops.txt`, `trips.txt`.
- The Google sample's header-only `shapes.txt` is useful for missing-shape
  behavior, but it cannot exercise populated shape behavior.
- A curated real-feed subset should preserve all related rows rather than
  taking arbitrary CSV samples. See `TESTING.md` for the selection policy.
