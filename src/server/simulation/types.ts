// ─── Vehicle Simulation Types ───

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
    status: 'IN_TRANSIT' | 'AT_STOP' | 'COMPLETED';

    // Timing
    tripStartTime: number;     // seconds since midnight when trip started
    lastUpdateTime: number;    // epoch ms
    dwellEndTime: number;      // epoch ms (when stopped at a stop, when to depart)
    isLost?: boolean;
    lostHeading?: number;
}

export interface InterpolatedShapePoint {
    lat: number;
    lon: number;
    distance: number;   // cumulative distance in meters from start
}
