import { GTFSRepository } from '../../gtfs/database.js'
import { haversineMeters } from '../../gtfs/loader.js'
import { StopTime, ShapePoint } from '../../gtfs/types.js'
import { InterpolatedShapePoint, VehicleState } from '../../simulation/types.js'

/**
 * Raw GTFS-RT VehiclePosition entity as decoded by protobufjs (camelCase keys).
 */
export interface RawVehiclePosition {
  id: string
  vehicle?: {
    trip?: {
      tripId?: string
      routeId?: string
      directionId?: number
      startDate?: string
      startTime?: string
      scheduleRelationship?: number
    }
    vehicle?: { id?: string; label?: string }
    position?: { latitude?: number; longitude?: number; bearing?: number; speed?: number }
    currentStopSequence?: number
    stopId?: string
    currentStatus?: number
    congestionLevel?: number
    occupancyStatus?: number
    timestamp?: number
  }
}

/** A vehicle position ready to be exposed downstream, plus arrival info. */
export interface EnrichedVehicle {
  state: VehicleState
  /** GTFS-RT current stop sequence (1-based), if the feed provided one. */
  stopSequence: number | null
  /** Stop the vehicle reports (STOPPED_AT / current). */
  stopId: string | null
  /** GTFS-RT VehicleStopStatus enum: 0 INCOMING_AT, 1 STOPPED_AT, 2 IN_TRANSIT_TO. */
  currentStatus: number | null
  /** Epoch ms of the vehicle's last reported position. */
  timestampMs: number
}

const DEFAULT_SPEED_MPS = 8.9
const MAX_SPEED_MPS = 15.6
const MIN_SEGMENT_SPEED_MPS = 2

/**
 * Enriches raw GTFS-RT VehiclePosition entities into the schedule/geometry-aware
 * VehicleState that PredictionEngine, HeadwayService and FeedGenerator consume.
 *
 * Real feeds only give us a lat/lon, trip id and stop sequence; everything else
 * (distance along shape, per-segment speeds, delay vs schedule, next stop) is
 * derived from GTFS static data via the repository.
 */
export class GtfsRtEnricher {
  private interpolatedShapes = new Map<string, InterpolatedShapePoint[]>()
  private stopShapeDistanceCache = new Map<string, number>()

  constructor(private repo: GTFSRepository) {}

  /**
   * Convert one feed entity to a VehicleState. Returns null when the entity is
   * not a usable vehicle (missing position/trip) or its trip is unknown to GTFS.
   */
  enrich(entity: RawVehiclePosition, now: Date = new Date()): EnrichedVehicle | null {
    const vp = entity.vehicle
    if (!vp?.position) return null
    const tripId = vp.trip?.tripId
    if (!tripId) return null

    const trip = this.repo.getTrip(tripId)
    if (!trip) return null

    const stopTimes = this.repo.getStopTimes(tripId)
    if (!stopTimes || stopTimes.length < 2) return null

    const shape = trip.shape_id ? this.getInterpolatedShape(trip.shape_id) : null
    const lat = vp.position.latitude ?? 0
    const lon = vp.position.longitude ?? 0
    const { segmentDistances, segmentSpeeds, distanceTraveled, totalDistance } = shape
      ? this.projectVehicle(trip.shape_id ?? '', shape, stopTimes, lat, lon)
      : this.fallbackGeometry(stopTimes, lat, lon)

    // GTFS-RT stop sequences are 1-based; VehicleState.currentStopIndex is 0-based.
    const currentStopIndex =
      vp.currentStopSequence !== undefined
        ? Math.max(0, Math.min(stopTimes.length - 1, vp.currentStopSequence - 1))
        : this.inferStopIndex(segmentDistances, distanceTraveled)

    const status = vp.currentStatus === 1 ? 'AT_STOP' : 'IN_TRANSIT'
    const nextStop = stopTimes[Math.min(currentStopIndex + 1, stopTimes.length - 1)]
    const nextStopData = nextStop ? this.repo.getStop(nextStop.stop_id) : null

    const timestampMs = vp.timestamp ? vp.timestamp * 1000 : now.getTime()
    const delaySeconds = this.computeDelaySeconds(
      stopTimes,
      segmentDistances,
      distanceTraveled,
      now,
      currentStopIndex
    )

    const state: VehicleState = {
      vehicleId: vp.vehicle?.id ?? entity.id,
      tripId,
      routeId: trip.route_id,
      directionId: trip.direction_id,
      shapeId: trip.shape_id ?? '',
      lat: vp.position.latitude ?? 0,
      lon: vp.position.longitude ?? 0,
      bearing: vp.position.bearing ?? 0,
      speed: vp.position.speed ?? DEFAULT_SPEED_MPS,
      shapeIndex: 0,
      distanceTraveled,
      totalDistance,
      currentStopIndex,
      nextStopId: nextStop?.stop_id ?? '',
      nextStopLat: nextStopData?.stop_lat,
      nextStopLon: nextStopData?.stop_lon,
      cachedStopTimes: stopTimes.map((st) => ({
        stop_id: st.stop_id,
        arrival_time: st.arrival_time,
      })),
      status,
      tripStartTime: stopTimes[0].arrival_time,
      lastUpdateTime: timestampMs,
      dwellEndTime: 0,
      scheduledEndTime: stopTimes[stopTimes.length - 1].arrival_time,
      delaySeconds,
      segmentSpeeds,
      segmentDistances,
      congestionMultiplier: 1,
      occupancyStatus: vp.occupancyStatus,
      congestionLevel: vp.congestionLevel,
    }

    return {
      state,
      stopSequence: vp.currentStopSequence ?? null,
      stopId: vp.stopId ?? null,
      currentStatus: vp.currentStatus ?? null,
      timestampMs,
    }
  }

  /** Lazy-load and interpolate a shape if not already cached. */
  private getInterpolatedShape(shapeId: string): InterpolatedShapePoint[] | null {
    const cached = this.interpolatedShapes.get(shapeId)
    if (cached) return cached
    const points = this.repo.getShape(shapeId)
    if (!points || points.length === 0) return null
    const interpolated = interpolateShape(points)
    this.interpolatedShapes.set(shapeId, interpolated)
    return interpolated
  }

  private projectVehicle(
    shapeId: string,
    shape: InterpolatedShapePoint[],
    stopTimes: StopTime[],
    lat: number,
    lon: number
  ): {
    segmentDistances: number[]
    segmentSpeeds: number[]
    distanceTraveled: number
    totalDistance: number
  } {
    const segmentDistances = stopTimes.map((st) => this.stopDistance(shapeId, st.stop_id, shape))
    ensureMonotonic(segmentDistances)
    const segmentSpeeds = computeSegmentSpeeds(stopTimes, segmentDistances)
    const totalDistance = shape[shape.length - 1].distance
    const distanceTraveled = Math.min(projectOntoShape(shape, lat, lon), totalDistance)
    return { segmentDistances, segmentSpeeds, distanceTraveled, totalDistance }
  }

  /**
   * Geometry fallback for trips without a shape: treat the stop-to-stop great
   * circle segments as the route and project the vehicle onto them.
   */
  private fallbackGeometry(
    stopTimes: StopTime[],
    lat: number,
    lon: number
  ): {
    segmentDistances: number[]
    segmentSpeeds: number[]
    distanceTraveled: number
    totalDistance: number
  } {
    const segmentDistances: number[] = []
    const stopCoords: { lat: number; lon: number }[] = []
    for (let i = 0; i < stopTimes.length; i++) {
      const stop = this.repo.getStop(stopTimes[i].stop_id)
      stopCoords.push(stop ? { lat: stop.stop_lat, lon: stop.stop_lon } : { lat, lon })
      if (i === 0) {
        segmentDistances.push(0)
      } else {
        const prev = stopCoords[i - 1]
        const curr = stopCoords[i]
        const cum =
          segmentDistances[i - 1] + haversineMeters(prev.lat, prev.lon, curr.lat, curr.lon)
        segmentDistances.push(cum)
      }
    }
    const segmentSpeeds = computeSegmentSpeeds(stopTimes, segmentDistances)
    const totalDistance = segmentDistances[segmentDistances.length - 1]
    const distanceTraveled = projectOntoStopPolyline(stopCoords, segmentDistances, lat, lon)
    return { segmentDistances, segmentSpeeds, distanceTraveled, totalDistance }
  }

  /** Cumulative distance along the shape to a stop (cached per shape/stop). */
  private stopDistance(shapeId: string, stopId: string, shape: InterpolatedShapePoint[]): number {
    const cacheKey = `${shapeId}_${stopId}`
    const cached = this.stopShapeDistanceCache.get(cacheKey)
    if (cached !== undefined) return cached

    const stop = this.repo.getStop(stopId)
    if (!stop) return shape[shape.length - 1].distance

    let bestDist = Infinity
    let best = 0
    for (const sp of shape) {
      const d = haversineMeters(stop.stop_lat, stop.stop_lon, sp.lat, sp.lon)
      if (d < bestDist) {
        bestDist = d
        best = sp.distance
      }
    }
    this.stopShapeDistanceCache.set(cacheKey, best)
    return best
  }

  private inferStopIndex(segmentDistances: number[], distanceTraveled: number): number {
    let idx = 0
    for (let i = 0; i < segmentDistances.length; i++) {
      if (segmentDistances[i] <= distanceTraveled) idx = i
    }
    return idx
  }

  /**
   * Schedule adherence: interpolate the scheduled time at the vehicle's distance
   * along the route and compare against the current time of day.
   */
  private computeDelaySeconds(
    stopTimes: StopTime[],
    segmentDistances: number[],
    distanceTraveled: number,
    now: Date,
    currentStopIndex: number
  ): number {
    const nowSec = secondsSinceMidnight(now)

    // If the vehicle is at/past the last stop, use the final scheduled arrival.
    if (currentStopIndex >= stopTimes.length - 1) {
      return nowSec - stopTimes[stopTimes.length - 1].arrival_time
    }

    // Interpolate the scheduled time between the current and next stop based on
    // the fraction of the segment already covered.
    const segStart = segmentDistances[currentStopIndex] ?? 0
    const segEnd = segmentDistances[currentStopIndex + 1] ?? segStart
    const span = segEnd - segStart
    const frac = span > 0 ? Math.max(0, Math.min(1, (distanceTraveled - segStart) / span)) : 0
    const schedStart = stopTimes[currentStopIndex].arrival_time
    const schedEnd = stopTimes[currentStopIndex + 1].arrival_time
    const scheduled = schedStart + frac * (schedEnd - schedStart)
    return nowSec - scheduled
  }
}

// ─── Pure geometry helpers ──────────────────────────────────────────

export function interpolateShape(points: ShapePoint[]): InterpolatedShapePoint[] {
  if (points.length < 2) {
    return points.map((p) => ({ lat: p.shape_pt_lat, lon: p.shape_pt_lon, distance: 0 }))
  }

  const result: InterpolatedShapePoint[] = []
  let cumulativeDistance = 0
  result.push({ lat: points[0].shape_pt_lat, lon: points[0].shape_pt_lon, distance: 0 })

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]
    const curr = points[i]
    cumulativeDistance += haversineMeters(
      prev.shape_pt_lat,
      prev.shape_pt_lon,
      curr.shape_pt_lat,
      curr.shape_pt_lon
    )
    result.push({ lat: curr.shape_pt_lat, lon: curr.shape_pt_lon, distance: cumulativeDistance })
  }

  return result
}

/** Distance along the shape nearest to the given coordinate. */
export function projectOntoShape(
  shape: InterpolatedShapePoint[],
  lat: number,
  lon: number
): number {
  let bestDist = Infinity
  let best = 0
  for (const sp of shape) {
    const d = haversineMeters(lat, lon, sp.lat, sp.lon)
    if (d < bestDist) {
      bestDist = d
      best = sp.distance
    }
  }
  return best
}

/** Distance along the stop polyline nearest to the given coordinate. */
export function projectOntoStopPolyline(
  stopCoords: { lat: number; lon: number }[],
  segmentDistances: number[],
  lat: number,
  lon: number
): number {
  let bestDist = Infinity
  let best = 0
  for (let i = 0; i < stopCoords.length - 1; i++) {
    const a = stopCoords[i]
    const b = stopCoords[i + 1]
    const segStart = segmentDistances[i]
    const segEnd = segmentDistances[i + 1]
    const segLen = segEnd - segStart

    // Sample along the segment and keep the closest sample. Stops are typically
    // a few hundred meters apart, so 10 samples is more than enough resolution.
    for (let s = 0; s <= 10; s++) {
      const t = s / 10
      const projLat = a.lat + (b.lat - a.lat) * t
      const projLon = a.lon + (b.lon - a.lon) * t
      const d = haversineMeters(lat, lon, projLat, projLon)
      if (d < bestDist) {
        bestDist = d
        best = segStart + t * segLen
      }
    }
  }
  return best
}

function ensureMonotonic(distances: number[]): void {
  for (let i = 1; i < distances.length; i++) {
    if (distances[i] < distances[i - 1]) {
      distances[i] = distances[i - 1] + 1
    }
  }
}

function computeSegmentSpeeds(stopTimes: StopTime[], segmentDistances: number[]): number[] {
  const segmentSpeeds: number[] = []
  for (let i = 0; i < stopTimes.length - 1; i++) {
    const dist = segmentDistances[i + 1] - segmentDistances[i]
    const time = stopTimes[i + 1].arrival_time - stopTimes[i].departure_time
    let speed: number
    if (time > 0 && dist > 0) {
      speed = dist / time
    } else {
      speed = DEFAULT_SPEED_MPS
    }
    speed = Math.max(MIN_SEGMENT_SPEED_MPS, Math.min(MAX_SPEED_MPS, speed))
    segmentSpeeds.push(speed)
  }
  if (segmentSpeeds.length === 0) segmentSpeeds.push(DEFAULT_SPEED_MPS)
  return segmentSpeeds
}

function secondsSinceMidnight(d: Date): number {
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()
}
