import { GTFSRepository } from '../gtfs/database.js';
import { parseGTFSTime } from '../gtfs/types.js';
import { haversineMeters } from '../gtfs/loader.js';
import { Detour, CreateDetourRequest } from './types.js';
import { DetourStore } from './store.js';
import crypto from 'crypto';

/**
 * Core detour logic:
 * - Identifies affected trips for a detour
 * - Computes modified stop sequences
 * - Calculates timing for replacement trips
 */

export interface ModifiedStopTime {
    stopId: string;
    stopName: string;
    stopSequence: number;
    arrivalTime: number;   // seconds since midnight
    departureTime: number;  // seconds since midnight
    lat: number;
    lon: number;
    isTemporary: boolean;
    isReplacement: boolean; // true if this is a replacement stop in the detour segment
}

export interface ModifiedTrip {
    tripId: string;
    routeId: string;
    directionId: number;
    serviceId: string;
    modifiedStopTimes: ModifiedStopTime[];
    detourId: string;
}

export class DetourEngine {
    // #8: pre-compiled statements — not rebuilt on every call
    private readonly stmtCalendarException: import('better-sqlite3').Statement;
    private readonly stmtCalendar: import('better-sqlite3').Statement;

    constructor(
        private repo: GTFSRepository,
        private store: DetourStore,
    ) {
        // Initialize here so `this.repo` is already assigned
        this.stmtCalendarException = this.repo.getDb().prepare(
            'SELECT exception_type FROM calendar_dates WHERE service_id = ? AND date = ?'
        );
        this.stmtCalendar = this.repo.getDb().prepare(
            'SELECT * FROM calendar WHERE service_id = ?'
        );
    }

    /**
     * Create and store a new detour.
     */
    createDetour(req: CreateDetourRequest): Detour {
        // Compute full path for visualization
        const path = this.computeFullDetourPath(req);

        const detour: Detour = {
            id: crypto.randomUUID(),
            ...req,
            path,
            createdAt: new Date().toISOString(),
        };
        this.store.add(detour);
        return detour;
    }

    /**
     * Remove a detour (end it immediately).
     */
    removeDetour(id: string): boolean {
        return this.store.remove(id);
    }

    /**
     * Get all affected trip IDs for a detour on a specific date.
     */
    getAffectedTripIds(detour: Detour, dateStr: string): string[] {
        let query = `
            SELECT t.trip_id, t.service_id 
            FROM trips t
        `;
        let where = `WHERE t.route_id = ? AND t.direction_id = ?`;
        const params: any[] = [detour.routeId, detour.directionId];

        if (detour.startStopId) {
            query += ` JOIN stop_times st1 ON t.trip_id = st1.trip_id `;
            where += ` AND st1.stop_id = ?`;
            params.push(detour.startStopId);
        }
        if (detour.endStopId) {
            query += ` JOIN stop_times st2 ON t.trip_id = st2.trip_id `;
            where += ` AND st2.stop_id = ?`;
            params.push(detour.endStopId);
        }

        if (detour.startStopId && detour.endStopId) {
            where += ` AND st1.stop_sequence < st2.stop_sequence`;
        }

        const stmt = this.repo.getDb().prepare(query + where);
        const trips = stmt.all(...params) as { trip_id: string, service_id: string }[];

        const validTripIds: string[] = [];
        const serviceCache = new Map<string, boolean>();

        for (const t of trips) {
            if (serviceCache.has(t.service_id)) {
                if (serviceCache.get(t.service_id)) validTripIds.push(t.trip_id);
                continue;
            }

            const isActive = this.checkServiceActive(t.service_id, dateStr);
            serviceCache.set(t.service_id, isActive);
            if (isActive) validTripIds.push(t.trip_id);
        }

        return validTripIds;
    }

    private checkServiceActive(serviceId: string, dateStr: string): boolean {
        // Check exception first
        const exception = this.stmtCalendarException.get(serviceId, dateStr) as { exception_type: number } | undefined;
        if (exception) {
            return exception.exception_type === 1;
        }

        // Check regular calendar
        const cal = this.stmtCalendar.get(serviceId) as any;
        if (!cal) return false;

        if (dateStr < cal.start_date || dateStr > cal.end_date) return false;

        const y = parseInt(dateStr.substring(0, 4));
        const m = parseInt(dateStr.substring(4, 6)) - 1;
        const d = parseInt(dateStr.substring(6, 8));
        const day = new Date(y, m, d).getDay();
        const cols = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        return cal[cols[day]] === 1;
    }

    /**
     * Compute the modified stop sequence for a trip under a detour.
     */
    computeModifiedTrip(tripId: string, detour: Detour): ModifiedTrip | null {
        const trip = this.repo.getTrip(tripId);
        if (!trip) return null;

        const originalStopTimes = this.repo.getStopTimes(tripId);
        if (!originalStopTimes || originalStopTimes.length === 0) return null;

        // Find indices of start and end stops in the original sequence
        const startIdx = detour.startStopId ? originalStopTimes.findIndex(st => st.stop_id === detour.startStopId) : -1;
        const endIdx = detour.endStopId ? originalStopTimes.findIndex(st => st.stop_id === detour.endStopId) : originalStopTimes.length;
        if ((detour.startStopId && startIdx === -1) || (detour.endStopId && endIdx === -1) || (startIdx !== -1 && endIdx !== originalStopTimes.length && startIdx >= endIdx)) return null;

        const modifiedStopTimes: ModifiedStopTime[] = [];
        let seq = 1;

        // Part 1: Original stops before & including the diverge point
        if (startIdx !== -1) {
            for (let i = 0; i <= startIdx; i++) {
                const st = originalStopTimes[i];
                const stop = this.repo.getStop(st.stop_id);
                modifiedStopTimes.push({
                    stopId: st.stop_id,
                    stopName: stop?.stop_name || st.stop_id,
                    stopSequence: seq++,
                    arrivalTime: st.arrival_time,
                    departureTime: st.departure_time,
                    lat: stop?.stop_lat || 0,
                    lon: stop?.stop_lon || 0,
                    isTemporary: false,
                    isReplacement: false,
                });
            }
        }

        // Part 2: Replacement stops along the detour
        let currentTime: number;
        if (startIdx !== -1) {
            currentTime = originalStopTimes[startIdx].departure_time;
        } else {
            currentTime = originalStopTimes[0].arrival_time;
        }

        for (const rs of detour.replacementStops) {
            currentTime += rs.travelTimeFromPrevious;
            modifiedStopTimes.push({
                stopId: rs.stopId,
                stopName: rs.stopName,
                stopSequence: seq++,
                arrivalTime: currentTime,
                departureTime: currentTime + 30, // 30-second dwell
                lat: rs.lat,
                lon: rs.lon,
                isTemporary: rs.isTemporary,
                isReplacement: true,
            });
            currentTime += 30; // dwell time
        }

        // Part 3: Original stops from rejoin point onward
        if (endIdx !== originalStopTimes.length) {
            const originalRejoinArrival = originalStopTimes[endIdx].arrival_time;
            const detourTimeShift = currentTime + (detour.replacementStops.length > 0
                ? 60  // 60s travel from last replacement stop to rejoin
                : 0) - originalRejoinArrival;

            for (let i = endIdx; i < originalStopTimes.length; i++) {
                const st = originalStopTimes[i];
                const stop = this.repo.getStop(st.stop_id);
                modifiedStopTimes.push({
                    stopId: st.stop_id,
                    stopName: stop?.stop_name || st.stop_id,
                    stopSequence: seq++,
                    arrivalTime: st.arrival_time + detourTimeShift,
                    departureTime: st.departure_time + detourTimeShift,
                    lat: stop?.stop_lat || 0,
                    lon: stop?.stop_lon || 0,
                    isTemporary: false,
                    isReplacement: false,
                });
            }
        }

        return {
            tripId,
            routeId: trip.route_id,
            directionId: trip.direction_id,
            serviceId: trip.service_id,
            modifiedStopTimes,
            detourId: detour.id,
        };
    }

    /**
     * Get all modified trips for currently active detours.
     */
    getAllModifiedTrips(now: Date = new Date()): Map<string, ModifiedTrip> {
        const dateStr = this.formatDateStr(now);
        const result = new Map<string, ModifiedTrip>();

        for (const detour of this.store.getActive(now)) {
            const affectedTripIds = this.getAffectedTripIds(detour, dateStr);

            for (const tripId of affectedTripIds) {
                const modified = this.computeModifiedTrip(tripId, detour);
                if (modified) {
                    result.set(tripId, modified);
                }
            }
        }

        return result;
    }

    private formatDateStr(date: Date): string {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}${m}${d}`;
    }

    /**
     * Compute a continuous [lat, lon][] path for the entire trip under detour.
     * originalShape[0..diverge] + detourCoords + originalShape[rejoin..end]
     */
    private findClosestShapeIndex(points: import('../gtfs/types.js').ShapePoint[], lat: number, lon: number): number {
        let minIdx = -1;
        let minDist = Infinity;
        for (let i = 0; i < points.length; i++) {
            const p = points[i];
            const dist = haversineMeters(lat, lon, p.shape_pt_lat, p.shape_pt_lon);
            if (dist < minDist) {
                minDist = dist;
                minIdx = i;
            }
        }
        return minIdx;
    }

    /**
     * Compute a continuous [lat, lon][] path for the entire trip under detour.
     * originalShape[0..diverge] + detourCoords + originalShape[rejoin..end]
     * Uses shape_dist_traveled for robust stitching, falling back to geometric matching if missing.
     */
    computeFullTripPath(detour: Detour | CreateDetourRequest): [number, number][] {
        const trip = this.repo.getTripsForRoute(detour.routeId, detour.directionId)[0];
        if (!trip || !trip.shape_id) return detour.detourShape;

        const originalPoints = this.repo.getShape(trip.shape_id);
        if (!originalPoints || originalPoints.length < 2) return detour.detourShape;

        // Get distance markers for diverge/rejoin stops from stop_times
        const stopTimes = this.repo.getStopTimes(trip.trip_id);

        let startDist: number | null = null;
        let startSt;
        if (detour.startStopId) {
            startSt = stopTimes.find(st => st.stop_id === detour.startStopId);
            if (!startSt) return detour.detourShape;
            startDist = startSt.shape_dist_traveled;
        }

        let endDist: number | null = null;
        let endSt;
        if (detour.endStopId) {
            endSt = stopTimes.find(st => st.stop_id === detour.endStopId);
            if (!endSt) return detour.detourShape;
            endDist = endSt.shape_dist_traveled;
        }

        const validStart = detour.startStopId ? startDist != null : true;
        const validEnd = detour.endStopId ? endDist != null : true;
        const validOrder = (startDist != null && endDist != null) ? endDist > startDist : true;
        const hasValidDist = validStart && validEnd && validOrder && (startDist != null || endDist != null);

        const fullPath: [number, number][] = [];

        if (hasValidDist && (startDist != null || endDist != null)) {
            // 1. Original up to diverge (points where dist <= startDist)
            if (detour.startStopId && startDist != null) {
                for (const pt of originalPoints) {
                    if (pt.shape_dist_traveled <= startDist) {
                        fullPath.push([pt.shape_pt_lat, pt.shape_pt_lon]);
                    }
                }
            }

            // 2. Detour segment (client-side polyline)
            fullPath.push(...detour.detourShape);

            // 3. Original from rejoin to end (points where dist >= endDist)
            if (detour.endStopId && endDist != null) {
                for (const pt of originalPoints) {
                    if (pt.shape_dist_traveled >= endDist) {
                        fullPath.push([pt.shape_pt_lat, pt.shape_pt_lon]);
                    }
                }
            }
        } else {
            // Fallback: geometric matching
            let startIdx = -1;
            if (detour.startStopId) {
                const startStop = this.repo.getStop(detour.startStopId);
                if (!startStop) return detour.detourShape;
                startIdx = this.findClosestShapeIndex(originalPoints, startStop.stop_lat, startStop.stop_lon);
            }

            let endIdx = originalPoints.length;
            if (detour.endStopId) {
                const endStop = this.repo.getStop(detour.endStopId);
                if (!endStop) return detour.detourShape;
                endIdx = this.findClosestShapeIndex(originalPoints, endStop.stop_lat, endStop.stop_lon);
            }

            if ((detour.startStopId && startIdx === -1) ||
                (detour.endStopId && endIdx === originalPoints.length) ||
                (startIdx !== -1 && endIdx !== originalPoints.length && startIdx >= endIdx)) {
                return detour.detourShape;
            }

            if (startIdx !== -1) {
                for (let i = 0; i <= startIdx; i++) {
                    fullPath.push([originalPoints[i].shape_pt_lat, originalPoints[i].shape_pt_lon]);
                }
            }

            fullPath.push(...detour.detourShape);

            if (endIdx !== originalPoints.length) {
                for (let i = endIdx; i < originalPoints.length; i++) {
                    fullPath.push([originalPoints[i].shape_pt_lat, originalPoints[i].shape_pt_lon]);
                }
            }
        }

        return fullPath;
    }

    computeFullDetourPath(req: CreateDetourRequest): [number, number][] {
        return this.computeFullTripPath(req);
    }
}
