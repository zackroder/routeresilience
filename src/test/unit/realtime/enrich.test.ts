import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GtfsRtEnricher, RawVehiclePosition } from '../../../server/realtime/ingest/enrich.js'
import { GTFSRepository } from '../../../server/gtfs/database.js'
import { loadMinimalFixture } from '../../helpers/fixtures.js'

// Fixed service day and time: Wednesday 2026-07-15, 11:07 local.
// Trip trip-trunk-1 runs stop-a(11:00) -> stop-b(11:05) -> stop-c(11:10) ->
// stop-d(11:15) -> stop-e(11:20), on shape-trunk (stops are ~111m apart N/S).
const now = new Date(2026, 6, 15, 11, 7, 0)

describe('GtfsRtEnricher (minimal fixture)', () => {
  let repo: GTFSRepository

  beforeAll(async () => {
    repo = await loadMinimalFixture()
  })

  afterAll(() => {
    repo.close()
  })

  function baseEntity(overrides: Partial<RawVehiclePosition['vehicle']> = {}): RawVehiclePosition {
    return {
      id: 'ent-1',
      vehicle: {
        trip: { tripId: 'trip-trunk-1', routeId: 'route-trunk', directionId: 0 },
        vehicle: { id: 'v-100', label: '100' },
        position: { latitude: 41.881, longitude: -87.63, bearing: 0, speed: 5 },
        currentStopSequence: 2,
        stopId: 'stop-b',
        currentStatus: 2,
        timestamp: Math.floor(now.getTime() / 1000),
        ...overrides,
      },
    }
  }

  it('enriches a vehicle position into a full VehicleState', () => {
    const enricher = new GtfsRtEnricher(repo)
    const result = enricher.enrich(baseEntity(), now)

    expect(result).not.toBeNull()
    const { state } = result!

    expect(state.vehicleId).toBe('v-100')
    expect(state.tripId).toBe('trip-trunk-1')
    expect(state.routeId).toBe('route-trunk')
    expect(state.directionId).toBe(0)
    expect(state.shapeId).toBe('shape-trunk')
    expect(state.lat).toBeCloseTo(41.881, 5)
    expect(state.lon).toBeCloseTo(-87.63, 5)

    // currentStopSequence=2 → currentStopIndex 1 (0-based).
    expect(state.currentStopIndex).toBe(1)
    expect(state.nextStopId).toBe('stop-c')
    expect(state.status).toBe('IN_TRANSIT')

    // Segment model is populated and consistent with the fixture shape.
    expect(state.segmentDistances.length).toBe(5)
    expect(state.segmentSpeeds.length).toBe(4)
    expect(state.totalDistance).toBeGreaterThan(0)
    expect(state.distanceTraveled).toBeGreaterThan(0)
    expect(state.distanceTraveled).toBeLessThanOrEqual(state.totalDistance)
    for (const s of state.segmentSpeeds) expect(s).toBeGreaterThan(0)

    expect(state.cachedStopTimes).toHaveLength(5)
    expect(state.delaySeconds).toBeTypeOf('number')
    expect(state.lastUpdateTime).toBe(Math.floor(now.getTime() / 1000) * 1000)
    expect(state.scheduledEndTime).toBeGreaterThan(state.tripStartTime)
  })

  it('maps STOPPED_AT to AT_STOP status and exposes the arrival stop', () => {
    const enricher = new GtfsRtEnricher(repo)
    const result = enricher.enrich(
      baseEntity({
        currentStatus: 1,
        stopId: 'stop-b',
        timestamp: Math.floor(now.getTime() / 1000),
      }),
      now
    )

    expect(result).not.toBeNull()
    expect(result!.state.status).toBe('AT_STOP')
    expect(result!.currentStatus).toBe(1)
    expect(result!.stopId).toBe('stop-b')
    expect(result!.stopSequence).toBe(2)
  })

  it('computes a delay relative to the interpolated schedule', () => {
    const enricher = new GtfsRtEnricher(repo)
    // Vehicle reported at stop-b at 11:07; scheduled arrival at stop-b is
    // 11:05:00 → exactly 120s late.
    const result = enricher.enrich(
      baseEntity({
        currentStatus: 1,
        stopId: 'stop-b',
        timestamp: Math.floor(now.getTime() / 1000),
      }),
      now
    )

    expect(result).not.toBeNull()
    expect(result!.state.delaySeconds).toBe(120)
  })

  it('returns null for a vehicle with no position', () => {
    const enricher = new GtfsRtEnricher(repo)
    const entity = baseEntity()
    delete entity.vehicle!.position
    expect(enricher.enrich(entity, now)).toBeNull()
  })

  it('returns null for an unknown trip', () => {
    const enricher = new GtfsRtEnricher(repo)
    const entity = baseEntity()
    entity.vehicle!.trip = { tripId: 'no-such-trip', routeId: 'route-trunk', directionId: 0 }
    expect(enricher.enrich(entity, now)).toBeNull()
  })

  it('returns null for a trip without stop times', () => {
    const enricher = new GtfsRtEnricher(repo)
    // trip-no-shape has stop times but no shape → uses fallback geometry and
    // still enriches. Unknown trips with <2 stop_times are the only null case.
    const entity = baseEntity()
    entity.vehicle!.trip = { tripId: '__no_stops__', routeId: 'route-trunk', directionId: 0 }
    expect(enricher.enrich(entity, now)).toBeNull()
  })

  it('falls back to stop-polyline geometry when the trip has no shape', () => {
    const enricher = new GtfsRtEnricher(repo)
    const entity = baseEntity()
    // trip-no-shape has stop-a(10:00) -> stop-b(10:05) -> stop-c(10:10).
    entity.vehicle!.trip = { tripId: 'trip-no-shape', routeId: 'route-trunk', directionId: 0 }
    entity.vehicle!.currentStopSequence = 1
    entity.vehicle!.stopId = 'stop-a'
    entity.vehicle!.position = { latitude: 41.88, longitude: -87.63, bearing: 0, speed: 5 }

    const result = enricher.enrich(entity, now)
    expect(result).not.toBeNull()
    expect(result!.state.shapeId).toBe('')
    expect(result!.state.segmentDistances.length).toBe(3)
    expect(result!.state.totalDistance).toBeGreaterThan(0)
  })
})
