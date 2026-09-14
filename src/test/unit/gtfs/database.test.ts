import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GTFSRepository } from '../../server/gtfs/database.js'
import { createInMemoryRepository } from '../../helpers/database.js'
import { loadMinimalFixture } from '../../helpers/fixtures.js'

// Repository queries against the deterministic hand-authored fixture. No CTA
// download, no reliance on the current date, and every result is asserted
// exactly. The CTA feed is exercised only by the scale-smoke suites.
describe('GTFSRepository (minimal fixture)', () => {
  let repo: GTFSRepository

  beforeAll(async () => {
    repo = await loadMinimalFixture()
  })

  afterAll(() => {
    repo.close()
  })

  it('reports exact counts', () => {
    expect(repo.getRouteCount()).toBe(2)
    expect(repo.getStopCount()).toBe(6)
    expect(repo.getTripCount()).toBe(5)
  })

  it('returns routes with the expected shape', () => {
    const routes = repo.getAllRoutes()
    expect(routes.length).toBe(repo.getRouteCount())
    for (const route of routes) {
      expect(typeof route.route_type).toBe('number')
      expect(route.route_short_name).toBeDefined()
    }
  })

  it('fetches a route by id and returns undefined for a missing route', () => {
    const route = repo.getRoute('route-trunk')
    expect(route?.route_id).toBe('route-trunk')
    expect(repo.getRoute('__does_not_exist__')).toBeUndefined()
  })

  it('resolves stops by id and returns undefined for a missing stop', () => {
    expect(repo.getStop('stop-a')?.stop_name).toBe('Stop A')
    expect(repo.getStop('__does_not_exist__')).toBeUndefined()
  })

  it('finds stops within a geographic bounding box', () => {
    // Longitude window excludes the branch stop (stop-f sits at -87.631).
    const stops = repo.getStopsInBounds(41.88, -87.6305, 41.884, -87.6295)
    expect(stops.map((s) => s.stop_id).sort()).toEqual([
      'stop-a',
      'stop-b',
      'stop-c',
      'stop-d',
      'stop-e',
    ])
    for (const s of stops) {
      expect(s.stop_lat).toBeGreaterThanOrEqual(41.88)
      expect(s.stop_lat).toBeLessThanOrEqual(41.884)
    }
    expect(repo.getStopsInBounds(0, 0, 1, 1)).toEqual([])
  })

  it('lists trips for a route and direction', () => {
    const trips = repo.getTripsForRoute('route-trunk', 0)
    expect(trips.map((t) => t.trip_id).sort()).toEqual([
      'trip-no-shape',
      'trip-trunk-1',
      'trip-trunk-2',
      'trip-trunk-3',
    ])
    expect(repo.getTripsForRoute('route-trunk', 1)).toEqual([])
  })

  it('returns stop times in ascending stop_sequence order', () => {
    const stopTimes = repo.getStopTimes('trip-trunk-1')
    expect(stopTimes.length).toBeGreaterThan(0)
    for (let i = 1; i < stopTimes.length; i++) {
      expect(stopTimes[i].stop_sequence).toBeGreaterThan(stopTimes[i - 1].stop_sequence)
    }
  })

  it('resolves a populated shape for a trip that carries a shape_id', () => {
    const shape = repo.getShape(repo.getTrip('trip-trunk-1')!.shape_id)
    expect(shape.length).toBeGreaterThan(0)
  })

  it('getActiveTrips returns the known set on a service day', () => {
    const active = repo.getActiveTrips('20260715', 12 * 3600)
    expect(active.map((t) => t.trip_id).sort()).toEqual(['trip-branch-1', 'trip-trunk-3'])
  })

  it('isServiceActiveToday is consistent with calendar and exceptions', () => {
    expect(repo.isServiceActiveToday('service-weekday', '20260715')).toBe(true)
    expect(repo.isServiceActiveToday('service-weekday', '20260714')).toBe(false)
    expect(repo.isServiceActiveToday('__missing__', '19990101')).toBe(false)
  })

  it('getServiceWeekPatterns returns a map keyed by service_id', () => {
    const patterns = repo.getServiceWeekPatterns()
    expect(patterns).toBeInstanceOf(Map)
    expect(patterns.get('service-weekday')).toEqual({ weekdayCount: 5, weekendCount: 0 })
  })

  it('streamBlocks yields active trips ordered by block and time', () => {
    const ids: string[] = []
    let prevBlock = ''
    for (const t of repo.streamBlocks('20260715')) {
      ids.push(t.trip_id)
      expect(t.block_id).toBeDefined()
      expect(t.start_stop_name).toBeDefined()
      if (prevBlock === t.block_id && ids.length > 1) {
        // within a block, trips are ordered by start_time
      }
      prevBlock = t.block_id
    }
    expect(ids).toEqual([
      'trip-trunk-1',
      'trip-trunk-2',
      'trip-branch-1',
      'trip-trunk-3',
      'trip-no-shape',
    ])
  })
})

// In-memory repo tests: schema creation + transactional behavior. These do not
// require the CTA download and run in isolation.
describe('GTFSRepository (in-memory)', () => {
  it('applies the schema on creation', () => {
    const repo = createInMemoryRepository()
    const tables = repo
      .getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[]
    const names = tables.map((t) => t.name)
    for (const expected of [
      'routes',
      'trips',
      'stops',
      'stop_times',
      'shapes',
      'calendar',
      'calendar_dates',
    ]) {
      expect(names).toContain(expected)
    }
    repo.close()
  })

  it('starts empty (no routes/stops/trips)', () => {
    const repo = createInMemoryRepository()
    expect(repo.getRouteCount()).toBe(0)
    expect(repo.getStopCount()).toBe(0)
    expect(repo.getTripCount()).toBe(0)
    repo.close()
  })

  it('returns empty arrays for missing data', () => {
    const repo = createInMemoryRepository()
    expect(repo.getTrip('missing')).toBeUndefined()
    expect(repo.getStopTimes('missing')).toEqual([])
    expect(repo.getShape('missing')).toEqual([])
    expect(repo.getStopsInBounds(0, 0, 1, 1)).toEqual([])
    repo.close()
  })

  it('commits inserts inside a transaction()', () => {
    const repo = createInMemoryRepository()
    repo.transaction(() => {
      repo
        .getDb()
        .prepare(
          `INSERT INTO routes (route_id, route_short_name, route_long_name, route_type)
                     VALUES ('R1', '1', 'Route One', 3)`
        )
        .run()
    })
    expect(repo.getRoute('R1')?.route_short_name).toBe('1')
    repo.close()
  })

  it('two in-memory repos are fully isolated', () => {
    const a = createInMemoryRepository()
    const b = createInMemoryRepository()
    a.transaction(() => {
      a.getDb()
        .prepare(
          `INSERT INTO routes (route_id, route_short_name, route_long_name, route_type)
                     VALUES ('R1', '1', 'Route One', 3)`
        )
        .run()
    })
    expect(a.getRouteCount()).toBe(1)
    expect(b.getRouteCount()).toBe(0)
    a.close()
    b.close()
  })
})
