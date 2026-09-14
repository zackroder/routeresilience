import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import { createApiRouter } from '../../../server/api/routes.js'
import { GTFSRepository } from '../../../server/gtfs/database.js'
import { DetourEngine } from '../../../server/detour/engine.js'
import { DetourStore } from '../../../server/detour/store.js'
import { CancellationStore } from '../../../server/detour/cancellations.js'
import { InstructionStore } from '../../../server/instructions/store.js'
import type { OperatorInstruction } from '../../../server/instructions/types.js'
import { loadMinimalFixture } from '../../helpers/fixtures.js'
import { createTempDir } from '../../helpers/database.js'

// Integration tests exercise the Express router against the deterministic
// minimal fixture with real stores (isolated temp dirs). Heavy/dynamic services
// (simulation, feed generator, headway) are stubbed with lightweight doubles
// so the tests stay fast and deterministic.
describe('API routes', () => {
  let repo: GTFSRepository
  let tmp: { dir: string; cleanup: () => void }
  let detourStore: DetourStore
  let cancellationStore: CancellationStore
  let instructionStore: InstructionStore
  let detourEngine: DetourEngine
  let app: express.Express

  const routeId = 'route-trunk'

  beforeAll(async () => {
    repo = await loadMinimalFixture()
    tmp = createTempDir()
    process.env.PERSISTENT_DATA_DIR = tmp.dir
    detourStore = new DetourStore()
    cancellationStore = new CancellationStore()
    instructionStore = new InstructionStore()
    detourEngine = new DetourEngine(repo, detourStore)
  })

  afterAll(() => {
    delete process.env.PERSISTENT_DATA_DIR
    tmp.cleanup()
    repo.close()
  })

  // A minimal stub covering the bits the tested endpoints actually touch.
  const simulationStub = {
    sourceName: 'stub',
    getVehicles: () => [],
    getVehicleForTrip: () => undefined,
    getVehicleCount: () => 0,
    getArrivals: () => [],
    getAccuracyMetrics: () => ({ rmse: 0, mae: 0, sampleCount: 0 }),
    applyHold: () => true,
    clearHold: () => true,
    setCongestionPreset: () => {},
    clearCongestionPresets: () => {},
  } as any

  const feedStub = {
    generateFeed: async () => Buffer.from(''),
    generateFeedJson: async () => ({ entity: [] }),
    getHealthMetrics: () => ({}),
  } as any

  const headwayStub = {
    getHeadways: () => ({
      route: { routeId, routeShortName: 'T', routeLongName: '', routeColor: '' },
      directionId: 0,
      timestamp: Date.now(),
      date: '20260715',
      targetHeadwaySeconds: 600,
      vehicles: [],
      controlPoints: [],
      topology: { trunk: [], branches: [] },
      warnings: [],
    }),
    getRecommendations: () => [],
  } as any

  beforeEach(() => {
    app = express()
    app.use(express.json())
    const router = createApiRouter(
      repo,
      detourEngine,
      detourStore,
      simulationStub,
      feedStub,
      cancellationStore,
      headwayStub,
      instructionStore
    )
    app.use('/api', router)
  })

  afterEach(() => {
    // Clean the in-memory-ish stores so tests don't bleed into each other.
    for (const d of detourStore.getAll()) detourStore.remove(d.id)
    for (const k of cancellationStore.getAllCancelled())
      cancellationStore.restoreTrip(k.split('_')[0], k.split('_')[1])
  })

  // ─── GTFS data endpoints ───

  it('GET /api/routes returns the route list', async () => {
    const res = await request(app).get('/api/routes')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body.length).toBeGreaterThan(0)
    expect(res.body[0].route_id).toBeDefined()
  })

  it('GET /api/routes/:id/trips returns trips for a route', async () => {
    const res = await request(app).get(`/api/routes/${routeId}/trips?direction=0&limit=5`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body.length).toBeLessThanOrEqual(5)
  })

  it('GET /api/routes/:id/stops returns stops for a route', async () => {
    const res = await request(app).get(`/api/routes/${routeId}/stops?direction=0`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    if (res.body.length > 0) {
      expect(res.body[0].stop_id).toBeDefined()
      expect(res.body[0].stop_lat).toBeDefined()
    }
  })

  it('GET /api/stops/:id returns a stop', async () => {
    const stop = repo.getAllStops()[0]
    const res = await request(app).get(`/api/stops/${stop.stop_id}`)
    expect(res.status).toBe(200)
    expect(res.body.stop_id).toBe(stop.stop_id)
  })

  it('GET /api/stops/:id returns 404 for unknown stop', async () => {
    const res = await request(app).get('/api/stops/nope')
    expect(res.status).toBe(404)
  })

  it('GET /api/stops/nearby requires lat/lng', async () => {
    const res = await request(app).get('/api/stops/nearby')
    expect(res.status).toBe(400)
  })

  it('GET /api/stops/bounds requires bounds', async () => {
    const res = await request(app).get('/api/stops/bounds')
    expect(res.status).toBe(400)
  })

  // ─── Cancellation endpoints ───

  it('POST /api/trips/:id/cancel requires dates', async () => {
    const res = await request(app).post(`/api/trips/AB1/cancel`).send({})
    expect(res.status).toBe(400)
  })

  it('POST /api/trips/:id/cancel cancels a trip', async () => {
    const res = await request(app)
      .post('/api/trips/AB1/cancel')
      .send({ start_date: '20990101', end_date: '20990102' })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('CANCELED')
    expect(cancellationStore.isCancelled('AB1', '20990101')).toBe(true)
  })

  it('POST /api/trips/:id/restore restores a trip', async () => {
    cancellationStore.cancelTrip('AB1', '20990101', '20990101')
    const res = await request(app).post('/api/trips/AB1/restore').send({ date: '20990101' })
    expect(res.status).toBe(200)
    expect(cancellationStore.isCancelled('AB1', '20990101')).toBe(false)
  })

  it('GET /api/cancellations lists cancelled trips with detail', async () => {
    const firstTrip = repo.getTripsForRoute(routeId, 0)[0]
    const tripId = firstTrip.trip_id
    cancellationStore.cancelTrip(tripId, '20990101', '20990101')
    const res = await request(app).get('/api/cancellations')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    const entry = res.body.find((c: any) => c.trip_id === tripId)
    expect(entry).toBeDefined()
    expect(entry.first_stop_name).toBeDefined()
    expect(entry.route_id).toBe(routeId)
  })

  // ─── Detour endpoints ───

  it('POST /api/detours requires required fields', async () => {
    const res = await request(app).post('/api/detours').send({ routeId })
    expect(res.status).toBe(400)
  })

  it('POST /api/detours creates a detour', async () => {
    const now = Date.now()
    const res = await request(app)
      .post('/api/detours')
      .send({
        routeId,
        directionId: 0,
        startStopId: 'stop-a',
        endStopId: 'stop-e',
        replacementStops: [],
        detourShape: [
          [41.88, -87.63],
          [41.89, -87.63],
        ],
        startTime: new Date(now - 3600_000).toISOString(),
        endTime: new Date(now + 3600_000).toISOString(),
        description: 'API test detour',
      })
    expect(res.status).toBe(201)
    expect(res.body.id).toBeDefined()
    expect(detourStore.get(res.body.id)).toBeDefined()
  })

  it('GET /api/detours lists detours with stop info', async () => {
    const res = await request(app).get('/api/detours')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
  })

  it('GET /api/detours/:id returns a specific detour', async () => {
    const d = detourEngine.createDetour({
      routeId,
      directionId: 0,
      startStopId: null,
      endStopId: null,
      replacementStops: [],
      detourShape: [[41.88, -87.63]],
      startTime: new Date(Date.now() - 3600_000).toISOString(),
      endTime: new Date(Date.now() + 3600_000).toISOString(),
      description: 'test',
    })
    const res = await request(app).get(`/api/detours/${d.id}`)
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(d.id)
  })

  it('GET /api/detours/:id returns 404 for unknown', async () => {
    const res = await request(app).get('/api/detours/nope')
    expect(res.status).toBe(404)
  })

  it('DELETE /api/detours/:id removes a detour', async () => {
    const d = detourEngine.createDetour({
      routeId,
      directionId: 0,
      startStopId: null,
      endStopId: null,
      replacementStops: [],
      detourShape: [[41.88, -87.63]],
      startTime: new Date(Date.now() - 3600_000).toISOString(),
      endTime: new Date(Date.now() + 3600_000).toISOString(),
      description: 'test',
    })
    const res = await request(app).delete(`/api/detours/${d.id}`)
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    const again = await request(app).delete(`/api/detours/${d.id}`)
    expect(again.status).toBe(404)
  })

  // ─── Status / health ───

  it('GET /api/status returns counts', async () => {
    const res = await request(app).get('/api/status')
    expect(res.status).toBe(200)
    expect(res.body.routes).toBeGreaterThan(0)
    expect(res.body.trips).toBeGreaterThan(0)
    expect(res.body.stops).toBeGreaterThan(0)
  })

  it('GET /api/blocks streams blocks with trip details', async () => {
    const res = await request(app).get('/api/blocks?date=20260715')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    // A weekday should have blocks with trips.
    if (res.body.length > 0) {
      const first = res.body[0]
      expect(first.block_id).toBeDefined()
      expect(Array.isArray(first.trips)).toBe(true)
    }
  })

  // ─── Headway endpoints ───

  it('GET /api/headways requires route_id', async () => {
    const res = await request(app).get('/api/headways')
    expect(res.status).toBe(400)
  })

  it('GET /api/headways returns data for a route', async () => {
    const res = await request(app).get(`/api/headways?route_id=${routeId}&direction=0`)
    expect(res.status).toBe(200)
    expect(res.body.route.routeId).toBe(routeId)
  })

  it('GET /api/headways/recommendations returns a payload', async () => {
    const res = await request(app).get(`/api/headways/recommendations?route_id=${routeId}`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.recommendations)).toBe(true)
  })

  // ─── Instructions endpoints ───

  it('POST /api/instructions validates the body', async () => {
    const res = await request(app).post('/api/instructions').send({})
    expect(res.status).toBe(400)
  })

  it('POST /api/instructions creates an instruction', async () => {
    const res = await request(app).post('/api/instructions').send({
      vehicleId: 'v1',
      tripId: 't1',
      routeId,
      action: 'HOLD',
      controlPointStopId: 'S1',
      controlPointStopName: 'Stop 1',
      holdSeconds: 45,
    })
    expect(res.status).toBe(201)
    expect(res.body.status).toBe('SENT')
  })

  it('POST /api/instructions/:id/acknowledge applies the hold', async () => {
    const inst: OperatorInstruction = instructionStore.create({
      vehicleId: 'v1',
      tripId: 't1',
      routeId,
      action: 'HOLD',
      controlPointStopId: 'S1',
      controlPointStopName: 'Stop 1',
      holdSeconds: 30,
      message: 'hold',
      source: 'dispatcher',
    })
    const res = await request(app).post(`/api/instructions/${inst.id}/acknowledge`)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ACKNOWLEDGED')
  })

  it('POST /api/instructions/:id/complete completes an instruction', async () => {
    const inst: OperatorInstruction = instructionStore.create({
      vehicleId: 'v1',
      tripId: 't1',
      routeId,
      action: 'HOLD',
      controlPointStopId: 'S1',
      controlPointStopName: 'Stop 1',
      holdSeconds: 30,
      message: 'hold',
      source: 'dispatcher',
    })
    const res = await request(app).post(`/api/instructions/${inst.id}/complete`)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('COMPLETED')
  })
})
