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
    constructor(
        private repo: GTFSRepository,
        private store: DetourStore,
    ) { }

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
        // Query trips that have both start and end stops in the correct order
        const stmt = this.repo.getDb().prepare(`
            SELECT t.trip_id, t.service_id 
            FROM trips t
            JOIN stop_times st1 ON t.trip_id = st1.trip_id
            JOIN stop_times st2 ON t.trip_id = st2.trip_id
            WHERE t.route_id = ? AND t.direction_id = ?
            AND st1.stop_id = ? AND st2.stop_id = ?
            AND st1.stop_sequence < st2.stop_sequence
        `);

        const trips = stmt.all(detour.routeId, detour.directionId, detour.startStopId, detour.endStopId) as { trip_id: string, service_id: string }[];

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
        // Check exception
        const exception = this.repo.getDb().prepare('SELECT exception_type FROM calendar_dates WHERE service_id = ? AND date = ?').get(serviceId, dateStr) as { exception_type: number } | undefined;
        if (exception) {
            return exception.exception_type === 1;
        }

        // Check calendar
        const cal = this.repo.getDb().prepare('SELECT * FROM calendar WHERE service_id = ?').get(serviceId) as any;
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
        const startIdx = originalStopTimes.findIndex(st => st.stop_id === detour.startStopId);
        const endIdx = originalStopTimes.findIndex(st => st.stop_id === detour.endStopId);
        if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) return null;

        const modifiedStopTimes: ModifiedStopTime[] = [];
        let seq = 1;

        // Part 1: Original stops before & including the diverge point
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

        // Part 2: Replacement stops along the detour
        const divergeStopTime = originalStopTimes[startIdx];
        let currentTime = divergeStopTime.departure_time;

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

    computeFullDetourPath(req: CreateDetourRequest): [number, number][] {
        return req.detourShape;
    }
}
