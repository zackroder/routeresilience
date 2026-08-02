import { GTFSRepository } from '../gtfs/database.js';
import { VehicleDataSource } from '../realtime/vehicle-data-source.js';
import { PredictionEngine } from '../realtime/predictions.js';
import {
    HeadwayControlPoint,
    HeadwayStatus,
    HeadwayVehicle,
    HeadwaysResponse,
    Recommendation,
} from './types.js';

const STALE_THRESHOLD_MS = 120_000;
const DEFAULT_HEADWAY_S = 600;
const HEADWAY_WINDOW_HOURS = 3;
const MAX_CONTROL_POINTS = 80;
const TARGET_LOW_FACTOR = 0.6;
const TARGET_HIGH_FACTOR = 1.4;
const MIN_HOLD_S = 15;
const MAX_HOLD_S = 180;
const RECOMMENDATION_TTL_MS = 60_000;

function fmtDate(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
}

function secondsSinceMidnight(d: Date): number {
    return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

function fmtSeconds(seconds: number): string {
    const s = Math.round(seconds);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
}

/**
 * Headway service: computes vehicle spacing along a route for the dispatcher
 * time-space chart.
 *
 * Spacing ("headway") is measured between consecutive vehicles at their shared
 * upcoming stops using predicted arrival times. The target headway is derived
 * from the scheduled headway of active trips around the current time.
 */
export class HeadwayService {
    constructor(
        private repo: GTFSRepository,
        private vehicleSource: VehicleDataSource,
        private predictions: PredictionEngine,
    ) {}

    getHeadways(routeId: string, directionId?: number, now: Date = new Date()): HeadwaysResponse {
        const route = this.repo.getRoute(routeId);
        const warnings: string[] = [];
        if (!route) {
            throw new Error('Route not found');
        }

        const vehicles = this.vehicleSource
            .getVehicles()
            .filter(v => v.routeId === routeId)
            .filter(v => directionId === undefined || v.directionId === directionId)
            .filter(v => v.status !== 'COMPLETED');

        const vehicleModels: HeadwayVehicle[] = [];
        for (const v of vehicles) {
            const pred = this.predictions.predictTrip(v.tripId, now);
            if (!pred) continue;
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
                points: pred.predictions.map(p => ({
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
            });
        }

        // Control points (shared stops) provide a route-position axis that is
        // comparable across trip patterns — unlike per-shape `progress`.
        const controlPoints = this.buildControlPoints(vehicleModels);
        const ctrlIndex = new Map<string, number>();
        controlPoints.forEach((cp, i) => ctrlIndex.set(cp.stopId, i));
        const nowEpoch = Math.floor(now.getTime() / 1000);

        // Order vehicles front-of-route first by their position on the control-point axis.
        const ordered = vehicleModels.sort(
            (a, b) => this.controlProgress(b, ctrlIndex, nowEpoch) - this.controlProgress(a, ctrlIndex, nowEpoch),
        );

        const targetHeadway = this.computeTargetHeadway(routeId, directionId, now);
        const nowMs = now.getTime();

        for (let i = 0; i < ordered.length; i++) {
            const v = ordered[i];
            v.targetHeadwaySeconds = targetHeadway;
            const ahead = ordered[i - 1];
            const behind = ordered[i + 1];
            v.leaderVehicleId = ahead?.vehicleId ?? null;
            v.followerVehicleId = behind?.vehicleId ?? null;
            v.headwayAheadSeconds = this.sanitizeHeadway(ahead ? this.computeHeadwayBetween(ahead, v) : null);
            v.headwayBehindSeconds = this.sanitizeHeadway(behind ? this.computeHeadwayBetween(v, behind) : null);
            v.headwayStatus = this.classifyStatus(v, nowMs);
        }

        for (const cp of controlPoints) {
            cp.scheduledHeadwaySeconds = this.scheduledHeadwayAtStop(routeId, directionId, cp.stopId, now);
        }

        if (ordered.length === 0) {
            warnings.push(
                `No active vehicles for route ${routeId}${directionId !== undefined ? ` direction ${directionId}` : ''}`,
            );
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
            date: fmtDate(now),
            targetHeadwaySeconds: targetHeadway,
            vehicles: ordered,
            controlPoints,
            warnings,
        };
    }

    /**
     * Propose service-restoration actions from current headway state.
     * Currently: HOLD recommendations for bunched vehicles, measured at the
     * vehicle's next upcoming stop, sized to restore the target headway.
     */
    getRecommendations(routeId: string, directionId?: number, now: Date = new Date()): Recommendation[] {
        const data = this.getHeadways(routeId, directionId, now);
        const nowMs = now.getTime();
        const recommendations: Recommendation[] = [];

        for (const v of data.vehicles) {
            if (v.headwayStatus !== 'BUNCHED' || v.headwayAheadSeconds === null) continue;

            const nextStop = this.nextControlPoint(v);
            if (!nextStop) continue;

            const deficit = v.targetHeadwaySeconds - v.headwayAheadSeconds;
            const hold = Math.min(MAX_HOLD_S, Math.max(MIN_HOLD_S, Math.round(deficit)));
            const expected = v.headwayAheadSeconds + hold;

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
            });
        }

        return recommendations;
    }

    private nextControlPoint(v: HeadwayVehicle): HeadwayControlPoint | null {
        for (const p of v.points) {
            if (p.stopSequence - 1 >= v.currentStopIndex) {
                return { stopId: p.stopId, stopName: p.stopName, stopSequence: p.stopSequence, scheduledHeadwaySeconds: null };
            }
        }
        return null;
    }

    /**
     * Position of a vehicle along the shared control-point axis, comparable
     * across trip patterns. Uses the last passed control point and the next
     * upcoming control point, interpolating by predicted time between them.
     */
    private controlProgress(v: HeadwayVehicle, ctrlIndex: Map<string, number>, nowEpoch: number): number {
        const pts = v.points
            .filter(p => ctrlIndex.has(p.stopId))
            .sort((a, b) => a.stopSequence - b.stopSequence);
        if (pts.length === 0) return v.progress;

        let prevIdx = -1;
        let prevTime = 0;
        let nextIdx = -1;
        let nextTime = 0;
        for (const p of pts) {
            const ci = ctrlIndex.get(p.stopId)!;
            const passed = p.stopSequence - 1 <= v.currentStopIndex;
            if (passed) {
                if (ci > prevIdx) { prevIdx = ci; prevTime = p.predictedArrival; }
            } else if (nextIdx === -1 || ci < nextIdx) {
                nextIdx = ci;
                nextTime = p.predictedArrival;
            }
        }

        if (prevIdx !== -1 && nextIdx !== -1) {
            const span = nextTime - prevTime;
            const frac = span > 0 ? Math.max(0, Math.min(1, (nowEpoch - prevTime) / span)) : 0.5;
            return prevIdx + frac;
        }
        if (prevIdx !== -1) return prevIdx + 0.5;
        if (nextIdx !== -1) return Math.max(0, nextIdx - 0.5);
        return v.progress;
    }

    /** Reject headway values that indicate a broken ordering/prediction. */
    private sanitizeHeadway(value: number | null): number | null {
        if (value === null) return null;
        if (Math.abs(value) > 2 * 3600) return null;
        return Math.round(value);
    }

    /**
     * Headway between two vehicles measured at the first shared upcoming stop
     * relative to the following (behind) vehicle. Positive means the following
     * vehicle is behind schedule vs. the leading vehicle (a gap); negative
     * means bunching.
     */
    private computeHeadwayBetween(ahead: HeadwayVehicle, behind: HeadwayVehicle): number | null {
        const aheadTimes = new Map<string, number>();
        for (const p of ahead.points) aheadTimes.set(p.stopId, p.predictedArrival);

        for (const p of behind.points) {
            if (p.stopSequence - 1 <= behind.currentStopIndex) continue; // already passed
            const aheadTime = aheadTimes.get(p.stopId);
            if (aheadTime !== undefined) {
                return p.predictedArrival - aheadTime;
            }
        }
        return null;
    }

    private classifyStatus(v: HeadwayVehicle, nowMs: number): HeadwayStatus {
        if (nowMs - v.lastUpdateTime > STALE_THRESHOLD_MS) return 'STALE';
        if (v.headwayAheadSeconds === null) return 'UNKNOWN';
        const t = v.targetHeadwaySeconds;
        const h = v.headwayAheadSeconds;
        if (h < TARGET_LOW_FACTOR * t) return 'BUNCHED';
        if (h > TARGET_HIGH_FACTOR * t) return 'GAPPED';
        return 'NORMAL';
    }

    private buildControlPoints(vehicles: HeadwayVehicle[]): HeadwayControlPoint[] {
        const byStop = new Map<string, { stopName: string; minSeq: number }>();
        for (const v of vehicles) {
            for (const p of v.points) {
                const existing = byStop.get(p.stopId);
                if (!existing || p.stopSequence < existing.minSeq) {
                    byStop.set(p.stopId, { stopName: p.stopName, minSeq: p.stopSequence });
                }
            }
        }
        return Array.from(byStop.entries())
            .map(([stopId, info]) => ({
                stopId,
                stopName: info.stopName,
                stopSequence: info.minSeq,
                scheduledHeadwaySeconds: null,
            }))
            .sort((a, b) => a.stopSequence - b.stopSequence)
            .slice(0, MAX_CONTROL_POINTS);
    }

    /** Scheduled headway at a single stop (median of consecutive scheduled departures). */
    private scheduledHeadwayAtStop(
        routeId: string,
        directionId: number | undefined,
        stopId: string,
        now: Date,
    ): number | null {
        const dirs = directionId !== undefined ? [directionId] : [0, 1];
        for (const dir of dirs) {
            const h = this.scheduledHeadwayAtStopForDirection(routeId, dir, stopId, now);
            if (h !== null) return h;
        }
        return null;
    }

    private scheduledHeadwayAtStopForDirection(
        routeId: string,
        directionId: number,
        stopId: string,
        now: Date,
    ): number | null {
        const dateStr = fmtDate(now);
        const nowSec = secondsSinceMidnight(now);
        const lo = nowSec - HEADWAY_WINDOW_HOURS * 3600;
        const hi = nowSec + HEADWAY_WINDOW_HOURS * 3600;

        const trips = this.repo
            .getTripsForRoute(routeId, directionId)
            .filter(t => this.repo.isServiceActiveToday(t.service_id, dateStr))
            .filter(t => t.start_time >= lo && t.start_time <= hi);

        const times: number[] = [];
        for (const t of trips) {
            const st = this.repo.getStopTimes(t.trip_id).find(s => s.stop_id === stopId);
            if (st) times.push(st.departure_time);
        }
        if (times.length < 2) return null;

        times.sort((a, b) => a - b);
        const diffs: number[] = [];
        for (let i = 1; i < times.length; i++) {
            const d = times[i] - times[i - 1];
            if (d > 0) diffs.push(d);
        }
        if (diffs.length === 0) return null;

        diffs.sort((a, b) => a - b);
        const mid = Math.floor(diffs.length / 2);
        const median = diffs.length % 2 === 0 ? (diffs[mid - 1] + diffs[mid]) / 2 : diffs[mid];
        return Math.max(30, Math.round(median));
    }

    private computeTargetHeadway(routeId: string, directionId: number | undefined, now: Date): number {
        const dirs = directionId !== undefined ? [directionId] : [0, 1];
        for (const dir of dirs) {
            const h = this.scheduledHeadwayForDirection(routeId, dir, now);
            if (h !== null) return h;
        }
        return DEFAULT_HEADWAY_S;
    }

    private scheduledHeadwayForDirection(routeId: string, directionId: number, now: Date): number | null {
        const dateStr = fmtDate(now);
        const nowSec = secondsSinceMidnight(now);
        const lo = nowSec - HEADWAY_WINDOW_HOURS * 3600;
        const hi = nowSec + HEADWAY_WINDOW_HOURS * 3600;

        const trips = this.repo
            .getTripsForRoute(routeId, directionId)
            .filter(t => this.repo.isServiceActiveToday(t.service_id, dateStr))
            .filter(t => t.start_time >= lo && t.start_time <= hi)
            .sort((a, b) => a.start_time - b.start_time);

        if (trips.length < 2) return null;
        const diffs: number[] = [];
        for (let i = 1; i < trips.length; i++) {
            const d = trips[i].start_time - trips[i - 1].start_time;
            if (d > 0) diffs.push(d);
        }
        if (diffs.length === 0) return null;
        diffs.sort((a, b) => a - b);
        const mid = Math.floor(diffs.length / 2);
        const median = diffs.length % 2 === 0 ? (diffs[mid - 1] + diffs[mid]) / 2 : diffs[mid];
        return Math.max(60, Math.round(median));
    }
}
