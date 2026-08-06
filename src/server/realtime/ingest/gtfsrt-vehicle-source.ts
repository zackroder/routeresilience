import { GTFSRepository } from '../../gtfs/database.js'
import { VehicleState } from '../../simulation/types.js'
import { ArrivalRecord, VehicleDataSource } from '../vehicle-data-source.js'
import { GtfsRtClient } from './gtfsrt-client.js'
import { EnrichedVehicle, GtfsRtEnricher, RawVehiclePosition } from './enrich.js'

const DEFAULT_POLL_INTERVAL_MS = 15_000
const STALE_TTL_MS = 5 * 60 * 1000 // drop vehicles unseen for 5 minutes
const MAX_ARRIVALS = 2000
const MAX_SEEN_ARRIVALS = 20_000

/**
 * VehicleDataSource backed by a real GTFS-RT VehiclePositions feed.
 *
 * Polls the feed on an interval, enriches each vehicle with schedule/geometry
 * context from GTFS static data, and exposes the result to the prediction,
 * headway, and feed-generation pipeline — the same contract SimulationEngine
 * provides, so it can be swapped via VEHICLE_SOURCE=gtfs-rt.
 */
export class GtfsRtVehicleSource implements VehicleDataSource {
  readonly sourceName = 'gtfs-rt'

  private vehicles = new Map<string, VehicleState>()
  private vehiclesByTripId = new Map<string, string>()
  private arrivals: ArrivalRecord[] = []
  private seenArrivalKeys = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private lastPollAt = 0
  private lastError: string | null = null
  private skippedCount = 0
  private pollCount = 0

  private readonly enricher: GtfsRtEnricher

  constructor(
    private repo: GTFSRepository,
    private client: GtfsRtClient,
    private pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS
  ) {
    this.enricher = new GtfsRtEnricher(repo)
  }

  /**
   * Fetch and ingest one feed snapshot. Logs errors and keeps the previous
   * vehicle state on failure so transient network issues don't wipe the map.
   */
  async pollOnce(now: Date = new Date()): Promise<void> {
    try {
      const feed = await this.client.poll()
      const entities = (feed?.entity ?? []) as RawVehiclePosition[]

      for (const entity of entities) {
        const enriched = this.enricher.enrich(entity, now)
        if (!enriched) {
          this.skippedCount++
          continue
        }
        this.upsertVehicle(enriched)
      }

      this.pruneStale(now.getTime())
      this.lastError = null
      this.lastPollAt = Date.now()
      this.pollCount++
    } catch (err) {
      this.lastError = (err as Error).message
    }
  }

  private upsertVehicle(enriched: EnrichedVehicle): void {
    const { state } = enriched
    this.vehicles.set(state.vehicleId, state)
    this.vehiclesByTripId.set(state.tripId, state.vehicleId)

    // Synthesize arrival events from STOPPED_AT reports, deduped per trip+stop.
    if (
      enriched.currentStatus === 1 &&
      enriched.stopId &&
      enriched.state.tripId &&
      enriched.timestampMs > 0
    ) {
      const key = `${enriched.state.tripId}|${enriched.stopId}`
      if (!this.seenArrivalKeys.has(key)) {
        this.seenArrivalKeys.add(key)
        this.arrivals.push({
          vehicleId: state.vehicleId,
          tripId: state.tripId,
          stopId: enriched.stopId,
          timestamp: enriched.timestampMs,
        })
        if (this.arrivals.length > MAX_ARRIVALS) this.arrivals.shift()
      }
    }

    // Keep the seen-key set bounded.
    if (this.seenArrivalKeys.size > MAX_SEEN_ARRIVALS) this.seenArrivalKeys.clear()
  }

  private pruneStale(nowMs: number): void {
    for (const [id, v] of this.vehicles) {
      if (nowMs - v.lastUpdateTime > STALE_TTL_MS) {
        this.vehicles.delete(id)
        this.vehiclesByTripId.delete(v.tripId)
      }
    }
  }

  /** Start polling on an interval (and do one immediate poll). */
  async start(): Promise<void> {
    if (this.timer) return
    await this.pollOnce()
    this.timer = setInterval(() => {
      void this.pollOnce()
    }, this.pollIntervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  // ─── VehicleDataSource ───

  getVehicles(): VehicleState[] {
    return Array.from(this.vehicles.values())
  }

  getVehicleForTrip(tripId: string): VehicleState | undefined {
    const id = this.vehiclesByTripId.get(tripId)
    return id ? this.vehicles.get(id) : undefined
  }

  getVehicleCount(): number {
    return this.vehicles.size
  }

  getArrivals(): ArrivalRecord[] {
    return this.arrivals
  }

  getStats() {
    return {
      ...this.client.getStats(),
      vehicleCount: this.vehicles.size,
      arrivalCount: this.arrivals.length,
      skippedCount: this.skippedCount,
      pollCount: this.pollCount,
    }
  }
}
