# GTFS Test Fixtures

This directory holds small, self-contained GTFS static feeds used by the
automated test suite. Each feed is imported into an isolated in-memory or
temp-file SQLite database by the helpers in `src/test/helpers/` — the tests
never touch the development database at `data/gtfs.db`.

## Feeds

| File / dir                    | Source                                                              | Notes                                    |
| ----------------------------- | ------------------------------------------------------------------- | ---------------------------------------- |
| `gtfs-sample.zip`             | Google "sample-feed-1" (GTFS spec examples)                         | Small, clean, includes `shapes.txt`.     |
| `gtfs-sample-v2/` (planned)   | Second dataset — TBD                                                | For shape-less / frequency-only coverage.|
| `gtfs-sample-v3/` (planned)   | Third dataset — TBD                                                 | For route-branch / headway-topology edge cases. |

## Adding a New Feed

1. Download or generate a GTFS `.zip` (or an extracted CSV directory).
2. Place it under `src/test/fixtures/`.
3. Register it in `src/test/helpers/fixtures.ts` by adding an entry to the
   `FEEDS` map with a stable key and the path/source.
4. Reference it from a test via the `withFeed()` / `importFeed()` helpers.
5. Update this table.

## Notes

- The Google feed contains `agency.txt`, `calendar.txt`, `calendar_dates.txt`,
  `fare_attributes.txt`, `fare_rules.txt`, `frequencies.txt`, `routes.txt`,
  `shapes.txt`, `stop_times.txt`, `stops.txt`, `trips.txt`.
- Feeds without `shapes.txt` (e.g. frequency-based feeds) exercise different
  code paths in `GTFSRepository`/`SimulationEngine` and should be added for
  broader coverage.
