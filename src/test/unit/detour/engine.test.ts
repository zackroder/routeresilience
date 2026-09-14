import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { DetourEngine } from '../../../server/detour/engine.js'
import { DetourStore } from '../../../server/detour/store.js'
import type { CreateDetourRequest } from '../../../server/detour/types.js'
import { GTFSRepository } from '../../../server/gtfs/database.js'
import { loadMinimalFixture } from '../../helpers/fixtures.js'
import { createTempDir } from '../../helpers/database.js'

// DetourEngine tests run against the deterministic minimal fixture and an
// isolated DetourStore (temp PERSISTENT_DATA_DIR) so nothing leaks to dev data.
describe('DetourEngine (minimal fixture)', () => {
  let repo: GTFSRepository
  let tmp: { dir: string; cleanup: () => void }
  let store: DetourStore
  let engine: DetourEngine

  const routeId = 'route-trunk'
  const directionId = 0
  // Corridor stop-a -> stop-e on the trunk; stop-b/c/d sit between them.
  const startStopId = 'stop-a'
  const endStopId = 'stop-e'
  const activeDate = '20260715' // Wednesday, regular service.
  const now = new Date(2026, 6, 15, 12, 0, 0)

  beforeAll(async () => {
    repo = await loadMinimalFixture()
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
    return {
      routeId,
      directionId,
      startStopId,
      endStopId,
      replacementStops: [],
      detourShape: [
        [41.88, -87.63],
        [41.882, -87.63],
        [41.884, -87.63],
      ],
      startTime: new Date(now.getTime() - 3600_000).toISOString(),
      endTime: new Date(now.getTime() + 3600_000).toISOString(),
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

  it('computes a stitched path (diverge -> detour -> rejoin)', () => {
    const detour = engine.createDetour(makeRequest())
    expect(detour.path).toBeDefined()
    expect(detour.path!.length).toBeGreaterThanOrEqual(3)
    // Starts at the diverge stop and ends at the rejoin stop.
    expect(detour.path![0][0]).toBeCloseTo(41.88)
    expect(detour.path![detour.path!.length - 1][0]).toBeCloseTo(41.884)
  })

  it('identifies affected trips on the corridor', () => {
    const detour = engine.createDetour(makeRequest())
    const affected = engine.getAffectedTripIds(detour, activeDate).sort()
    expect(affected).toEqual(['trip-trunk-1', 'trip-trunk-2', 'trip-trunk-3'])
  })

  it('returns no affected trips on a removed service day', () => {
    const detour = engine.createDetour(makeRequest())
    expect(engine.getAffectedTripIds(detour, '20260714')).toEqual([])
  })

  it('computeModifiedTrip skips the corridor stops and preserves order', () => {
    const detour = engine.createDetour(
      makeRequest({
        replacementStops: [
          {
            stopId: 'stop-x',
            stopName: 'Detour X',
            lat: 41.882,
            lon: -87.631,
            travelTimeFromPrevious: 600,
          },
        ],
      })
    )
    const modified = engine.computeModifiedTrip('trip-trunk-1', detour)
    expect(modified).not.toBeNull()
    expect(modified!.tripId).toBe('trip-trunk-1')
    expect(modified!.detourId).toBe(detour.id)
    expect(modified!.skippedStops.map((s) => s.stopId)).toEqual(['stop-b', 'stop-c', 'stop-d'])
    const stopIds = modified!.modifiedStopTimes.map((s) => s.stopId)
    expect(stopIds).toEqual(['stop-a', 'stop-x', 'stop-e'])
    const replacement = modified!.modifiedStopTimes.find((s) => s.isReplacement)
    expect(replacement?.stopId).toBe('stop-x')
    // Times remain ordered across the detour.
    const arrivals = modified!.modifiedStopTimes.map((s) => s.arrivalTime)
    for (let i = 1; i < arrivals.length; i++) {
      expect(arrivals[i]).toBeGreaterThan(arrivals[i - 1])
    }
  })

  it('computeModifiedTrip returns null for an unknown trip', () => {
    const detour = engine.createDetour(makeRequest())
    expect(engine.computeModifiedTrip('__missing__', detour)).toBeNull()
  })

  it('computeModifiedTrip marks zero skipped stops for an adjacent corridor', () => {
    // Corridor stop-a -> stop-b: no stops lie between, so nothing is skipped
    // and every original stop is preserved (rejoin shifts later times).
    const detour = engine.createDetour(makeRequest({ startStopId: 'stop-a', endStopId: 'stop-b' }))
    const modified = engine.computeModifiedTrip('trip-trunk-1', detour)
    expect(modified).not.toBeNull()
    expect(modified!.skippedStops).toEqual([])
    expect(modified!.modifiedStopTimes.map((s) => s.stopId)).toEqual([
      'stop-a',
      'stop-b',
      'stop-c',
      'stop-d',
      'stop-e',
    ])
  })

  it('getAllModifiedTrips returns a map keyed by trip id', () => {
    engine.createDetour(makeRequest())
    const map = engine.getAllModifiedTrips(now)
    expect(map).toBeInstanceOf(Map)
    expect(map.size).toBeGreaterThan(0)
    for (const [tripId, modified] of map) {
      expect(modified.tripId).toBe(tripId)
    }
  })

  it('getAllModifiedTrips is empty when no active detours', () => {
    const map = engine.getAllModifiedTrips(now)
    expect(map.size).toBe(0)
  })
})
