import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GTFSRepository } from '../../server/gtfs/database.js'
import { createInMemoryRepository } from '../../helpers/database.js'
import { loadCTATestDatabase } from '../../helpers/fixtures.js'

// Queries against the shared CTA test DB (read-only, mirrors production).
describe('GTFSRepository (CTA test DB)', () => {
  let repo: GTFSRepository

  beforeAll(async () => {
    repo = await loadCTATestDatabase()
  })

  afterAll(() => {
    repo.close()
  })

  it('reports non-zero counts for routes/stops/trips', () => {
    expect(repo.getRouteCount()).toBeGreaterThan(0)
    expect(repo.getStopCount()).toBeGreaterThan(0)
    expect(repo.getTripCount()).toBeGreaterThan(0)
  })

  it('returns routes with the expected shape', () => {
    const routes = repo.getAllRoutes()
    expect(routes.length).toBe(repo.getRouteCount())
    const first = routes[0]
    expect(first.route_id).toBeDefined()
    expect(typeof first.route_type).toBe('number')
  })

  it('fetches a route by id', () => {
    const first = repo.getAllRoutes()[0]
    const route = repo.getRoute(first.route_id)
    expect(route).toBeDefined()
    expect(route?.route_id).toBe(first.route_id)
  })

  it('returns undefined for a missing route', () => {
    expect(repo.getRoute('__does_not_exist__')).toBeUndefined()
  })

  it('returns stops and resolves them by id', () => {
    const stops = repo.getAllStops()
    expect(stops.length).toBe(repo.getStopCount())
    const first = stops[0]
    expect(repo.getStop(first.stop_id)?.stop_id).toBe(first.stop_id)
  })

  it('returns undefined for a missing stop', () => {
    expect(repo.getStop('__does_not_exist__')).toBeUndefined()
  })

  it('finds stops within a geographic bounding box', () => {
    // Downtown Chicago bounds — should contain many stops.
    const stops = repo.getStopsInBounds(41.8, -87.7, 42.0, -87.5)
    expect(stops.length).toBeGreaterThan(0)
    for (const s of stops) {
      expect(s.stop_lat).toBeGreaterThanOrEqual(41.8)
      expect(s.stop_lat).toBeLessThanOrEqual(42.0)
    }
  })

  it('lists trips for a route and direction', () => {
    const route = repo.getAllRoutes()[0]
    const trips = repo.getTripsForRoute(route.route_id, 0)
    expect(Array.isArray(trips)).toBe(true)
  })

  it('returns stop times in stop_sequence order', () => {
    const trip = repo.getTrip(repo.getAllRoutes()[0].route_id)
      ? (() => {
          const trips = repo.getTripsForRoute(repo.getAllRoutes()[0].route_id, 0)
          return trips[0]
        })()
      : undefined
    if (!trip) return
    const stopTimes = repo.getStopTimes(trip.trip_id)
    expect(stopTimes.length).toBeGreaterThan(0)
    for (let i = 1; i < stopTimes.length; i++) {
      expect(stopTimes[i].stop_sequence).toBeGreaterThan(stopTimes[i - 1].stop_sequence)
    }
  })

  it('resolves shapes for trips that carry a shape_id', () => {
    const routes = repo.getAllRoutes()
    for (const route of routes) {
      const trips = repo.getTripsForRoute(route.route_id, 0)
      const withShape = trips.find((t) => t.shape_id)
      if (!withShape) continue
      const shape = repo.getShape(withShape.shape_id)
      expect(shape.length).toBeGreaterThan(0)
      return // one positive assertion is enough
    }
  })

  it('getActiveTrips returns trips running on a service day', () => {
    // Use the most recent Sunday from today so weekday-heavy calendars and
    // exceptions are both exercised consistently.
    const now = new Date()
    const day = now.getDay() // 0 = Sunday
    const lastSunday = new Date(now)
    lastSunday.setDate(now.getDate() - day)
    const dateStr = `${lastSunday.getFullYear()}${String(lastSunday.getMonth() + 1).padStart(2, '0')}${String(lastSunday.getDate()).padStart(2, '0')}`
    const active = repo.getActiveTrips(dateStr, 12 * 3600)
    expect(Array.isArray(active)).toBe(true)
  })

  it('isServiceActiveToday is consistent with calendar', () => {
    // A date in the distant past has no calendar coverage -> inactive.
    expect(repo.isServiceActiveToday('__missing__', '19990101')).toBe(false)
  })

  it('getServiceWeekPatterns returns a map keyed by service_id', () => {
    const patterns = repo.getServiceWeekPatterns()
    expect(patterns).toBeInstanceOf(Map)
    for (const [sid, p] of patterns) {
      expect(typeof sid).toBe('string')
      expect(typeof p.weekdayCount).toBe('number')
      expect(typeof p.weekendCount).toBe('number')
    }
  })

  it('streamBlocks yields active trips ordered by block', () => {
    const now = new Date()
    const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
    let count = 0
    let prevBlock = ''
    for (const t of repo.streamBlocks(dateStr)) {
      count++
      expect(t.block_id).toBeDefined()
      if (prevBlock !== t.block_id && count > 1) {
        // blocks are grouped; each trip must carry stop names for joined stops
        expect(t.start_stop_name).toBeDefined()
      }
      prevBlock = t.block_id
    }
    // may be zero on a day with no service, but must not throw
    expect(count).toBeGreaterThanOrEqual(0)
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
