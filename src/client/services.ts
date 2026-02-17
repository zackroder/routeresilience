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
        isTemporary: boolean;
        travelTimeFromPrevious: number;
    }[];
    detourShape: [number, number][];
    startTime: string;
    endTime: string;
    description: string;
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
    const res = await fetch(`${API_BASE}${path}`);
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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        return res.json();
    },
    deleteDetour: async (id: string): Promise<void> => {
        const res = await fetch(`${API_BASE}/detours/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`API error: ${res.status}`);
    },
    getVehicles: () => fetchJson<{ count: number; vehicles: VehicleData[] }>('/vehicles'),
    getStatus: () => fetchJson<SystemStatus>('/status'),
};
