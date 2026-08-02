// ─── Headway Service Types ───
// Models vehicle spacing along a route for the dispatcher time-space chart.

export type HeadwayStatus = 'UNKNOWN' | 'STALE' | 'NORMAL' | 'BUNCHED' | 'GAPPED';

/** A single predicted event on a vehicle's trajectory, aligned to a route stop. */
export interface HeadwayStopPoint {
    stopId: string;
    stopName: string;
    stopSequence: number;
    predictedArrival: number;   // epoch seconds
    predictedDeparture: number; // epoch seconds
    isRealtime: boolean;
}

export interface HeadwayVehicle {
    vehicleId: string;
    tripId: string;
    routeId: string;
    directionId: number;
    status: 'IN_TRANSIT' | 'AT_STOP' | 'COMPLETED';
    currentStopIndex: number;
    currentStopId: string | null;
    delaySeconds: number | null;
    lastUpdateTime: number; // epoch ms
    /** 0..1 progress along the vehicle's shape (approx across patterns). */
    progress: number;
    points: HeadwayStopPoint[];
    /** Seconds to the vehicle ahead (in front on the route). Positive = gap. */
    headwayAheadSeconds: number | null;
    /** Seconds to the vehicle behind (following). Positive = gap. */
    headwayBehindSeconds: number | null;
    targetHeadwaySeconds: number;
    headwayStatus: HeadwayStatus;
}

/** Y-axis reference stops shared across vehicles on a route/direction. */
export interface HeadwayControlPoint {
    stopId: string;
    stopName: string;
    stopSequence: number;
    /** Scheduled headway (median consecutive departures) at this stop, or null if unknown. */
    scheduledHeadwaySeconds: number | null;
}

export interface HeadwaysResponse {
    route: {
        routeId: string;
        routeShortName: string;
        routeLongName: string;
        routeColor: string;
    };
    directionId: number | null;
    timestamp: number; // epoch ms
    date: string;      // YYYYMMDD (local service day)
    targetHeadwaySeconds: number;
    vehicles: HeadwayVehicle[];
    controlPoints: HeadwayControlPoint[];
    warnings: string[];
}

/** A proposed service-restoration action for a dispatcher to review. */
export interface Recommendation {
    id: string;
    vehicleId: string;
    tripId: string;
    routeId: string;
    action: 'HOLD';
    controlPointStopId: string;
    controlPointStopName: string;
    holdSeconds: number;
    currentHeadwaySeconds: number;
    targetHeadwaySeconds: number;
    expectedHeadwaySeconds: number;
    reason: string;
    confidence: number;
    createdAt: number;  // epoch ms
    expiresAt: number;  // epoch ms
    status: 'PENDING';
}
