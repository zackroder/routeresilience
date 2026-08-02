import { GTFSRepository } from '../gtfs/database.js';
import { VehicleDataSource } from '../realtime/vehicle-data-source.js';
import { PredictionEngine } from '../realtime/predictions.js';
import {
    HeadwayControlPoint,
    HeadwayStatus,
    HeadwayVehicle,
    HeadwaysResponse,
} from './types.js';

const STALE_THRESHOLD_MS = 120_000;
const DEFAULT_HEADWAY_S = 600;
const HEADWAY_WINDOW_HOURS = 3;
const MAX_CONTROL_POINTS = 80;
const TARGET_LOW_FACTOR = 0.6;
const TARGET_HIGH_FACTOR = 1.4;

function fmtDate(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
}

function secondsSinceMidnight(d: Date): number {
    return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
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
            });
        }

        // Order vehicles by progress along route, front of route first.
        // Progress is per-shape, so vehicles on different patterns are approximate.
        const ordered = vehicleModels.sort((a, b) => b.progress - a.progress);

        const targetHeadway = this.computeTargetHeadway(routeId, directionId, now);
        const nowMs = now.getTime();

        for (let i = 0; i < ordered.length; i++) {
            const v = ordered[i];
            v.targetHeadwaySeconds = targetHeadway;
            const ahead = ordered[i - 1];
            const behind = ordered[i + 1];
            v.headwayAheadSeconds = ahead ? this.computeHeadwayBetween(ahead, v) : null;
            v.headwayBehindSeconds = behind ? this.computeHeadwayBetween(v, behind) : null;
            v.headwayStatus = this.classifyStatus(v, nowMs);
        }

        const controlPoints = this.buildControlPoints(ordered);

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
            .map(([stopId, info]) => ({ stopId, stopName: info.stopName, stopSequence: info.minSeq }))
            .sort((a, b) => a.stopSequence - b.stopSequence)
            .slice(0, MAX_CONTROL_POINTS);
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
