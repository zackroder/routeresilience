// ─── Detour Data Model ───

export interface ReplacementStopDef {
    /** Existing stop_id from GTFS, or a generated temp stop_id (prefixed "temp_") */
    stopId: string;
    stopName: string;
    lat: number;
    lon: number;
    /** Whether this is a newly created temporary stop (not in GTFS static) */
    isTemporary: boolean;
    /** Estimated travel time in seconds from previous stop (or from diverge point for first) */
    travelTimeFromPrevious: number;
}

export interface Detour {
    id: string;
    routeId: string;
    directionId: number;

    /** Stop ID where the detour diverges from the normal route */
    startStopId: string;
    /** Stop ID where the detour rejoins the normal route */
    endStopId: string;

    /** Ordered replacement stops along the detour path */
    replacementStops: ReplacementStopDef[];

    /** Polyline of the detour geometry [lat, lng][] */
    detourShape: [number, number][];

    /** When the detour begins (ISO 8601) */
    startTime: string;
    /** When the detour ends (ISO 8601) */
    endTime: string;

    /** Human-readable description for ServiceAlerts */
    description: string;

    createdAt: string;
}

/** API payload for creating a detour */
export interface CreateDetourRequest {
    routeId: string;
    directionId: number;
    startStopId: string;
    endStopId: string;
    replacementStops: ReplacementStopDef[];
    detourShape: [number, number][];
    startTime: string;
    endTime: string;
    description: string;
}
