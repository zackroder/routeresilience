import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { HeadwayService } from '../../../server/headway/service.js'
import { PredictionEngine } from '../../../server/realtime/predictions.js'
import type {
  VehicleDataSource,
  ArrivalRecord,
} from '../../../server/realtime/vehicle-data-source.js'
import type { VehicleState } from '../../../server/simulation/types.js'
import { GTFSRepository } from '../../../server/gtfs/database.js'
import { haversineMeters } from '../../../server/gtfs/loader.js'
import { loadMinimalFixture } from '../../helpers/fixtures.js'

// A controllable VehicleDataSource used to inject vehicles into HeadwayService
// without running the full simulation.
class MockVehicleSource implements VehicleDataSource {
  readonly sourceName = 'mock'
  private vehicles: VehicleState[] = []
  private byTrip = new Map<string, VehicleState>()
  private arrivals: ArrivalRecord[] = []

  constructor(vehicles: VehicleState[] = []) {
    this.setVehicles(vehicles)
  }

  setVehicles(vehicles: VehicleState[]): void {
    this.vehicles = vehicles
    this.byTrip = new Map()
    for (const v of vehicles) this.byTrip.set(v.tripId, v)
  }

  addArrival(rec: ArrivalRecord): void {
    this.arrivals.push(rec)
  }

  getVehicles(): VehicleState[] {
    return this.vehicles
  }

  getVehicleForTrip(tripId: string): VehicleState | undefined {
    return this.byTrip.get(tripId)
  }

  getVehicleCount(): number {
    return this.vehicles.length
  }

  getArrivals(): ArrivalRecord[] {
    return this.arrivals
  }
}

// Fixed service day used everywhere so results do not depend on the run date.
const now = new Date(2026, 6, 15, 12, 0, 0)

// Build a vehicle for a known fixture trip with segment data derived from the
// actual schedule, so PredictionEngine's SegmentBasedStrategy can generate
// predictions.
function buildVehicleForTrip(
  repo: GTFSRepository,
  trip: { trip_id: string; route_id: string; direction_id: number },
  vehicleId: string,
  opts: { currentStopIndex?: number; delaySeconds?: number; lastUpdateTime?: number } = {}
): VehicleState {
  const stopTimes = repo.getStopTimes(trip.trip_id)
  const segmentDistances: number[] = []
  let cum = 0
  for (let i = 0; i < stopTimes.length; i++) {
    if (i === 0) {
      segmentDistances.push(0)
      continue
    }
    const a = repo.getStop(stopTimes[i - 1].stop_id)
    const b = repo.getStop(stopTimes[i].stop_id)
    const dist = a && b ? haversineMeters(a.stop_lat, a.stop_lon, b.stop_lat, b.stop_lon) : 0
    cum += dist
    segmentDistances.push(cum)
  }
  const segmentSpeeds: number[] = []
  for (let i = 0; i < stopTimes.length - 1; i++) {
    const dist = segmentDistances[i + 1] - segmentDistances[i]
    const time = stopTimes[i + 1].arrival_time - stopTimes[i].departure_time
    segmentSpeeds.push(time > 0 && dist > 0 ? dist / time : 8.9)
  }
  const currentStopIndex = opts.currentStopIndex ?? 0
  const nextStop = stopTimes[Math.min(currentStopIndex + 1, stopTimes.length - 1)]
  return {
    vehicleId,
    tripId: trip.trip_id,
    routeId: trip.route_id,
    directionId: trip.direction_id,
    shapeId: '',
    lat: 41.882,
    lon: -87.63,
    bearing: 0,
    speed: segmentSpeeds[0] ?? 8.9,
    shapeIndex: 0,
    distanceTraveled:
      segmentDistances[Math.min(currentStopIndex, segmentDistances.length - 1)] ?? 0,
    totalDistance: segmentDistances[segmentDistances.length - 1] ?? 0,
    currentStopIndex,
    nextStopId: nextStop?.stop_id ?? '',
    cachedStopTimes: stopTimes.map((st) => ({
      stop_id: st.stop_id,
      arrival_time: st.arrival_time,
    })),
    status: 'IN_TRANSIT',
    tripStartTime: stopTimes[0]?.arrival_time ?? 0,
    lastUpdateTime: opts.lastUpdateTime ?? now.getTime(),
    dwellEndTime: 0,
    scheduledEndTime: stopTimes[stopTimes.length - 1]?.arrival_time ?? 0,
    delaySeconds: opts.delaySeconds ?? 0,
    segmentSpeeds,
    segmentDistances,
    congestionMultiplier: 1,
  }
}

describe('HeadwayService (minimal fixture)', () => {
  let repo: GTFSRepository
  let routeId: string
  let trips: { trip_id: string; route_id: string; direction_id: number }[]

  beforeAll(async () => {
    repo = await loadMinimalFixture()
    // The trunk route has several trips with the same 5-stop pattern, which
    // gives the widest-path topology a non-trivial trunk.
    const candidates = repo
      .getAllRoutes()
      .filter((r) => repo.getTripsForRoute(r.route_id, 0).length >= 2)
    const chosen = candidates[0] ?? repo.getAllRoutes()[0]
    routeId = chosen.route_id
    trips = repo.getTripsForRoute(routeId, 0).slice(0, 3)
    expect(trips.length).toBeGreaterThanOrEqual(2)
  })

  afterAll(() => {
    repo.close()
  })

  function makeService(vehicles: VehicleState[]): {
    service: HeadwayService
    source: MockVehicleSource
  } {
    const source = new MockVehicleSource(vehicles)
    const predictions = new PredictionEngine(repo, source)
    const service = new HeadwayService(repo, source, predictions)
    return { service, source }
  }

  it('throws for an unknown route', () => {
    const { service } = makeService([])
    expect(() => service.getHeadways('__no_such_route__', 0, now)).toThrow('Route not found')
  })

  it('returns a well-formed empty response when no vehicles are tracked', () => {
    const { service } = makeService([])
    const res = service.getHeadways(routeId, 0, now)
    expect(res.route.routeId).toBe(routeId)
    expect(res.vehicles).toEqual([])
    expect(res.controlPoints.length).toBeGreaterThan(0)
    expect(res.warnings.some((w) => w.includes('No active vehicles'))).toBe(true)
    expect(typeof res.targetHeadwaySeconds).toBe('number')
    expect(Array.isArray(res.topology.branches)).toBe(true)
  })

  it('reports vehicles with predictions when a vehicle is injected', () => {
    const vehicle = buildVehicleForTrip(repo, trips[0], 'v1', { currentStopIndex: 1 })
    const { service } = makeService([vehicle])
    const res = service.getHeadways(routeId, 0, now)
    expect(res.vehicles).toHaveLength(1)
    const v = res.vehicles[0]
    expect(v.vehicleId).toBe('v1')
    expect(v.points.length).toBeGreaterThan(0)
    expect(typeof v.axisPosition).toBe('number')
  })

  it('pairs two vehicles into leader/follower with headway values', () => {
    const a = buildVehicleForTrip(repo, trips[0], 'v-ahead', {
      currentStopIndex: 2,
      delaySeconds: 0,
    })
    const b = buildVehicleForTrip(repo, trips[1], 'v-behind', {
      currentStopIndex: 0,
      delaySeconds: 30,
    })
    const { service } = makeService([a, b])
    const res = service.getHeadways(routeId, 0, now)
    const ids = res.vehicles.map((v) => v.vehicleId)
    expect(ids).toContain('v-ahead')
    expect(ids).toContain('v-behind')
    const ahead = res.vehicles.find((v) => v.vehicleId === 'v-ahead')
    const behind = res.vehicles.find((v) => v.vehicleId === 'v-behind')
    expect(ahead?.followerVehicleId ?? behind?.leaderVehicleId).toBeTruthy()
  })

  it('classifies a bunched vehicle when headway is tiny', () => {
    // Two vehicles on the SAME trip share identical predicted arrivals, so
    // headway between them is ~0 → BUNCHED.
    const a = buildVehicleForTrip(repo, trips[0], 'v1')
    const b = buildVehicleForTrip(repo, trips[0], 'v2')
    const { service } = makeService([a, b])
    const res = service.getHeadways(routeId, 0, now)
    expect(res.vehicles.length).toBe(2)
    const bunched = res.vehicles.filter((v) => v.headwayStatus === 'BUNCHED')
    expect(bunched.length).toBeGreaterThan(0)
  })

  it('getRecommendations proposes a HOLD for a bunched vehicle', () => {
    const a = buildVehicleForTrip(repo, trips[0], 'v1')
    const b = buildVehicleForTrip(repo, trips[0], 'v2')
    const { service } = makeService([a, b])
    const recs = service.getRecommendations(routeId, 0, now)
    expect(recs.length).toBeGreaterThan(0)
    for (const r of recs) {
      expect(r.action).toBe('HOLD')
      expect(r.holdSeconds).toBeGreaterThan(0)
      expect(r.controlPointStopId).toBeTruthy()
      expect(r.vehicleId).toBeTruthy()
    }
  })

  it('getRecommendations is empty when vehicles are well spaced', () => {
    const a = buildVehicleForTrip(repo, trips[0], 'v-ahead', {
      currentStopIndex: 3,
      delaySeconds: 0,
    })
    const b = buildVehicleForTrip(repo, trips[1], 'v-behind', {
      currentStopIndex: 0,
      delaySeconds: 0,
    })
    const { service } = makeService([a, b])
    const recs = service.getRecommendations(routeId, 0, now)
    expect(recs.length).toBe(0)
  })
})
