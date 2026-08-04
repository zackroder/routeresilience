import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { SimulationEngine } from '../../../server/simulation/engine.js'
import { DetourEngine } from '../../../server/detour/engine.js'
import { DetourStore } from '../../../server/detour/store.js'
import { GTFSRepository } from '../../../server/gtfs/database.js'
import { loadMinimalFixture } from '../../helpers/fixtures.js'
import { createTempDir } from '../../helpers/database.js'

// SimulationEngine tests use manual mode (deterministic clock via advance())
// and a seeded RNG with speed noise disabled, so runs are reproducible against
// the minimal fixture's fixed service set.
describe('SimulationEngine (minimal fixture)', () => {
  let repo: GTFSRepository
  let tmp: { dir: string; cleanup: () => void }
  let store: DetourStore
  let engine: DetourEngine
  let sim: SimulationEngine
  let now: Date

  beforeAll(async () => {
    repo = await loadMinimalFixture()
    tmp = createTempDir()
    process.env.PERSISTENT_DATA_DIR = tmp.dir
    store = new DetourStore()
    engine = new DetourEngine(repo, store)
    // Wednesday 2026-07-15 noon — two shaped trips run through midday.
    now = new Date(2026, 6, 15, 12, 0, 0)
    sim = new SimulationEngine(repo, engine, store, {
      manual: true,
      seed: 42,
      speedNoise: false,
    })
    sim.spawnActiveVehicles(now)
  })

  afterAll(() => {
    delete process.env.PERSISTENT_DATA_DIR
    tmp.cleanup()
    repo.close()
  })

  beforeEach(() => {
    sim.reset()
    sim.spawnActiveVehicles(now)
  })

  afterEach(() => {
    sim.stop()
  })

  it('spawns vehicles for the known active trips', () => {
    expect(sim.getVehicleCount()).toBe(2)
    const tripIds = new Set(sim.getVehicles().map((v) => v.tripId))
    expect(tripIds).toEqual(new Set(['trip-trunk-3', 'trip-branch-1']))
    for (const v of sim.getVehicles()) {
      expect(v.status).toBe('IN_TRANSIT')
      expect(v.tripId).toBeTruthy()
      expect(v.routeId).toBeTruthy()
      expect(Number.isFinite(v.lat)).toBe(true)
      expect(Number.isFinite(v.lon)).toBe(true)
    }
  })

  it('looks up a vehicle by trip id', () => {
    const first = sim.getVehicles()[0]
    const found = sim.getVehicleForTrip(first.tripId)
    expect(found?.vehicleId).toBe(first.vehicleId)
    expect(sim.getVehicleForTrip('__missing__')).toBeUndefined()
  })

  it('advance() moves vehicles over time', () => {
    const before = sim.getVehicles()
    const startPositions = new Map(
      before.map((v) => [v.vehicleId, { lat: v.lat, lon: v.lon, dist: v.distanceTraveled }])
    )
    sim.advance(30) // 30 one-second ticks
    const after = sim.getVehicles()
    const moved = after.filter((v) => {
      const s = startPositions.get(v.vehicleId)
      return s && (v.distanceTraveled > s.dist || v.lat !== s.lat || v.lon !== s.lon)
    })
    expect(moved.length).toBeGreaterThan(0)
  })

  it('is deterministic for a given seed and clock', () => {
    const a = new SimulationEngine(repo, engine, store, {
      manual: true,
      seed: 7,
      speedNoise: false,
    })
    const b = new SimulationEngine(repo, engine, store, {
      manual: true,
      seed: 7,
      speedNoise: false,
    })
    a.spawnActiveVehicles(now)
    b.spawnActiveVehicles(now)
    a.advance(10)
    b.advance(10)
    const va = new Map(a.getVehicles().map((v) => [v.tripId, v]))
    const vb = new Map(b.getVehicles().map((v) => [v.tripId, v]))
    expect(va.size).toBe(vb.size)
    for (const [tripId, av] of va) {
      const bv = vb.get(tripId)
      if (!bv) continue
      expect(av.distanceTraveled).toBeCloseTo(bv.distanceTraveled, 6)
      expect(av.lat).toBeCloseTo(bv.lat, 9)
      expect(av.lon).toBeCloseTo(bv.lon, 9)
    }
    a.stop()
    b.stop()
  })

  it('applyHold extends dwell and isHeld reflects it', () => {
    const vehicle = sim.getVehicles()[0]
    expect(sim.applyHold(vehicle.vehicleId, 60)).toBe(true)
    expect(sim.isHeld(vehicle.vehicleId)).toBe(true)
    expect(sim.clearHold(vehicle.vehicleId)).toBe(true)
    expect(sim.isHeld(vehicle.vehicleId)).toBe(false)
  })

  it('applyHold returns false for unknown vehicles', () => {
    expect(sim.applyHold('nope', 30)).toBe(false)
    expect(sim.clearHold('nope')).toBe(false)
  })

  it('applyBreakdown freezes a vehicle and recovers', () => {
    const vehicle = sim.getVehicles()[0]
    expect(sim.applyBreakdown(vehicle.vehicleId, 5)).toBe(true)
    expect(sim.isBreakdown(vehicle.vehicleId)).toBe(true)
    const frozen = sim.getVehicleForTrip(vehicle.tripId)
    expect(frozen).toBeDefined()
    // Advance 10s past the breakdown window; should recover.
    sim.advance(10)
    expect(sim.isBreakdown(vehicle.vehicleId)).toBe(false)
  })

  it('setSpeedFactor rescales a vehicle speed profile', () => {
    const vehicle = sim.getVehicles()[0]
    const original = [...vehicle.segmentSpeeds]
    expect(sim.setSpeedFactor(vehicle.vehicleId, 2)).toBe(true)
    const updated = sim.getVehicleForTrip(vehicle.tripId)
    expect(updated?.segmentSpeeds).toBeDefined()
    expect(updated!.segmentSpeeds[0]).toBeCloseTo(original[0] * 2, 6)
  })

  it('setSpeedFactor returns false for unknown vehicles', () => {
    expect(sim.setSpeedFactor('nope', 2)).toBe(false)
  })

  it('reset clears all vehicles and metrics', () => {
    expect(sim.getVehicleCount()).toBeGreaterThan(0)
    sim.reset()
    expect(sim.getVehicleCount()).toBe(0)
    const metrics = sim.getAccuracyMetrics()
    expect(metrics.sampleCount).toBe(0)
  })

  it('records arrivals during advance', () => {
    sim.reset()
    sim.spawnActiveVehicles(now)
    sim.advance(120)
    const arrivals = sim.getArrivals()
    expect(Array.isArray(arrivals)).toBe(true)
    // Two vehicles moving for 2 minutes reach their first downstream stops.
    expect(arrivals.length).toBeGreaterThan(0)
  })
})
