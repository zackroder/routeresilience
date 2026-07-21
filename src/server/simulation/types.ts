// ─── Vehicle Simulation Types ───

import type { StopTime } from '../gtfs/types.js';

export interface VehicleState {
    vehicleId: string;
    tripId: string;
    routeId: string;
    directionId: number;
    shapeId: string;

    // Position
    lat: number;
    lon: number;
    bearing: number;
    speed: number;            // m/s — current speed for current segment

    // Progress along route
    shapeIndex: number;        // current index into interpolated shape points
    distanceTraveled: number;  // meters along shape
    totalDistance: number;      // total shape length in meters

    // Schedule progress
    currentStopIndex: number;  // index into the trip's stop time array
    nextStopId: string;
    cachedStopTimes: StopTime[]; // cached at spawn, never changes
    status: 'IN_TRANSIT' | 'AT_STOP' | 'COMPLETED';

    // Timing
    tripStartTime: number;     // seconds since midnight when trip started
    lastUpdateTime: number;    // epoch ms
    dwellEndTime: number;      // epoch ms (when stopped at a stop, when to depart)

    // Schedule adherence
    delaySeconds: number;      // measured delay: positive = late, negative = early
    lastPredictedArrivalTime?: number; // epoch seconds, for the next stop

    // Per-segment speed model
    segmentSpeeds: number[];      // speed (m/s) for each stop-to-stop segment
    segmentDistances: number[];   // cumulative distance (meters) to each stop along shape

    // Detour tracking
    activeDetourId?: string;       // currently applied detour ID
    usingDetourShape?: boolean;    // whether this vehicle switched to detour shape

    // Real-time status
    occupancyStatus?: number;      // GTFS-RT OccupancyStatus enum
    congestionLevel?: number;      // GTFS-RT CongestionLevel enum

    // Debug / Simulation Only
    baseSpeed?: number;
    speedFactor?: number;
}

export interface InterpolatedShapePoint {
    lat: number;
    lon: number;
    distance: number;   // cumulative distance in meters from start
}
