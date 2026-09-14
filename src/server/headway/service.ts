import { GTFSRepository } from '../gtfs/database.js'
import { VehicleDataSource } from '../realtime/vehicle-data-source.js'
import { PredictionEngine } from '../realtime/predictions.js'
import {
  HeadwayControlPoint,
  HeadwayStatus,
  HeadwayVehicle,
  HeadwaysResponse,
  Recommendation,
  RouteBranch,
} from './types.js'

const STALE_THRESHOLD_MS = 120_000
const DEFAULT_HEADWAY_S = 600
const HEADWAY_WINDOW_HOURS = 3
const MAX_CONTROL_POINTS = 80
const MAX_BRANCHES = 6
const MAX_BRANCH_STOPS = 20
const TARGET_LOW_FACTOR = 0.6
const TARGET_HIGH_FACTOR = 1.4
const MIN_HOLD_S = 15
const MAX_HOLD_S = 180
const RECOMMENDATION_TTL_MS = 60_000
const MODEL_CACHE_MAX = 60

function fmtDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

function secondsSinceMidnight(d: Date): number {
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()
}

function fmtSeconds(seconds: number): string {
  const s = Math.round(seconds)
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${String(r).padStart(2, '0')}`
}

/** Per-route model built once per service day and cached. */
interface RouteModel {
  /** Today's active trips (start times) for the route/direction. */
  activeTrips: { start_time: number }[]
  trunk: HeadwayControlPoint[]
  trunkIndex: Map<string, number>
  branches: RouteBranch[]
  /** stopId -> today's scheduled departure times (seconds since midnight). */
  departures: Map<string, number[]>
}

/**
 * Headway service: computes vehicle spacing along a route for the dispatcher
 * time-space chart.
 *
 * The x-axis is the route's main sequence ("trunk") — the heavily-traversed
 * corridor found by a widest-path DP over the scheduled-trip stop graph. Short
 * turns and branches are placed along shared segments, and branch geometry is
 * exposed for the visualizer.
 *
 * Spacing is measured between consecutive vehicles at their shared upcoming
 * stops using predicted arrival times; the target headway derives from the
 * scheduled headway of trips around the current time.
 */
export class HeadwayService {
  private routeModelCache = new Map<string, RouteModel>()

  constructor(
    private repo: GTFSRepository,
    private vehicleSource: VehicleDataSource,
    private predictions: PredictionEngine
  ) {}

  getHeadways(routeId: string, directionId?: number, now: Date = new Date()): HeadwaysResponse {
    const route = this.repo.getRoute(routeId)
    const warnings: string[] = []
    if (!route) {
      throw new Error('Route not found')
    }

    const dateStr = fmtDate(now)
    const nowSec = secondsSinceMidnight(now)
    const nowEpoch = Math.floor(now.getTime() / 1000)
    const nowMs = now.getTime()

    const vehicles = this.vehicleSource
      .getVehicles()
      .filter((v) => v.routeId === routeId)
      .filter((v) => directionId === undefined || v.directionId === directionId)
      .filter((v) => v.status !== 'COMPLETED')

    const vehicleModels: HeadwayVehicle[] = []
    for (const v of vehicles) {
      const pred = this.predictions.predictTrip(v.tripId, now)
      if (!pred) continue
      vehicleModels.push({
        vehicleId: v.vehicleId,
        tripId: v.tripId,
        routeId: v.routeId,
        directionId: v.directionId,
        status: v.status,
        currentStopIndex: v.currentStopIndex,
        currentStopId: v.nextStopId,
        delaySeconds: v.delaySeconds ?? null,
        lastUpdateTime: v.lastUpdateTime,
        progress: v.totalDistance > 0 ? v.distanceTraveled / v.totalDistance : 0,
        axisPosition: 0,
        points: pred.predictions.map((p) => ({
          stopId: p.stopId,
          stopName: this.repo.getStop(p.stopId)?.stop_name ?? p.stopId,
          stopSequence: p.stopSequence,
          predictedArrival: p.arrivalTime,
          predictedDeparture: p.departureTime,
          isRealtime: p.isRealtime,
        })),
        headwayAheadSeconds: null,
        headwayBehindSeconds: null,
        targetHeadwaySeconds: 0,
        headwayStatus: 'UNKNOWN' as HeadwayStatus,
        leaderVehicleId: null,
        followerVehicleId: null,
      })
    }

    // Order and pair vehicles within each direction (never across directions),
    // using each direction's own trunk axis.
    const groups = new Map<number, HeadwayVehicle[]>()
    for (const vm of vehicleModels) {
      const group = groups.get(vm.directionId) ?? []
      group.push(vm)
      groups.set(vm.directionId, group)
    }

    const ordered: HeadwayVehicle[] = []
    for (const [dir, group] of groups) {
      const model = this.getRouteModel(routeId, dir, dateStr)
      const idx = model.trunkIndex
      group.sort(
        (a, b) => this.controlProgress(b, idx, nowEpoch) - this.controlProgress(a, idx, nowEpoch)
      )

      const axisLen = Math.max(1, idx.size - 1)
      const target = this.computeTargetHeadwayFromModel(model, nowSec)
      for (let i = 0; i < group.length; i++) {
        const v = group[i]
        v.targetHeadwaySeconds = target
        v.axisPosition = Math.max(0, Math.min(1, this.controlProgress(v, idx, nowEpoch) / axisLen))
        const ahead = group[i - 1]
        const behind = group[i + 1]
        v.leaderVehicleId = ahead?.vehicleId ?? null
        v.followerVehicleId = behind?.vehicleId ?? null
        v.headwayAheadSeconds = this.sanitizeHeadway(
          ahead ? this.computeHeadwayBetween(ahead, v) : null
        )
        v.headwayBehindSeconds = this.sanitizeHeadway(
          behind ? this.computeHeadwayBetween(v, behind) : null
        )
        v.headwayStatus = this.classifyStatus(v, nowMs)
      }
      ordered.push(...group)
    }

    // Axis model: the requested direction, or the direction with the most
    // active vehicles (fallback direction 0).
    let axisModel: RouteModel
    if (directionId !== undefined) {
      axisModel = this.getRouteModel(routeId, directionId, dateStr)
    } else {
      let bestDir = 0
      let bestCount = -1
      for (const [dir, group] of groups) {
        if (group.length > bestCount) {
          bestCount = group.length
          bestDir = dir
        }
      }
      axisModel = this.getRouteModel(routeId, bestDir, dateStr)
    }

    const controlPoints = axisModel.trunk.map((cp) => ({
      ...cp,
      scheduledHeadwaySeconds: this.scheduledHeadwayAtStopFromModel(axisModel, cp.stopId, nowSec),
    }))

    if (ordered.length === 0) {
      warnings.push(
        `No active vehicles for route ${routeId}${directionId !== undefined ? ` direction ${directionId}` : ''}`
      )
    }

    return {
      route: {
        routeId: route.route_id,
        routeShortName: route.route_short_name,
        routeLongName: route.route_long_name,
        routeColor: route.route_color,
      },
      directionId: directionId ?? null,
      timestamp: nowMs,
      date: dateStr,
      targetHeadwaySeconds: this.computeTargetHeadwayFromModel(axisModel, nowSec),
      vehicles: ordered,
      controlPoints,
      topology: { trunk: controlPoints, branches: axisModel.branches },
      warnings,
    }
  }

  /**
   * Propose service-restoration actions from current headway state.
   * Currently: HOLD recommendations for bunched vehicles, measured at the
   * vehicle's next upcoming stop, sized to restore the target headway.
   */
  getRecommendations(
    routeId: string,
    directionId?: number,
    now: Date = new Date()
  ): Recommendation[] {
    const data = this.getHeadways(routeId, directionId, now)
    const nowMs = now.getTime()
    const recommendations: Recommendation[] = []

    for (const v of data.vehicles) {
      if (v.headwayStatus !== 'BUNCHED' || v.headwayAheadSeconds === null) continue

      const nextStop = this.nextControlPoint(v)
      if (!nextStop) continue

      const deficit = v.targetHeadwaySeconds - v.headwayAheadSeconds
      const hold = Math.min(MAX_HOLD_S, Math.max(MIN_HOLD_S, Math.round(deficit)))
      const expected = v.headwayAheadSeconds + hold

      recommendations.push({
        id: `rec_${v.vehicleId}_${nowMs}`,
        vehicleId: v.vehicleId,
        tripId: v.tripId,
        routeId: v.routeId,
        action: 'HOLD',
        controlPointStopId: nextStop.stopId,
        controlPointStopName: nextStop.stopName,
        holdSeconds: hold,
        currentHeadwaySeconds: Math.round(v.headwayAheadSeconds),
        targetHeadwaySeconds: v.targetHeadwaySeconds,
        expectedHeadwaySeconds: Math.round(expected),
        reason: `Vehicle ${v.vehicleId} is bunched (${fmtSeconds(v.headwayAheadSeconds)} vs ${fmtSeconds(v.targetHeadwaySeconds)} target). Hold ${hold}s at ${nextStop.stopName} to restore spacing.`,
        confidence: 0.8,
        createdAt: nowMs,
        expiresAt: nowMs + RECOMMENDATION_TTL_MS,
        status: 'PENDING',
      })
    }

    return recommendations
  }

  // ─── Route topology ──────────────────────────────────────────────

  private getRouteModel(routeId: string, directionId: number, dateStr: string): RouteModel {
    const key = `${routeId}_${directionId}_${dateStr}`
    const cached = this.routeModelCache.get(key)
    if (cached) return cached
    const model = this.buildRouteModel(routeId, directionId, dateStr)
    if (this.routeModelCache.size >= MODEL_CACHE_MAX) this.routeModelCache.clear()
    this.routeModelCache.set(key, model)
    return model
  }

  /**
   * Build the full-route topology for a route/direction on a service day:
   *  1. Collapse trips into weighted stop-sequence patterns (single query).
   *     Edge weight = scheduled trips traversing it, weighted so weekday
   *     services dominate weekend service (5:1).
   *  2. Widest main path (trunk) via DAG topological sort + DP.
   *  3. Off-trunk walks (branches), which may rejoin the trunk or dead-end.
   * Also collects today's per-stop scheduled departure times for headway math.
   */
  private buildRouteModel(routeId: string, directionId: number, dateStr: string): RouteModel {
    const weekPatterns = this.repo.getServiceWeekPatterns()
    const serviceWeight = (sid: string): number => {
      const p = weekPatterns.get(sid)
      return p && p.weekdayCount > 0 ? 5 : 1
    }

    // Row-based query: stop_times joined to route trips, ordered by trip +
    // stop_sequence for pattern grouping. Uses the trips(route_id,
    // direction_id) index and the stop_times PK (avoids a full scan).
    const raw = this.repo
      .getDb()
      .prepare(
        `
            SELECT st.trip_id, st.stop_id, st.departure_time, t.service_id, t.start_time
            FROM stop_times st
            JOIN trips t ON t.trip_id = st.trip_id
            WHERE t.route_id = ? AND t.direction_id = ?
            ORDER BY st.trip_id, st.stop_sequence
        `
      )
      .all(routeId, directionId) as {
      trip_id: string
      stop_id: string
      departure_time: number
      service_id: string
      start_time: number
    }[]

    const trips = new Map<
      string,
      { service_id: string; start_time: number; stops: string[]; deps: number[] }
    >()
    for (const r of raw) {
      let tr = trips.get(r.trip_id)
      if (!tr) {
        tr = { service_id: r.service_id, start_time: r.start_time, stops: [], deps: [] }
        trips.set(r.trip_id, tr)
      }
      tr.stops.push(r.stop_id)
      tr.deps.push(r.departure_time)
    }

    // Which services actually run today (drives departures + activeTrips).
    const activeToday = new Set<string>()
    for (const tr of trips.values()) {
      if (
        !activeToday.has(tr.service_id) &&
        this.repo.isServiceActiveToday(tr.service_id, dateStr)
      ) {
        activeToday.add(tr.service_id)
      }
    }

    const stopNames = new Map<string, string>()
    const departures = new Map<string, number[]>()
    const activeTrips: { start_time: number }[] = []
    const patternCount = new Map<string, number>() // pattern -> weighted trip count
    const patternSample = new Map<string, string[]>() // pattern -> stop sequence

    for (const tr of trips.values()) {
      if (tr.stops.length < 2) continue
      const pattern = tr.stops.join('>')
      for (const s of tr.stops) {
        if (!stopNames.has(s)) stopNames.set(s, this.repo.getStop(s)?.stop_name ?? s)
      }
      const w = serviceWeight(tr.service_id)
      patternCount.set(pattern, (patternCount.get(pattern) ?? 0) + w)
      if (!patternSample.has(pattern)) patternSample.set(pattern, tr.stops)

      if (activeToday.has(tr.service_id)) {
        activeTrips.push({ start_time: tr.start_time })
        for (let i = 0; i < tr.stops.length; i++) {
          const list = departures.get(tr.stops[i]) ?? []
          list.push(tr.deps[i])
          departures.set(tr.stops[i], list)
        }
      }
    }

    const empty: RouteModel = {
      activeTrips,
      trunk: [],
      trunkIndex: new Map(),
      branches: [],
      departures,
    }
    if (stopNames.size === 0) return empty

    // Weighted edges + weighted terminal frequencies from patterns
    const edgeWeight = new Map<string, number>()
    const firstStops = new Map<string, number>()
    const lastStops = new Map<string, number>()
    for (const [pattern, stops] of patternSample) {
      const w = patternCount.get(pattern)!
      for (let i = 1; i < stops.length; i++) {
        const key = `${stops[i - 1]}>${stops[i]}`
        edgeWeight.set(key, (edgeWeight.get(key) ?? 0) + w)
      }
      firstStops.set(stops[0], (firstStops.get(stops[0]) ?? 0) + w)
      lastStops.set(stops[stops.length - 1], (lastStops.get(stops[stops.length - 1]) ?? 0) + w)
    }

    let source = ''
    let sink = ''
    for (const [id, c] of firstStops) if (c > (firstStops.get(source) ?? 0)) source = id
    for (const [id, c] of lastStops) if (c > (lastStops.get(sink) ?? 0)) sink = id
    if (!source || !sink) return empty

    // Adjacency with weights
    const adjacency = new Map<string, Map<string, number>>()
    for (const key of edgeWeight.keys()) {
      const idx = key.indexOf('>')
      const u = key.slice(0, idx)
      const v = key.slice(idx + 1)
      let m = adjacency.get(u)
      if (!m) {
        m = new Map()
        adjacency.set(u, m)
      }
      m.set(v, edgeWeight.get(key)!)
    }

    // Widest path (max-min) via Dijkstra — robust even with loop terminals
    // that would create cycles for a naive topological sort.
    const bestW = new Map<string, number>()
    const prev = new Map<string, string | null>()
    for (const sid of stopNames.keys()) bestW.set(sid, 0)
    bestW.set(source, Infinity)
    prev.set(source, null)
    const settled = new Set<string>()
    while (settled.size < stopNames.size) {
      let u: string | null = null
      let bestVal = -1
      for (const sid of stopNames.keys()) {
        if (!settled.has(sid) && (bestW.get(sid) ?? 0) > bestVal) {
          bestVal = bestW.get(sid)!
          u = sid
        }
      }
      if (u === null) break
      settled.add(u)
      if (u === sink) break
      for (const [v, w] of adjacency.get(u) ?? new Map()) {
        const cand = Math.min(bestW.get(u) ?? 0, w)
        if (cand > (bestW.get(v) ?? 0)) {
          bestW.set(v, cand)
          prev.set(v, u)
        }
      }
    }

    // Reconstruct trunk source -> sink
    const path: string[] = []
    if ((bestW.get(sink) ?? 0) > 0) {
      let cur: string | null = sink
      let guard = 0
      while (cur && guard++ < 500) {
        path.unshift(cur)
        if (cur === source) break
        cur = prev.get(cur) ?? null
      }
    }
    if (path[0] !== source) return empty

    const trunkSet = new Set(path)
    const trunkIndex = new Map<string, number>()
    path.forEach((sid, i) => trunkIndex.set(sid, i))
    const trunk: HeadwayControlPoint[] = path.map((sid, i) => ({
      stopId: sid,
      stopName: stopNames.get(sid) ?? sid,
      stopSequence: i + 1,
      scheduledHeadwaySeconds: null,
    }))

    // Branches: off-trunk walks from each trunk stop
    const branches: RouteBranch[] = []
    const visitedEdges = new Set<string>()
    for (const u of path) {
      if (branches.length >= MAX_BRANCHES) break
      const out = adjacency.get(u)
      if (!out) continue
      for (const [v] of out) {
        const edgeKey = `${u}>${v}`
        if (visitedEdges.has(edgeKey) || trunkSet.has(v)) continue
        visitedEdges.add(edgeKey)
        const stops: HeadwayControlPoint[] = []
        let curB = v
        let rejoin: string | null = null
        let bGuard = 0
        while (curB && !trunkSet.has(curB) && bGuard++ < MAX_BRANCH_STOPS) {
          stops.push({
            stopId: curB,
            stopName: stopNames.get(curB) ?? curB,
            stopSequence: path.length + stops.length + 1,
            scheduledHeadwaySeconds: null,
          })
          const nextM = adjacency.get(curB)
          if (!nextM || nextM.size === 0) break
          const nextEdge = [...nextM.entries()].sort((a, b) => b[1] - a[1])[0]
          visitedEdges.add(`${curB}>${nextEdge[0]}`)
          curB = nextEdge[0]
        }
        if (trunkSet.has(curB)) rejoin = curB
        if (stops.length > 0) {
          branches.push({
            divergeStopId: u,
            divergeStopName: stopNames.get(u) ?? u,
            stops,
            rejoinStopId: rejoin,
          })
        }
      }
    }

    return { activeTrips, trunk, trunkIndex, branches, departures }
  }

  private scheduledHeadwayAtStopFromModel(
    model: RouteModel,
    stopId: string,
    nowSec: number
  ): number | null {
    const lo = nowSec - HEADWAY_WINDOW_HOURS * 3600
    const hi = nowSec + HEADWAY_WINDOW_HOURS * 3600
    const times = (model.departures.get(stopId) ?? [])
      .filter((t) => t >= lo && t <= hi)
      .sort((a, b) => a - b)
    if (times.length < 2) return null
    const diffs: number[] = []
    for (let i = 1; i < times.length; i++) {
      const d = times[i] - times[i - 1]
      if (d > 0) diffs.push(d)
    }
    if (diffs.length === 0) return null
    diffs.sort((a, b) => a - b)
    const mid = Math.floor(diffs.length / 2)
    const median = diffs.length % 2 === 0 ? (diffs[mid - 1] + diffs[mid]) / 2 : diffs[mid]
    return Math.max(30, Math.round(median))
  }

  private computeTargetHeadwayFromModel(model: RouteModel, nowSec: number): number {
    const lo = nowSec - HEADWAY_WINDOW_HOURS * 3600
    const hi = nowSec + HEADWAY_WINDOW_HOURS * 3600
    const trips = model.activeTrips
      .filter((t) => t.start_time >= lo && t.start_time <= hi)
      .sort((a, b) => a.start_time - b.start_time)
    if (trips.length < 2) return DEFAULT_HEADWAY_S
    const diffs: number[] = []
    for (let i = 1; i < trips.length; i++) {
      const d = trips[i].start_time - trips[i - 1].start_time
      if (d > 0) diffs.push(d)
    }
    if (diffs.length === 0) return DEFAULT_HEADWAY_S
    diffs.sort((a, b) => a - b)
    const mid = Math.floor(diffs.length / 2)
    const median = diffs.length % 2 === 0 ? (diffs[mid - 1] + diffs[mid]) / 2 : diffs[mid]
    return Math.max(60, Math.round(median))
  }

  private nextControlPoint(v: HeadwayVehicle): HeadwayControlPoint | null {
    for (const p of v.points) {
      if (p.stopSequence - 1 >= v.currentStopIndex) {
        return {
          stopId: p.stopId,
          stopName: p.stopName,
          stopSequence: p.stopSequence,
          scheduledHeadwaySeconds: null,
        }
      }
    }
    return null
  }

  /**
   * Position of a vehicle along the shared control-point axis, comparable
   * across trip patterns. Uses the last passed control point and the next
   * upcoming control point, interpolating by predicted time between them.
   */
  private controlProgress(
    v: HeadwayVehicle,
    ctrlIndex: Map<string, number>,
    nowEpoch: number
  ): number {
    const pts = v.points
      .filter((p) => ctrlIndex.has(p.stopId))
      .sort((a, b) => a.stopSequence - b.stopSequence)
    if (pts.length === 0) return v.progress

    let prevIdx = -1
    let prevTime = 0
    let nextIdx = -1
    let nextTime = 0
    for (const p of pts) {
      const ci = ctrlIndex.get(p.stopId)!
      const passed = p.stopSequence - 1 <= v.currentStopIndex
      if (passed) {
        if (ci > prevIdx) {
          prevIdx = ci
          prevTime = p.predictedArrival
        }
      } else if (nextIdx === -1 || ci < nextIdx) {
        nextIdx = ci
        nextTime = p.predictedArrival
      }
    }

    if (prevIdx !== -1 && nextIdx !== -1) {
      const span = nextTime - prevTime
      const frac = span > 0 ? Math.max(0, Math.min(1, (nowEpoch - prevTime) / span)) : 0.5
      return prevIdx + frac
    }
    if (prevIdx !== -1) return prevIdx + 0.5
    if (nextIdx !== -1) return Math.max(0, nextIdx - 0.5)
    return v.progress
  }

  /** Reject headway values that indicate a broken ordering/prediction. */
  private sanitizeHeadway(value: number | null): number | null {
    if (value === null) return null
    if (Math.abs(value) > 2 * 3600) return null
    return Math.round(value)
  }

  /**
   * Headway between two vehicles measured at the first shared upcoming stop
   * relative to the following (behind) vehicle. Positive means the following
   * vehicle is behind schedule vs. the leading vehicle (a gap); negative
   * means bunching.
   */
  private computeHeadwayBetween(ahead: HeadwayVehicle, behind: HeadwayVehicle): number | null {
    const aheadTimes = new Map<string, number>()
    for (const p of ahead.points) aheadTimes.set(p.stopId, p.predictedArrival)

    for (const p of behind.points) {
      if (p.stopSequence - 1 <= behind.currentStopIndex) continue // already passed
      const aheadTime = aheadTimes.get(p.stopId)
      if (aheadTime !== undefined) {
        return p.predictedArrival - aheadTime
      }
    }
    return null
  }

  private classifyStatus(v: HeadwayVehicle, nowMs: number): HeadwayStatus {
    if (nowMs - v.lastUpdateTime > STALE_THRESHOLD_MS) return 'STALE'
    if (v.headwayAheadSeconds === null) return 'UNKNOWN'
    const t = v.targetHeadwaySeconds
    const h = v.headwayAheadSeconds
    if (h < TARGET_LOW_FACTOR * t) return 'BUNCHED'
    if (h > TARGET_HIGH_FACTOR * t) return 'GAPPED'
    return 'NORMAL'
  }
}
