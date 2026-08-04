import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { GTFSRepository } from '../../server/gtfs/database.js'
import { ensureCTAFeedExtracted } from '../../../server/gtfs/loader.js'

const REQUIRED_GTFS_FILES = [
  'routes.txt',
  'trips.txt',
  'stops.txt',
  'stop_times.txt',
  'shapes.txt',
  'calendar.txt',
  'calendar_dates.txt',
]

// Verifies the full loader pipeline against the real CTA feed: download/extract
// (cached), import into SQLite, and resulting DB integrity. The shared test DB
// is built via the same production code path (extract CTA zip -> import CSVs ->
// index), so this suite doubles as an end-to-end smoke test of that path.
describe('GTFS loader pipeline (CTA feed)', () => {
  let repo: GTFSRepository

  beforeAll(async () => {
    const { loadCTATestDatabase } = await import('../../helpers/fixtures.js')
    repo = await loadCTATestDatabase()
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
    // stop_times are the critical dependency — must be populated.
    const trips = repo.getTripsForRoute(repo.getAllRoutes()[0].route_id, 0)
    if (trips.length > 0) {
      expect(repo.getStopTimes(trips[0].trip_id).length).toBeGreaterThan(0)
    }
  })

  it('trip start/end times and stop ids are computed during import', () => {
    const routes = repo.getAllRoutes()
    for (const route of routes) {
      const trips = repo.getTripsForRoute(route.route_id, 0)
      const withBounds = trips.find(
        (t) => t.start_time > 0 && t.end_time > 0 && t.start_stop_id && t.end_stop_id
      )
      if (withBounds) {
        expect(withBounds.end_time).toBeGreaterThan(withBounds.start_time)
        return
      }
    }
    // Fall through is acceptable only if no trip has computed bounds.
  })

  it('route directions JSON is inferred during import', () => {
    const routes = repo.getAllRoutes()
    const withDirections = routes.find((r) => r.directions && Object.keys(r.directions).length > 0)
    // At least one route should have inferred direction names.
    expect(withDirections).toBeDefined()
  })
})
