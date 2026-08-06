import { decodeFeedMessage } from '../proto.js'

export interface GtfsRtClientOptions {
  /** Base GTFS-RT endpoint URL (no query params). */
  url: string
  /** API key appended as `?key=` (never logged). */
  apiKey?: string
  /** Request timeout in ms. Defaults to 10000. */
  timeoutMs?: number
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch
}

/**
 * Minimal GTFS-RT VehiclePositions polling client.
 *
 * Fetches the protobuf feed, decodes it with the shared proto type, and returns
 * the raw `FeedMessage`. Poll cadence/lifecycle is owned by GtfsRtVehicleSource.
 */
export class GtfsRtClient {
  readonly sourceName = 'gtfs-rt'
  private lastError: string | null = null
  private lastPollAt = 0
  private pollCount = 0

  constructor(private options: GtfsRtClientOptions) {}

  /** The full feed URL with the API key query param appended. */
  getFeedUrl(): string {
    if (!this.options.apiKey) return this.options.url
    const sep = this.options.url.includes('?') ? '&' : '?'
    return `${this.options.url}${sep}key=${encodeURIComponent(this.options.apiKey)}`
  }

  async poll(): Promise<any> {
    const fetchImpl = this.options.fetchImpl ?? fetch
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000)
    try {
      const res = await fetchImpl(this.getFeedUrl(), { signal: controller.signal })
      if (!res.ok) {
        throw new Error(`GTFS-RT feed returned HTTP ${res.status}`)
      }
      const buffer = Buffer.from(await res.arrayBuffer())
      const feed = await decodeFeedMessage(buffer)
      this.lastError = null
      this.lastPollAt = Date.now()
      this.pollCount++
      return feed
    } catch (err) {
      this.lastError = (err as Error).message
      throw err
    } finally {
      clearTimeout(timeout)
    }
  }

  getStats() {
    return {
      sourceName: this.sourceName,
      url: this.options.url,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      pollCount: this.pollCount,
    }
  }
}
