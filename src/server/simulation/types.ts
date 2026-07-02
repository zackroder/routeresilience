// ─── Vehicle Simulation Types ───

import type { StopTime } from '../gtfs/types.js';

export interface VehicleState {
    vehicleId: string;
    tripId: string;
    routeId: string;
    directionId: number;

    // Position
    lat: number;
    lon: number;
    bearing: number;
    speed: number;            // m/s

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
    isLost?: boolean;
    lostHeading?: number;

    // Debug / Simulation Only
    baseSpeed?: number;
    speedFactor?: number;
    scheduleDeviation?: number;
}

export interface InterpolatedShapePoint {
    lat: number;
    lon: number;
    distance: number;   // cumulative distance in meters from start
}
