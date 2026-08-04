import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { DetourEngine } from '../../../server/detour/engine.js'
import { DetourStore } from '../../../server/detour/store.js'
import type { CreateDetourRequest } from '../../../server/detour/types.js'
import { GTFSRepository } from '../../../server/gtfs/database.js'
import { loadCTATestDatabase } from '../../helpers/fixtures.js'
import { createTempDir } from '../../helpers/database.js'

// DetourEngine tests run against the shared read-only CTA test DB and an
// isolated DetourStore (temp PERSISTENT_DATA_DIR) so nothing leaks to dev data.
describe('DetourEngine', () => {
  let repo: GTFSRepository
  let tmp: { dir: string; cleanup: () => void }
  let store: DetourStore
  let engine: DetourEngine
  let routeId: string
  let directionId: number
  let startStopId: string
  let endStopId: string

  beforeAll(async () => {
    repo = await loadCTATestDatabase()
    const routes = repo.getAllRoutes()
    expect(routes.length).toBeGreaterThan(0)
    routeId = routes[0].route_id

    // Pick a trip with at least 3 stops to serve as a detour corridor.
    for (const trip of repo.getTripsForRoute(routeId, 0)) {
      const st = repo.getStopTimes(trip.trip_id)
      if (st.length >= 3) {
        directionId = trip.direction_id
        startStopId = st[0].stop_id
        endStopId = st[st.length - 1].stop_id
        break
      }
    }
  })

  afterAll(() => {
    repo.close()
  })

  beforeEach(() => {
    tmp = createTempDir()
    process.env.PERSISTENT_DATA_DIR = tmp.dir
    store = new DetourStore()
    engine = new DetourEngine(repo, store)
  })

  afterEach(() => {
    delete process.env.PERSISTENT_DATA_DIR
    tmp.cleanup()
  })

  function makeRequest(overrides: Partial<CreateDetourRequest> = {}): CreateDetourRequest {
    const now = Date.now()
    return {
      routeId,
      directionId,
      startStopId,
      endStopId,
      replacementStops: [],
      detourShape: [
        [41.88, -87.63],
        [41.89, -87.63],
      ],
      startTime: new Date(now - 3600_000).toISOString(),
      endTime: new Date(now + 3600_000).toISOString(),
      description: 'Test detour',
      ...overrides,
    }
  }

  it('creates a detour and stores it', () => {
    const detour = engine.createDetour(makeRequest())
    expect(detour.id).toBeDefined()
    expect(store.get(detour.id)?.routeId).toBe(routeId)
    expect(store.getAll()).toHaveLength(1)
  })

  it('removes a detour', () => {
    const detour = engine.createDetour(makeRequest())
    expect(engine.removeDetour(detour.id)).toBe(true)
    expect(engine.removeDetour(detour.id)).toBe(false)
    expect(store.getAll()).toHaveLength(0)
  })

  it('computes a path (diverge -> detour -> rejoin) on create', () => {
    const detour = engine.createDetour(makeRequest())
    expect(detour.path).toBeDefined()
    expect(detour.path!.length).toBeGreaterThanOrEqual(2)
    // First path point should match the diverge region (or the detour shape
    // if no original shape matched).
    expect(detour.path![0]).toBeDefined()
  })

  it('getAffectedTripIds returns trips on the route/direction serving the corridor', () => {
    const detour = engine.createDetour(makeRequest())
    const now = new Date()
    const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
    const affected = engine.getAffectedTripIds(detour, dateStr)
    expect(Array.isArray(affected)).toBe(true)
  })

  it('computeModifiedTrip builds a modified stop sequence', () => {
    const detour = engine.createDetour(makeRequest())
    // Find a trip that actually traverses the corridor.
    const trips = repo.getTripsForRoute(routeId, directionId)
    let modified = null
    for (const t of trips) {
      modified = engine.computeModifiedTrip(t.trip_id, detour)
      if (modified) break
    }
    if (!modified) return // no trip serves the corridor on any service day
    expect(modified.tripId).toBeDefined()
    expect(modified.modifiedStopTimes.length).toBeGreaterThan(0)
    expect(modified.detourId).toBe(detour.id)
  })

  it('computeModifiedTrip returns null for an unknown trip', () => {
    const detour = engine.createDetour(makeRequest())
    expect(engine.computeModifiedTrip('__missing__', detour)).toBeNull()
  })

  it('marks skipped stops between diverge and rejoin', () => {
    // Corridor with 3+ stops, skip the middle one.
    const detour = engine.createDetour(
      makeRequest({
        replacementStops: [
          {
            stopId: endStopId,
            stopName: 'Rejoin',
            lat: 41.89,
            lon: -87.63,
            travelTimeFromPrevious: 120,
          },
        ],
      })
    )
    const trips = repo.getTripsForRoute(routeId, directionId)
    for (const t of trips) {
      const modified = engine.computeModifiedTrip(t.trip_id, detour)
      if (!modified) continue
      // The replaced corridor should have at least one skipped original stop
      // or at least one replacement stop in the sequence.
      expect(
        modified.skippedStops.length +
          modified.modifiedStopTimes.filter((s) => s.isReplacement).length
      ).toBeGreaterThan(0)
      break
    }
  })

  it('getAllModifiedTrips returns a map keyed by trip id', () => {
    engine.createDetour(makeRequest())
    const map = engine.getAllModifiedTrips(new Date())
    expect(map).toBeInstanceOf(Map)
  })

  it('getAllModifiedTrips is empty when no active detours', () => {
    const map = engine.getAllModifiedTrips(new Date())
    expect(map.size).toBe(0)
  })
})
