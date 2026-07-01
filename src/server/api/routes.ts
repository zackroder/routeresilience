import { Router, Request, Response } from 'express';
import { GTFSData } from '../gtfs/types.js';
import { findNearbyStops, findStopsInBounds } from '../gtfs/loader.js';
import { DetourEngine } from '../detour/engine.js';
import { DetourStore } from '../detour/store.js';
import { CreateDetourRequest } from '../detour/types.js';
import { SimulationEngine } from '../simulation/engine.js';
import { FeedGenerator } from '../realtime/feed.js';

export function createApiRouter(
    gtfs: GTFSData,
    detourEngine: DetourEngine,
    detourStore: DetourStore,
    simulation: SimulationEngine,
    feedGenerator: FeedGenerator,
): Router {
    const router = Router();

    // ─── GTFS Data Routes ───

    /** List all bus routes */
    router.get('/routes', (_req: Request, res: Response) => {
        const routes = Array.from(gtfs.routes.values()).map(r => ({
            route_id: r.route_id,
            route_short_name: r.route_short_name,
            route_long_name: r.route_long_name,
            route_color: r.route_color,
            route_text_color: r.route_text_color,
            directions: r.directions,
        }));
        routes.sort((a, b) => {
            const aNum = parseInt(a.route_short_name);
            const bNum = parseInt(b.route_short_name);
            if (!isNaN(aNum) && !isNaN(bNum)) return aNum - bNum;
            return a.route_short_name.localeCompare(b.route_short_name);
        });
        res.json(routes);
    });

    /** Get trips for a route + direction */
    router.get('/routes/:id/trips', (req: Request, res: Response) => {
        const routeId = req.params.id;
        const directionId = parseInt(req.query.direction as string) || 0;
        const key = `${routeId}_${directionId}`;
        const tripIds = gtfs.tripsByRoute.get(key) || [];
        const trips = tripIds.slice(0, 50).map(id => { // Limit to 50 for UI
            const trip = gtfs.trips.get(id)!;
            const stopTimes = gtfs.stopTimesByTrip.get(id) || [];
            return {
                trip_id: trip.trip_id,
                trip_headsign: trip.trip_headsign,
                direction_id: trip.direction_id,
                service_id: trip.service_id,
                stop_count: stopTimes.length,
                first_departure: stopTimes[0]?.departure_time || '',
                last_arrival: stopTimes[stopTimes.length - 1]?.arrival_time || '',
            };
        });
        res.json(trips);
    });

    /** Get all unique shape patterns for a route + direction (longest first) */
    router.get('/routes/:id/shape', (req: Request, res: Response) => {
        const routeId = req.params.id;
        const directionId = parseInt(req.query.direction as string) || 0;
        const key = `${routeId}_${directionId}`;
        const tripIds = gtfs.tripsByRoute.get(key) || [];

        // Collect all unique shapes for this route+direction
        const shapesMap = new Map<string, {
            shape_id: string;
            points: { lat: number; lon: number }[];
            totalDistance: number;
            tripCount: number;
            representativeTripId: string;
        }>();
        for (const tripId of tripIds) {
            const trip = gtfs.trips.get(tripId);
            if (!trip || !trip.shape_id) continue;
            if (shapesMap.has(trip.shape_id)) {
                shapesMap.get(trip.shape_id)!.tripCount++;
                continue;
            }
            const rawPoints = gtfs.shapePoints.get(trip.shape_id);
            if (!rawPoints || rawPoints.length < 2) continue;

            const points = rawPoints.map(p => ({ lat: p.shape_pt_lat, lon: p.shape_pt_lon }));
            // Calculate total distance for sorting
            let totalDistance = 0;
            for (let i = 1; i < rawPoints.length; i++) {
                const a = rawPoints[i - 1], b = rawPoints[i];
                const dx = (b.shape_pt_lat - a.shape_pt_lat) * 111320;
                const dy = (b.shape_pt_lon - a.shape_pt_lon) * 111320 * Math.cos(a.shape_pt_lat * Math.PI / 180);
                totalDistance += Math.sqrt(dx * dx + dy * dy);
            }
            shapesMap.set(trip.shape_id, {
                shape_id: trip.shape_id, points, totalDistance, tripCount: 1,
                representativeTripId: tripId,
            });
        }

        // Sort by total distance descending (longest pattern first)
        const patterns = Array.from(shapesMap.values())
            .sort((a, b) => b.totalDistance - a.totalDistance);

        if (patterns.length > 0) {
            // Build enriched pattern info with first/last stop names and stop IDs
            const enrichedPatterns = patterns.map((p, i) => {
                const stopTimes = gtfs.stopTimesByTrip.get(p.representativeTripId) || [];
                const stopIds = stopTimes.map(st => st.stop_id);
                const firstStop = stopTimes.length > 0 ? gtfs.stops.get(stopTimes[0].stop_id) : null;
                const lastStop = stopTimes.length > 0 ? gtfs.stops.get(stopTimes[stopTimes.length - 1].stop_id) : null;
                return {
                    shape_id: p.shape_id,
                    pointCount: p.points.length,
                    totalDistance: Math.round(p.totalDistance),
                    tripCount: p.tripCount,
                    isDefault: i === 0,
                    firstStopName: firstStop?.stop_name || 'Unknown',
                    lastStopName: lastStop?.stop_name || 'Unknown',
                    stopIds,
                };
            });

            res.json({
                shape_id: patterns[0].shape_id,
                points: patterns[0].points,
                patterns: enrichedPatterns,
            });
        } else {
            res.json({ shape_id: null, points: [], patterns: [] });
        }
    });

    /** Get stops for a route + direction — union of all patterns, ordered by longest trip */
    router.get('/routes/:id/stops', (req: Request, res: Response) => {
        const routeId = req.params.id;
        const directionId = parseInt(req.query.direction as string) || 0;
        const key = `${routeId}_${directionId}`;
        const tripIds = gtfs.tripsByRoute.get(key) || [];

        // Find the longest trip (most stops) as the primary sequence
        let longestStopTimes: typeof stopTimesRef | null = null;
        let longestLen = 0;
        let stopTimesRef: ReturnType<typeof gtfs.stopTimesByTrip.get> = undefined;
        for (const tripId of tripIds) {
            const st = gtfs.stopTimesByTrip.get(tripId);
            if (st && st.length > longestLen) {
                longestLen = st.length;
                longestStopTimes = st;
            }
        }

        if (!longestStopTimes) {
            res.json([]);
            return;
        }

        const stops = longestStopTimes.map(st => {
            const stop = gtfs.stops.get(st.stop_id);
            return {
                stop_id: st.stop_id,
                stop_name: stop?.stop_name || st.stop_id,
                stop_lat: stop?.stop_lat || 0,
                stop_lon: stop?.stop_lon || 0,
                stop_sequence: st.stop_sequence,
            };
        });

        res.json(stops);
    });

    /** Find nearby stops */
    router.get('/stops/nearby', (req: Request, res: Response) => {
        const lat = parseFloat(req.query.lat as string);
        const lon = parseFloat(req.query.lng as string);
        const radius = parseFloat(req.query.radius as string) || 500;

        if (isNaN(lat) || isNaN(lon)) {
            res.status(400).json({ error: 'lat and lng are required' });
            return;
        }

        const stops = findNearbyStops(gtfs, lat, lon, radius);
        res.json(stops.map(s => ({
            stop_id: s.stop_id,
            stop_name: s.stop_name,
            stop_lat: s.stop_lat,
            stop_lon: s.stop_lon,
        })));
    });

    /** Find stops in bounds */
    router.get('/stops/bounds', (req: Request, res: Response) => {
        const minLat = parseFloat(req.query.minLat as string);
        const minLon = parseFloat(req.query.minLon as string);
        const maxLat = parseFloat(req.query.maxLat as string);
        const maxLon = parseFloat(req.query.maxLon as string);

        if (isNaN(minLat) || isNaN(minLon) || isNaN(maxLat) || isNaN(maxLon)) {
            res.status(400).json({ error: 'minLat, minLon, maxLat, maxLon are required' });
            return;
        }

        const stops = findStopsInBounds(gtfs, minLat, minLon, maxLat, maxLon);
        res.json(stops.map(s => ({
            stop_id: s.stop_id,
            stop_name: s.stop_name,
            stop_lat: s.stop_lat,
            stop_lon: s.stop_lon,
        })));
    });

    /** Get a stop by ID */
    router.get('/stops/:id', (req: Request, res: Response) => {
        const stop = gtfs.stops.get(req.params.id);
        if (!stop) {
            res.status(404).json({ error: 'Stop not found' });
            return;
        }
        res.json({
            stop_id: stop.stop_id,
            stop_name: stop.stop_name,
            stop_lat: stop.stop_lat,
            stop_lon: stop.stop_lon,
        });
    });

    // ─── Detour Routes ───

    /** Create a new detour */
    router.post('/detours', (req: Request, res: Response) => {
        try {
            const body = req.body as CreateDetourRequest;
            if (!body.routeId || !body.startStopId || !body.endStopId || !body.startTime || !body.endTime) {
                res.status(400).json({ error: 'Missing required fields: routeId, startStopId, endStopId, startTime, endTime' });
                return;
            }
            const detour = detourEngine.createDetour(body);
            res.status(201).json(detour);
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    /** List all detours (enriched with stop location data) */
    router.get('/detours', (_req: Request, res: Response) => {
        const detours = detourStore.getAll().map(d => {
            const startStop = gtfs.stops.get(d.startStopId);
            const endStop = gtfs.stops.get(d.endStopId);
            return {
                ...d,
                startStopInfo: startStop ? {
                    stop_id: startStop.stop_id,
                    stop_name: startStop.stop_name,
                    stop_lat: startStop.stop_lat,
                    stop_lon: startStop.stop_lon,
                } : null,
                endStopInfo: endStop ? {
                    stop_id: endStop.stop_id,
                    stop_name: endStop.stop_name,
                    stop_lat: endStop.stop_lat,
                    stop_lon: endStop.stop_lon,
                } : null,
            };
        });
        res.json(detours);
    });

    /** Get a specific detour */
    router.get('/detours/:id', (req: Request, res: Response) => {
        const detour = detourStore.get(req.params.id);
        if (!detour) {
            res.status(404).json({ error: 'Detour not found' });
            return;
        }
        res.json(detour);
    });

    /** Delete (end) a detour */
    router.delete('/detours/:id', (req: Request, res: Response) => {
        const removed = detourEngine.removeDetour(req.params.id);
        if (!removed) {
            res.status(404).json({ error: 'Detour not found' });
            return;
        }
        res.json({ success: true });
    });

    // ─── GTFS-RT Feed ───

    /** Binary protobuf GTFS-RT feed */
    router.get('/gtfs-rt', async (_req: Request, res: Response) => {
        try {
            const buffer = await feedGenerator.generateFeed();
            res.set('Content-Type', 'application/x-protobuf');
            res.send(buffer);
        } catch (err: any) {
            console.error('Error generating GTFS-RT feed:', err);
            res.status(500).json({ error: err.message });
        }
    });

    /** JSON debug view of GTFS-RT feed */
    router.get('/gtfs-rt/json', async (_req: Request, res: Response) => {
        try {
            const json = await feedGenerator.generateFeedJson();
            res.json(json);
        } catch (err: any) {
            console.error('Error generating GTFS-RT feed:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // ─── Vehicle Simulation ───

    /** Current simulated vehicle positions */
    router.get('/vehicles', (_req: Request, res: Response) => {
        const vehicles = simulation.getVehicles();
        res.json({
            count: vehicles.length,
            vehicles: vehicles.slice(0, 500).map(v => ({ // Limit response size
                vehicleId: v.vehicleId,
                tripId: v.tripId,
                routeId: v.routeId,
                directionId: v.directionId,
                lat: v.lat,
                lon: v.lon,
                bearing: v.bearing,
                speed: v.speed,
                status: v.status,
                nextStopId: v.nextStopId,
            })),
        });
    });

    /** System status */
    router.get('/status', (_req: Request, res: Response) => {
        res.json({
            routes: gtfs.routes.size,
            trips: gtfs.trips.size,
            stops: gtfs.stops.size,
            activeVehicles: simulation.getVehicleCount(),
            activeDetours: detourStore.getActive().length,
            totalDetours: detourStore.getAll().length,
        });
    });

    return router;
}
