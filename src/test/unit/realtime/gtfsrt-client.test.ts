import { describe, it, expect } from 'vitest'
import { GtfsRtClient } from '../../../server/realtime/ingest/gtfsrt-client.js'
import { encodeFeedMessage } from '../../../server/realtime/proto.js'

async function feedBuffer(now = new Date()): Promise<Buffer> {
  const message = {
    header: { gtfsRealtimeVersion: '2.0', timestamp: Math.floor(now.getTime() / 1000) },
    entity: [
      {
        id: '1',
        vehicle: {
          trip: { tripId: 'trip-trunk-1', routeId: 'route-trunk', directionId: 0 },
          vehicle: { id: 'v-100', label: '100' },
          position: { latitude: 41.881, longitude: -87.63, bearing: 0, speed: 5 },
          currentStopSequence: 2,
          stopId: 'stop-b',
          currentStatus: 2,
          timestamp: Math.floor(now.getTime() / 1000),
        },
      },
    ],
  }
  return await encodeFeedMessage(message)
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

describe('GtfsRtClient', () => {
  it('appends the API key as a query param', () => {
    const client = new GtfsRtClient({
      url: 'https://feed.example/VehiclePositions.pb',
      apiKey: 'k-123',
    })
    expect(client.getFeedUrl()).toBe('https://feed.example/VehiclePositions.pb?key=k-123')
  })

  it('does not append a key when none is configured', () => {
    const client = new GtfsRtClient({ url: 'https://feed.example/VehiclePositions.pb' })
    expect(client.getFeedUrl()).toBe('https://feed.example/VehiclePositions.pb')
  })

  it('decodes a fetched feed into entities', async () => {
    const client = new GtfsRtClient({
      url: 'https://feed.example/VehiclePositions.pb',
      apiKey: 'k-123',
      fetchImpl: mockFetch(feedBuffer()),
    })

    const feed = await client.poll()
    expect(feed.header.gtfsRealtimeVersion).toBe('2.0')
    expect(feed.entity).toHaveLength(1)
    expect(feed.entity[0].vehicle.trip.tripId).toBe('trip-trunk-1')
    expect(feed.entity[0].vehicle.position.latitude).toBeCloseTo(41.881, 4)
    expect(feed.entity[0].vehicle.currentStopSequence).toBe(2)
  })

  it('tracks fetch errors and stats', async () => {
    const failing = (async () => {
      const res = { ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) }
      return res as Response
    }) as typeof fetch

    const client = new GtfsRtClient({
      url: 'https://feed.example/VehiclePositions.pb',
      apiKey: 'k-123',
      fetchImpl: failing,
    })

    await expect(client.poll()).rejects.toThrow(/HTTP 503/)
    const stats = client.getStats()
    expect(stats.lastError).toMatch(/HTTP 503/)
    expect(stats.pollCount).toBe(0)
  })

  it('surfaces transport errors from the fetch implementation', async () => {
    const throwing = (async () => {
      throw new Error('connection refused')
    }) as typeof fetch

    const client = new GtfsRtClient({
      url: 'https://feed.example/VehiclePositions.pb',
      apiKey: 'k-123',
      fetchImpl: throwing,
    })

    await expect(client.poll()).rejects.toThrow('connection refused')
    expect(client.getStats().lastError).toBe('connection refused')
  })
})
