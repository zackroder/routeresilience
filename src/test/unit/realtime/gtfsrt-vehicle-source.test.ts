import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GtfsRtVehicleSource } from '../../../server/realtime/ingest/gtfsrt-vehicle-source.js'
import { GtfsRtClient } from '../../../server/realtime/ingest/gtfsrt-client.js'
import { HeadwayService } from '../../../server/headway/service.js'
import { PredictionEngine } from '../../../server/realtime/predictions.js'
import { GTFSRepository } from '../../../server/gtfs/database.js'
import { loadMinimalFixture } from '../../helpers/fixtures.js'
import { encodeFeedMessage } from '../../../server/realtime/proto.js'
import type { RawVehiclePosition } from '../../../server/realtime/ingest/enrich.js'

// Two vehicles on the trunk route, injected through a mocked GTFS-RT feed.
// Fixed service day: Wednesday 2026-07-15, 11:07 local (trip-trunk-1 active).
const now = new Date(2026, 6, 15, 11, 7, 0)
const ts = Math.floor(now.getTime() / 1000)

function vehicleEntity(
  id: string,
  tripId: string,
  lat: number,
  stopSequence: number,
  stopId: string,
  status = 2
): RawVehiclePosition {
  return {
    id,
    vehicle: {
      trip: { tripId, routeId: 'route-trunk', directionId: 0 },
      vehicle: { id, label: id },
      position: { latitude: lat, longitude: -87.63, bearing: 0, speed: 5 },
      currentStopSequence: stopSequence,
      stopId,
      currentStatus: status,
      timestamp: ts,
    },
  }
}

function feedBuffer(entities: RawVehiclePosition[]): Promise<Buffer> {
  return encodeFeedMessage({
    header: { gtfsRealtimeVersion: '2.0', timestamp: ts },
    entity: entities,
  })
}

function mockFetch(buffer: Promise<Buffer>): typeof fetch {
  return (async () => {
    const buf = await buffer
    const res = {
      ok: true,
      status: 200,
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    }
    return res as Response
  }) as typeof fetch
}

describe('GtfsRtVehicleSource (minimal fixture)', () => {
  let repo: GTFSRepository
  let source: GtfsRtVehicleSource

  beforeAll(async () => {
    repo = await loadMinimalFixture()
  })

  afterAll(async () => {
    source?.stop()
    repo.close()
  })

  it('ingests feed vehicles and exposes them as VehicleState', async () => {
    const client = new GtfsRtClient({
      url: 'https://feed.example/VehiclePositions.pb',
      apiKey: 'k-123',
      fetchImpl: mockFetch(
        feedBuffer([
          vehicleEntity('v1', 'trip-trunk-1', 41.881, 2, 'stop-b'),
          vehicleEntity('v2', 'trip-trunk-1', 41.883, 4, 'stop-d'),
        ])
      ),
    })
    source = new GtfsRtVehicleSource(repo, client, 1000)

    await source.pollOnce(now)

    expect(source.sourceName).toBe('gtfs-rt')
    expect(source.getVehicleCount()).toBe(2)

    const v = source.getVehicleForTrip('trip-trunk-1')
    expect(v).toBeDefined()
    expect(v!.routeId).toBe('route-trunk')
    expect(v!.status).toBe('IN_TRANSIT')
    expect(v!.segmentDistances.length).toBe(5)
    expect(v!.segmentSpeeds.length).toBe(4)
    expect(Number.isFinite(v!.lat)).toBe(true)
    expect(v!.lastUpdateTime).toBe(ts * 1000)

    expect(source.getVehicles()).toHaveLength(2)
  })

  it('records arrivals for STOPPED_AT reports, deduped', async () => {
    // Poll once: vehicle arrives at stop-b.
    const arriving = vehicleEntity('v1', 'trip-trunk-1', 41.881, 2, 'stop-b', 1)
    const client = new GtfsRtClient({
      url: 'https://feed.example/VehiclePositions.pb',
      apiKey: 'k-123',
      fetchImpl: mockFetch(feedBuffer([arriving])),
    })
    source = new GtfsRtVehicleSource(repo, client, 1000)
    await source.pollOnce(now)

    expect(source.getArrivals()).toHaveLength(1)
    expect(source.getArrivals()[0]).toMatchObject({
      vehicleId: 'v1',
      tripId: 'trip-trunk-1',
      stopId: 'stop-b',
      timestamp: ts * 1000,
    })

    // Poll again with the same state — no duplicate arrival.
    await source.pollOnce(now)
    expect(source.getArrivals()).toHaveLength(1)
  })

  it('drives the HeadwayService from real-feed vehicles', async () => {
    const client = new GtfsRtClient({
      url: 'https://feed.example/VehiclePositions.pb',
      apiKey: 'k-123',
      fetchImpl: mockFetch(
        feedBuffer([
          vehicleEntity('v-ahead', 'trip-trunk-1', 41.883, 4, 'stop-d'),
          vehicleEntity('v-behind', 'trip-trunk-1', 41.881, 2, 'stop-b'),
        ])
      ),
    })
    source = new GtfsRtVehicleSource(repo, client, 1000)
    await source.pollOnce(now)

    const predictions = new PredictionEngine(repo, source)
    const headway = new HeadwayService(repo, source, predictions)
    const res = headway.getHeadways('route-trunk', 0, now)

    expect(res.vehicles).toHaveLength(2)
    const ids = res.vehicles.map((v) => v.vehicleId).sort()
    expect(ids).toEqual(['v-ahead', 'v-behind'])

    for (const v of res.vehicles) {
      expect(v.points.length).toBeGreaterThan(0)
      expect(typeof v.axisPosition).toBe('number')
    }

    // The two vehicles are paired as leader/follower.
    const paired = res.vehicles.some((v) => v.leaderVehicleId || v.followerVehicleId)
    expect(paired).toBe(true)
  })
})
