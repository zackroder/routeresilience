const API_BASE = '/api';

export interface RouteInfo {
    route_id: string;
    route_short_name: string;
    route_long_name: string;
    route_color: string;
    route_text_color: string;
    directions?: { [id: number]: string };
}

export interface StopInfo {
    stop_id: string;
    stop_name: string;
    stop_lat: number;
    stop_lon: number;
    stop_sequence?: number;
}

export interface ShapeData {
    shape_id: string;
    points: { lat: number; lon: number }[];
    patterns?: {
        shape_id: string;
        pointCount: number;
        totalDistance: number;
        tripCount: number;
        isDefault: boolean;
        firstStopName: string;
        lastStopName: string;
        stopIds: string[];
    }[];
}

export interface DetourData {
    id: string;
    routeId: string;
    directionId: number;
    startStopId: string;
    endStopId: string;
    startStopInfo?: StopInfo | null;
    endStopInfo?: StopInfo | null;
    replacementStops: {
        stopId: string;
        stopName: string;
        lat: number;
        lon: number;
        travelTimeFromPrevious: number;
    }[];
    detourShape: [number, number][];
    path?: [number, number][];
    startTime: string;
    endTime: string;
    description: string;
    skippedStops?: { stopId: string; stopName: string }[];
    createdAt: string;
}

export interface VehicleData {
    vehicleId: string;
    tripId: string;
    routeId: string;
    directionId: number;
    lat: number;
    lon: number;
    bearing: number;
    speed: number;
    status: string;
    nextStopId: string;
}

export interface SystemStatus {
    routes: number;
    trips: number;
    stops: number;
    activeVehicles: number;
    activeDetours: number;
    totalDetours: number;
}

async function fetchJson<T>(path: string): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
        headers: {
            'X-API-Key': 'dev-key'
        }
    });
    if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
    return res.json();
}

export const api = {
    getRoutes: () => fetchJson<RouteInfo[]>('/routes'),
    getRouteShape: (routeId: string, direction: number) =>
        fetchJson<ShapeData>(`/routes/${routeId}/shape?direction=${direction}`),
    getRouteStops: (routeId: string, direction: number) =>
        fetchJson<StopInfo[]>(`/routes/${routeId}/stops?direction=${direction}`),
    getNearbyStops: (lat: number, lng: number, radius = 500) =>
        fetchJson<StopInfo[]>(`/stops/nearby?lat=${lat}&lng=${lng}&radius=${radius}`),
    getStopsInBounds: (minLat: number, minLon: number, maxLat: number, maxLon: number) =>
        fetchJson<StopInfo[]>(`/stops/bounds?minLat=${minLat}&minLon=${minLon}&maxLat=${maxLat}&maxLon=${maxLon}`),
    getDetours: () => fetchJson<DetourData[]>('/detours'),
    createDetour: async (data: any): Promise<DetourData> => {
        const res = await fetch(`${API_BASE}/detours`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': 'dev-key' },
            body: JSON.stringify(data),
        });
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        return res.json();
    },
    deleteDetour: async (id: string): Promise<void> => {
        const res = await fetch(`${API_BASE}/detours/${id}`, { 
            method: 'DELETE',
            headers: { 'X-API-Key': 'dev-key' }
        });
        if (!res.ok) throw new Error(`API error: ${res.status}`);
    },
    getVehicles: () => fetchJson<{ count: number; vehicles: VehicleData[] }>('/vehicles'),
    getStatus: () => fetchJson<SystemStatus>('/status'),
    getHeadways: (routeId: string, direction?: number) =>
        fetchJson<HeadwayData>(`/headways?route_id=${encodeURIComponent(routeId)}${direction !== undefined ? `&direction=${direction}` : ''}`),
    getRecommendations: (routeId: string, direction?: number) =>
        fetchJson<{ timestamp: number; recommendations: Recommendation[] }>(`/headways/recommendations?route_id=${encodeURIComponent(routeId)}${direction !== undefined ? `&direction=${direction}` : ''}`),
    acceptRecommendation: async (rec: Recommendation): Promise<OperatorInstruction> => {
        const res = await fetch(`${API_BASE}/recommendations/accept`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': 'dev-key' },
            body: JSON.stringify(rec),
        });
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        return res.json();
    },
    getInstructions: (activeOnly = true) => fetchJson<OperatorInstruction[]>(`/instructions?active=${activeOnly}`),
    createInstruction: async (data: {
        vehicleId: string; tripId?: string; routeId?: string; action: 'HOLD';
        controlPointStopId: string; controlPointStopName?: string; holdSeconds?: number; message?: string;
    }): Promise<OperatorInstruction> => {
        const res = await fetch(`${API_BASE}/instructions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': 'dev-key' },
            body: JSON.stringify(data),
        });
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        return res.json();
    },
    acknowledgeInstruction: async (id: string): Promise<OperatorInstruction> => {
        const res = await fetch(`${API_BASE}/instructions/${id}/acknowledge`, {
            method: 'POST', headers: { 'X-API-Key': 'dev-key' }
        });
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        return res.json();
    },
    completeInstruction: async (id: string): Promise<OperatorInstruction> => {
        const res = await fetch(`${API_BASE}/instructions/${id}/complete`, {
            method: 'POST', headers: { 'X-API-Key': 'dev-key' }
        });
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        return res.json();
    },
    cancelInstruction: async (id: string): Promise<OperatorInstruction> => {
        const res = await fetch(`${API_BASE}/instructions/${id}/cancel`, {
            method: 'POST', headers: { 'X-API-Key': 'dev-key' }
        });
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        return res.json();
    },

    // Block / Cancellation API
    getBlocks: (dateStr?: string) => fetchJson<BlockData[]>('/blocks' + (dateStr ? `?date=${dateStr}` : '')),
    getCancellations: () => fetchJson<CancelledTripData[]>('/cancellations'),
    cancelTrip: async (tripId: string, start_date: string, end_date: string) => {
        const res = await fetch(`${API_BASE}/trips/${tripId}/cancel`, { 
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': 'dev-key' },
            body: JSON.stringify({ start_date, end_date })
        });
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        return res.json();
    },
    restoreTrip: async (tripId: string, date: string) => {
        const res = await fetch(`${API_BASE}/trips/${tripId}/restore`, { 
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': 'dev-key' },
            body: JSON.stringify({ date })
        });
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        return res.json();
    },
    cancelTripsBulk: async (payloads: {tripId: string, startDate: string, endDate: string}[]) => {
        const res = await fetch(`${API_BASE}/trips/cancel-bulk`, { 
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': 'dev-key' },
            body: JSON.stringify({ payloads })
        });
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        return res.json();
    },
    restoreTripsBulk: async (keys: string[]) => {
        const res = await fetch(`${API_BASE}/trips/restore-bulk`, { 
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': 'dev-key' },
            body: JSON.stringify({ keys })
        });
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        return res.json();
    },
};

export interface BlockData {
    block_id: string;
    trips: BlockTrip[];
}

export interface BlockTrip {
    trip_id: string;
    route_id: string;
    direction_id: number;
    start_time: number;
    end_time: number;
    trip_headsign: string;
    is_cancelled: boolean;
    start_stop_name: string;
    end_stop_name: string;
    is_detoured?: boolean; // Added for UI highlight
}

export interface CancelledTripData {
    trip_id: string;
    route_id: string;
    route_short_name?: string;
    direction_id: number;
    trip_headsign: string;
    start_time: string | number;
    end_time: string | number;
}

export type HeadwayStatus = 'UNKNOWN' | 'STALE' | 'NORMAL' | 'BUNCHED' | 'GAPPED';

export interface HeadwayStopPoint {
    stopId: string;
    stopName: string;
    stopSequence: number;
    predictedArrival: number;
    predictedDeparture: number;
    isRealtime: boolean;
}

export interface HeadwayVehicle {
    vehicleId: string;
    tripId: string;
    routeId: string;
    directionId: number;
    status: string;
    currentStopIndex: number;
    currentStopId: string | null;
    delaySeconds: number | null;
    lastUpdateTime: number;
    progress: number;
    points: HeadwayStopPoint[];
    headwayAheadSeconds: number | null;
    headwayBehindSeconds: number | null;
    targetHeadwaySeconds: number;
    headwayStatus: HeadwayStatus;
    axisPosition: number;
    leaderVehicleId: string | null;
    followerVehicleId: string | null;
}

export interface RouteBranch {
    divergeStopId: string;
    divergeStopName: string;
    stops: HeadwayControlPoint[];
    rejoinStopId: string | null;
}

export interface RouteTopology {
    trunk: HeadwayControlPoint[];
    branches: RouteBranch[];
}

export interface HeadwayControlPoint {
    stopId: string;
    stopName: string;
    stopSequence: number;
    scheduledHeadwaySeconds: number | null;
}

export interface HeadwayData {
    route: { routeId: string; routeShortName: string; routeLongName: string; routeColor: string };
    directionId: number | null;
    timestamp: number;
    date: string;
    targetHeadwaySeconds: number;
    vehicles: HeadwayVehicle[];
    controlPoints: HeadwayControlPoint[];
    topology: RouteTopology;
    warnings: string[];
}

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
    createdAt: number;
    expiresAt: number;
    status: 'PENDING';
}

export type InstructionAction = 'HOLD';
export type InstructionStatus = 'SENT' | 'ACKNOWLEDGED' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED';

export interface OperatorInstruction {
    id: string;
    vehicleId: string;
    tripId: string;
    routeId: string;
    action: InstructionAction;
    controlPointStopId: string;
    controlPointStopName: string;
    holdSeconds: number;
    message: string;
    status: InstructionStatus;
    source: 'dispatcher' | 'recommendation';
    createdAt: number;
    acknowledgedAt: number | null;
    completedAt: number | null;
    cancelledAt: number | null;
    expiresAt: number;
}
