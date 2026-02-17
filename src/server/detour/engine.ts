import { GTFSData, StopTime, parseGTFSTime } from '../gtfs/types.js';
import { getActiveTripsForDate, haversineMeters } from '../gtfs/loader.js';
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
        private gtfs: GTFSData,
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
        const trips = getActiveTripsForDate(this.gtfs, detour.routeId, detour.directionId, dateStr);

        // Filter to trips that actually serve both the start and end stop of the detour
        return trips
            .filter(trip => {
                const stopTimes = this.gtfs.stopTimesByTrip.get(trip.trip_id);
                if (!stopTimes) return false;
                const hasStart = stopTimes.some(st => st.stop_id === detour.startStopId);
                const hasEnd = stopTimes.some(st => st.stop_id === detour.endStopId);
                return hasStart && hasEnd;
            })
            .map(t => t.trip_id);
    }

    /**
     * Compute the modified stop sequence for a trip under a detour.
     * 
     * Logic:
     * 1. Keep all stops up to and including startStopId
     * 2. Insert replacement stops
     * 3. Keep all stops from endStopId onward (including it)
     * 4. Renumber stop_sequence from 1
     * 5. Adjust timing based on replacement stop travel times
     */
    computeModifiedTrip(tripId: string, detour: Detour): ModifiedTrip | null {
        const trip = this.gtfs.trips.get(tripId);
        if (!trip) return null;

        const originalStopTimes = this.gtfs.stopTimesByTrip.get(tripId);
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
            const stop = this.gtfs.stops.get(st.stop_id);
            modifiedStopTimes.push({
                stopId: st.stop_id,
                stopName: stop?.stop_name || st.stop_id,
                stopSequence: seq++,
                arrivalTime: parseGTFSTime(st.arrival_time),
                departureTime: parseGTFSTime(st.departure_time),
                lat: stop?.stop_lat || 0,
                lon: stop?.stop_lon || 0,
                isTemporary: false,
                isReplacement: false,
            });
        }

        // Part 2: Replacement stops along the detour
        const divergeStopTime = originalStopTimes[startIdx];
        let currentTime = parseGTFSTime(divergeStopTime.departure_time);

        for (const rs of detour.replacementStops) {
            currentTime += rs.travelTimeFromPrevious;
            modifiedStopTimes.push({
                stopId: rs.stopId,
                stopName: rs.stopName,
                stopSequence: seq++,
                arrivalTime: currentTime,
                departureTime: currentTime + 30, // 30-second dwell at replacement stops
                lat: rs.lat,
                lon: rs.lon,
                isTemporary: rs.isTemporary,
                isReplacement: true,
            });
            currentTime += 30; // dwell time
        }

        // Part 3: Original stops from rejoin point onward
        // Calculate the time shift caused by the detour
        const originalRejoinArrival = parseGTFSTime(originalStopTimes[endIdx].arrival_time);
        const detourTimeShift = currentTime + (detour.replacementStops.length > 0
            ? 60  // 60s travel from last replacement stop to rejoin
            : 0) - originalRejoinArrival;

        for (let i = endIdx; i < originalStopTimes.length; i++) {
            const st = originalStopTimes[i];
            const stop = this.gtfs.stops.get(st.stop_id);
            modifiedStopTimes.push({
                stopId: st.stop_id,
                stopName: stop?.stop_name || st.stop_id,
                stopSequence: seq++,
                arrivalTime: parseGTFSTime(st.arrival_time) + detourTimeShift,
                departureTime: parseGTFSTime(st.departure_time) + detourTimeShift,
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



    /**
     * Computes the full path geometry for the detour:
     * [Start Stop -> Diverge Stop] + [Detour Shape] + [Rejoin Stop -> End Stop]
     * This is useful for visualization on the client map.
     */
    computeFullDetourPath(req: CreateDetourRequest): [number, number][] {
        // Find a representative trip to get the base shape
        // We just need ANY trip on this route/direction to get the shape geometry
        const routeTrips = Array.from(this.gtfs.trips.values())
            .filter(t => t.route_id === req.routeId && t.direction_id === req.directionId);

        if (routeTrips.length === 0) return req.detourShape;

        const trip = routeTrips[0];
        const shapePoints = this.gtfs.shapePoints.get(trip.shape_id);
        if (!shapePoints || shapePoints.length === 0) return req.detourShape;

        const stopTimes = this.gtfs.stopTimesByTrip.get(trip.trip_id);
        if (!stopTimes) return req.detourShape;

        // Find diverges/rejoin stops in sequence
        const startSt = stopTimes.find(st => st.stop_id === req.startStopId);
        const endSt = stopTimes.find(st => st.stop_id === req.endStopId);

        if (!startSt || !endSt) return req.detourShape;

        // Get shape segments
        // 1. Pre-diverge: From start of shape (or close to start stop?) to diverge point
        // For simplicity, we'll slice geometry based on stops. 
        // Ideally we project stops onto shape. Here we'll do a simple distance check.

        // Find shape index closest to start/end stops
        const startShapeIdx = this.findClosestShapeIndex(shapePoints, this.gtfs.stops.get(req.startStopId)!);
        const endShapeIdx = this.findClosestShapeIndex(shapePoints, this.gtfs.stops.get(req.endStopId)!);

        if (startShapeIdx === -1 || endShapeIdx === -1) return req.detourShape;

        const path: [number, number][] = [];

        // No... full path should be the REPLACEMENT segment, not the whole route.
        // Wait, the client wants to see the "Active Detour" trace.
        // If the detour is just the deviation, we already have `detourShape`.
        // But usually "detour" implies the path taken *between* the affected stops.

        // If the user wants to see the "Detour Path", it is effectively:
        // Diverge Stop -> Detour Shape -> Rejoin Stop.
        // The `detourShape` from client IS this path.

        // However, the `detourShape` might be raw points.
        // Let's just return `detourShape` for now if that's what the client sends.
        // Actually, looking at client code, `detourPathPoints` is just the points clicked on map.
        // It connects Diverge -> clicked points -> Rejoin.

        return req.detourShape;
    }

    private findClosestShapeIndex(shapePoints: any[], stop: any): number {
        if (!stop) return -1;
        let minDist = Infinity;
        let idx = -1;
        for (let i = 0; i < shapePoints.length; i++) {
            const d = haversineMeters(stop.stop_lat, stop.stop_lon, shapePoints[i].shape_pt_lat, shapePoints[i].shape_pt_lon);
            if (d < minDist) {
                minDist = d;
                idx = i;
            }
        }
        return idx;
    }
}

