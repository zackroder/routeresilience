import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { GTFSRepository } from '../../server/gtfs/database.js'
import { ensureCTAFeedExtracted } from '../../../server/gtfs/loader.js'
import { loadMinimalFixture, ctaTestDbExists } from '../../helpers/fixtures.js'

const REQUIRED_GTFS_FILES = [
  'routes.txt',
  'trips.txt',
  'stops.txt',
  'stop_times.txt',
  'shapes.txt',
  'calendar.txt',
  'calendar_dates.txt',
]

// Loader-pipeline assertions against the deterministic minimal fixture: import
// via the production code path and verify the computed fields (trip bounds,
// terminal stop ids, cross-midnight times, directions inference).
describe('GTFS loader pipeline (minimal fixture)', () => {
  let repo: GTFSRepository

  beforeAll(async () => {
    repo = await loadMinimalFixture()
  })

  afterAll(() => {
    repo.close()
  })

  it('imports the expected counts', () => {
    expect(repo.getRouteCount()).toBe(2)
    expect(repo.getTripCount()).toBe(5)
    expect(repo.getStopCount()).toBe(6)
    // stop_times are the critical dependency — must be populated.
    expect(repo.getStopTimes('trip-trunk-1').length).toBeGreaterThan(0)
  })

  it('computes trip start/end times and stop ids during import', () => {
    const t = repo.getTrip('trip-trunk-1')!
    expect(t.start_time).toBe(11 * 3600)
    expect(t.end_time).toBe(11 * 3600 + 1200)
    expect(t.start_stop_id).toBe('stop-a')
    expect(t.end_stop_id).toBe('stop-e')
    expect(t.end_time).toBeGreaterThan(t.start_time)
  })

  it('parses cross-midnight times during import', () => {
    const t = repo.getTrip('trip-trunk-2')!
    expect(t.start_time).toBe(23 * 3600 + 1800)
    expect(t.end_time).toBe(24 * 3600 + 600)
    expect(t.end_time).toBeGreaterThan(t.start_time)
  })

  it('leaves route directions empty when trips carry no direction names', () => {
    expect(repo.getRoute('route-trunk')!.directions).toBeUndefined()
    expect(repo.getRoute('route-branch')!.directions).toBeUndefined()
  })

  it('keeps only route_type 3 routes', () => {
    expect(repo.getRouteCount()).toBe(2)
  })
})

const RUN_CTA_SMOKE = ctaTestDbExists() || process.env.REBUILD_TEST_DB === '1'

// The full CTA pipeline (download/extract/import) is a scale smoke test: it
// validates real-world feed irregularity at production volume. It is
// network-dependent and only runs when the CTA DB already exists on disk (or
// REBUILD_TEST_DB=1 is set to forcibly rebuild it).
if (RUN_CTA_SMOKE) {
  describe('GTFS loader pipeline (CTA scale smoke)', () => {
    let repo: GTFSRepository

    beforeAll(async () => {
      const { loadCTATestDatabase } = await import('../../helpers/fixtures.js')
      repo = await loadCTATestDatabase({
        rebuild: process.env.REBUILD_TEST_DB === '1',
      })
    })

    afterAll(() => {
      repo.close()
    })

    it('ensureCTAFeedExtracted resolves the CTA CSV directory', async () => {
      const dir = await ensureCTAFeedExtracted()
      expect(fs.existsSync(dir)).toBe(true)
      for (const file of REQUIRED_GTFS_FILES) {
        expect(fs.existsSync(path.join(dir, file))).toBe(true)
      }
    })

    it('the extracted directory contains a populated shapes.txt (required by app)', async () => {
      const dir = await ensureCTAFeedExtracted()
      const shapesPath = path.join(dir, 'shapes.txt')
      const content = fs.readFileSync(shapesPath, 'utf-8')
      // Header plus at least one data row.
      expect(content.trim().split('\n').length).toBeGreaterThan(1)
    })

    it('importing the feed into a repository yields data', () => {
      expect(repo.getRouteCount()).toBeGreaterThan(0)
      expect(repo.getStopCount()).toBeGreaterThan(0)
      expect(repo.getTripCount()).toBeGreaterThan(0)
      const trips = repo.getTripsForRoute(repo.getAllRoutes()[0].route_id, 0)
      expect(trips.length).toBeGreaterThan(0)
      expect(repo.getStopTimes(trips[0].trip_id).length).toBeGreaterThan(0)
    })

    it('trip start/end times and stop ids are computed during import', () => {
      const trips = repo.getTripsForRoute(repo.getAllRoutes()[0].route_id, 0)
      const withBounds = trips.find(
        (t) => t.start_time > 0 && t.end_time > 0 && t.start_stop_id && t.end_stop_id
      )
      expect(withBounds).toBeDefined()
      expect(withBounds!.end_time).toBeGreaterThan(withBounds!.start_time)
    })

    it('route directions JSON is inferred during import', () => {
      const routes = repo.getAllRoutes()
      const withDirections = routes.find(
        (r) => r.directions && Object.keys(r.directions).length > 0
      )
      expect(withDirections).toBeDefined()
    })
  })
}
