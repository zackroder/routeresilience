import { Router, Request, Response } from 'express';
import { GTFSRepository } from '../gtfs/database.js';
import { haversineMeters } from '../gtfs/loader.js';
import { DetourEngine } from '../detour/engine.js';
import { DetourStore } from '../detour/store.js';
import { CreateDetourRequest } from '../detour/types.js';
import { SimulationEngine } from '../simulation/engine.js';
import { FeedGenerator } from '../realtime/feed.js';
import { CancellationStore } from '../detour/cancellations.js';

export function createApiRouter(
    repo: GTFSRepository,
    detourEngine: DetourEngine,
    detourStore: DetourStore,
    simulation: SimulationEngine,
    feedGenerator: FeedGenerator,
    cancellationStore: CancellationStore,
): Router {
    const router = Router();

    // ─── Block / Cancellation Routes ───

    /** Get blocks for today (or specific date) */
    router.get('/blocks', (req: Request, res: Response) => {
        const dateStr = (req.query.date as string) || new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const blocks = repo.getBlocks(dateStr);

        // Get all active detours to check against
        // Note: This is a simplification. Ideally we check specific date. 
        // But detours are stored with full ISO timestamps, so we can check overlap.
        const allDetours = detourStore.getAll(); // In-memory, fast enough

        // Convert Map to array of objects
        const result = Array.from(blocks.entries()).map(([blockId, trips]) => ({
            block_id: blockId,
            trips: trips.map(t => {
                // Check for detour overlap
                // Trip times are seconds from midnight (e.g. 36000 = 10am)
                // Detour times are ISO strings. We need to convert detour times to seconds-from-midnight relative to the requested date.
                // Or easier: Convert trip times to full Date objects for comparison? 
                // Let's rely on the requested date.

                let isDetoured = false;

                // Parse the requested date (YYYYMMDD)
                const y = parseInt(dateStr.slice(0, 4));
                const m = parseInt(dateStr.slice(4, 6)) - 1;
                const d = parseInt(dateStr.slice(6, 8));

                // Trip Start Time (absolute)
                const tripStart = new Date(y, m, d, 0, 0, 0);
                tripStart.setSeconds(t.start_time);

                // Trip End Time (absolute)
                const tripEnd = new Date(y, m, d, 0, 0, 0);
                tripEnd.setSeconds(t.end_time);

                // Check detours
                for (const dt of allDetours) {
                    if (dt.routeId === t.route_id && dt.directionId === t.direction_id) {
                        const dStart = new Date(dt.startTime);
                        const dEnd = new Date(dt.endTime);

                        // Check overlap
                        if (tripStart < dEnd && tripEnd > dStart) {
                            isDetoured = true;
                            break;
                        }
                    }
                }

                return {
                    trip_id: t.trip_id,
                    route_id: t.route_id,
                    direction_id: t.direction_id,
                    // service_id: t.service_id, // Optimized out
                    start_time: t.start_time,
                    end_time: t.end_time,
                    trip_headsign: t.trip_headsign,
                    is_cancelled: cancellationStore.isCancelled(t.trip_id),
                    is_detoured: isDetoured,
                    start_stop_name: t.start_stop_name,
                    end_stop_name: t.end_stop_name
                };
            })
        }));

        res.json(result);
    });

    /** Get all cancelled trip IDs with details */
    router.get('/cancellations', (_req: Request, res: Response) => {
        const ids = cancellationStore.getAllCancelled();
        const details = ids.map(id => {
            const trip = repo.getTrip(id);
            if (!trip) return { trip_id: id, status: 'UNKNOWN' };
            const route = repo.getRoute(trip.route_id);
            // Fetch first/last stop names from stop_times
            const stopTimes = repo.getStopTimes(id) || [];
            const firstStop = stopTimes.length > 0 ? repo.getStop(stopTimes[0].stop_id) : null;
            const lastStop = stopTimes.length > 0 ? repo.getStop(stopTimes[stopTimes.length - 1].stop_id) : null;
            return {
                trip_id: id,
                route_id: trip.route_id,
                route_short_name: route?.route_short_name,
                route_color: route?.route_color,
                route_text_color: route?.route_text_color,
                direction_id: trip.direction_id,
                block_id: trip.block_id,
                start_time: trip.start_time,
                end_time: trip.end_time,
                first_stop_name: firstStop?.stop_name || null,
                last_stop_name: lastStop?.stop_name || null,
            };
        });
        res.json(details);
    });

    /** Cancel a trip */
    router.post('/trips/:id/cancel', (req: Request, res: Response) => {
        cancellationStore.cancelTrip(req.params.id);
        res.json({ success: true, trip_id: req.params.id, status: 'CANCELED' });
    });

    /** Restore a trip */
    router.post('/trips/:id/restore', (req: Request, res: Response) => {
        cancellationStore.restoreTrip(req.params.id);
        res.json({ success: true, trip_id: req.params.id, status: 'RESTORED' });
    });

    /** List all bus routes */
    router.get('/routes', (_req: Request, res: Response) => {
        const routes = repo.getAllRoutes().map(r => ({
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
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200); // #12: configurable, capped at 200

        const trips = repo.getTripsForRoute(routeId, directionId);

        const result = trips.slice(0, limit).map(trip => {
            const stopTimes = repo.getStopTimes(trip.trip_id) || [];
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
        res.json(result);
    });

    /** Get all unique shape patterns for a route + direction, sorted by today-trip-count descending */
    router.get('/routes/:id/shape', (req: Request, res: Response) => {
        const routeId = req.params.id;
        const directionId = parseInt(req.query.direction as string) || 0;
        const trips = repo.getTripsForRoute(routeId, directionId);

        // Today's date in YYYYMMDD format (for service-active check)
        const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');

        // Collect all unique shapes for this route+direction
        const shapesMap = new Map<string, {
            shape_id: string;
            points: { lat: number; lon: number }[];
            totalDistance: number;
            tripCount: number;      // all-time (for display fallback)
            todayTripCount: number; // trips running today
            representativeTripId: string;
        }>();

        // Cache shapes to avoid redundant queries
        const shapeCache = new Map<string, { lat: number, lon: number }[]>();

        for (const trip of trips) {
            if (!trip.shape_id) continue;

            const runsToday = repo.isServiceActiveToday(trip.service_id, todayStr);

            if (shapesMap.has(trip.shape_id)) {
                const entry = shapesMap.get(trip.shape_id)!;
                entry.tripCount++;
                if (runsToday) entry.todayTripCount++;
                continue;
            }

            let points: { lat: number, lon: number }[];
            if (shapeCache.has(trip.shape_id)) {
                points = shapeCache.get(trip.shape_id)!;
            } else {
                const rawPoints = repo.getShape(trip.shape_id);
                if (!rawPoints || rawPoints.length < 2) continue;
                points = rawPoints.map(p => ({ lat: p.shape_pt_lat, lon: p.shape_pt_lon }));
                shapeCache.set(trip.shape_id, points);
            }

            // Calculate total distance for fallback sorting
            let totalDistance = 0;
            for (let i = 1; i < points.length; i++) {
                const a = points[i - 1], b = points[i];
                const dx = (b.lat - a.lat) * 111320;
                const dy = (b.lon - a.lon) * 111320 * Math.cos(a.lat * Math.PI / 180);
                totalDistance += Math.sqrt(dx * dx + dy * dy);
            }

            shapesMap.set(trip.shape_id, {
                shape_id: trip.shape_id, points, totalDistance,
                tripCount: 1,
                todayTripCount: runsToday ? 1 : 0,
                representativeTripId: trip.trip_id,
            });
        }

        // Sort by today-trip-count descending, then by total distance as tiebreaker
        const patterns = Array.from(shapesMap.values())
            .sort((a, b) => b.todayTripCount - a.todayTripCount || b.totalDistance - a.totalDistance);

        if (patterns.length > 0) {
            // Build enriched pattern info with first/last stop names and stop IDs
            const enrichedPatterns = patterns.map((p, i) => {
                const stopTimes = repo.getStopTimes(p.representativeTripId) || [];
                const stopIds = stopTimes.map(st => st.stop_id);
                const firstStop = stopTimes.length > 0 ? repo.getStop(stopTimes[0].stop_id) : null;
                const lastStop = stopTimes.length > 0 ? repo.getStop(stopTimes[stopTimes.length - 1].stop_id) : null;
                return {
                    shape_id: p.shape_id,
                    pointCount: p.points.length,
                    totalDistance: Math.round(p.totalDistance),
                    tripCount: p.todayTripCount,  // now = today's count
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
        const trips = repo.getTripsForRoute(routeId, directionId);

        let longestStopTimes: any[] | null = null;
        let longestLen = 0;

        // Check top 20 trips
        for (const trip of trips.slice(0, 20)) {
            const st = repo.getStopTimes(trip.trip_id);
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
            const stop = repo.getStop(st.stop_id);
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

        // Bounding box for pre-filter
        const latDelta = radius / 111111;
        const lonDelta = radius / (111111 * Math.cos(lat * Math.PI / 180));

        const stops = repo.getStopsInBounds(lat - latDelta, lon - lonDelta, lat + latDelta, lon + lonDelta);
        const result = stops.filter(s => haversineMeters(lat, lon, s.stop_lat, s.stop_lon) <= radius);

        res.json(result.map(s => ({
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

        const stops = repo.getStopsInBounds(minLat, minLon, maxLat, maxLon);
        res.json(stops.map(s => ({
            stop_id: s.stop_id,
            stop_name: s.stop_name,
            stop_lat: s.stop_lat,
            stop_lon: s.stop_lon,
        })));
    });

    /** Get a stop by ID */
    router.get('/stops/:id', (req: Request, res: Response) => {
        const stop = repo.getStop(req.params.id);
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
            if (!body.routeId || body.startStopId === undefined || body.endStopId === undefined || !body.startTime || !body.endTime) {
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
            const startStop = d.startStopId ? repo.getStop(d.startStopId) : null;
            const endStop = d.endStopId ? repo.getStop(d.endStopId) : null;
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
                skippedStops: d.skippedStops || [],
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
    router.get('/gtfs-rt', async (req: Request, res: Response) => {
        try {
            const isDifferential = req.query.differential === 'true';
            const buffer = await feedGenerator.generateFeed(new Date(), isDifferential);
            res.set('Content-Type', 'application/x-protobuf');
            res.send(buffer);
        } catch (err: any) {
            console.error('Error generating GTFS-RT feed:', err);
            res.status(500).json({ error: err.message });
        }
    });

    /** JSON debug view of GTFS-RT feed */
    router.get('/gtfs-rt/json', async (req: Request, res: Response) => {
        try {
            const isDifferential = req.query.differential === 'true';
            const json = await feedGenerator.generateFeedJson(new Date(), isDifferential);
            res.json(json);
        } catch (err: any) {
            console.error('Error generating GTFS-RT feed:', err);
            res.status(500).json({ error: err.message });
        }
    });

    /** SSE stream of real-time feed updates (push every 2s) */
    router.get('/gtfs-rt/stream', (req: Request, res: Response) => {
        // SSE headers
        res.set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no', // disable nginx buffering
        });
        res.flushHeaders();

        const pushInterval = parseInt(req.query.interval as string) || 2000;
        const includePositions = req.query.positions !== 'false'; // default: include
        let alive = true;

        const send = async () => {
            if (!alive) return;
            try {
                const json = await feedGenerator.generateFeedJson();
                const vehicles = simulation.getVehicles();

                // Compute delay stats
                const delays = vehicles.filter(v => v.status !== 'COMPLETED').map(v => v.delaySeconds);
                const avgDelay = delays.length > 0 ? delays.reduce((a, b) => a + b, 0) / delays.length : 0;
                const maxDelay = delays.length > 0 ? Math.max(...delays) : 0;
                const onTimeCount = delays.filter(d => Math.abs(d) < 60).length;

                const payload = {
                    timestamp: Date.now(),
                    entityCount: json?.entity?.length ?? 0,
                    vehicleCount: vehicles.length,
                    stats: {
                        avgDelaySeconds: Math.round(avgDelay),
                        maxDelaySeconds: Math.round(maxDelay),
                        onTimePercent: delays.length > 0 ? Math.round((onTimeCount / delays.length) * 100) : 100,
                    },
                    ...(includePositions ? {
                        vehicles: vehicles.slice(0, 200).map(v => ({
                            id: v.vehicleId,
                            trip: v.tripId,
                            route: v.routeId,
                            lat: v.lat,
                            lon: v.lon,
                            bearing: v.bearing,
                            speed: v.speed,
                            delay: v.delaySeconds,
                            occupancy: v.occupancyStatus,
                            congestion: v.congestionLevel,
                            status: v.status,
                        })),
                    } : {}),
                };

                res.write(`data: ${JSON.stringify(payload)}\n\n`);
            } catch (err) {
                // Silently skip errors — stream continues
            }
        };

        // Initial push
        send();

        // Periodic pushes
        const timer = setInterval(send, Math.max(pushInterval, 1000));

        // Cleanup on disconnect
        req.on('close', () => {
            alive = false;
            clearInterval(timer);
        });
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
                occupancyStatus: v.occupancyStatus,
                congestionLevel: v.congestionLevel,
            })),
        });
    });

    /** Get arrival logs (debug) */
    router.get('/arrivals', (_req: Request, res: Response) => {
        res.json(simulation.getArrivals());
    });

    /** Set simulation congestion (speed multiplier) for a route or trip */
    router.post('/simulation/congestion', (req: Request, res: Response) => {
        const { id, multiplier } = req.body;
        if (!id || multiplier === undefined) {
            res.status(400).json({ error: 'id and multiplier are required' });
            return;
        }
        simulation.setCongestionPreset(id, parseFloat(multiplier));
        res.json({ success: true, id, multiplier });
    });

    /** Clear all simulation congestion */
    router.delete('/simulation/congestion', (_req: Request, res: Response) => {
        simulation.clearCongestionPresets();
        res.json({ success: true });
    });

    /** System health and metrics */
    router.get('/health', (_req: Request, res: Response) => {
        const feedMetrics = feedGenerator.getHealthMetrics();
        const accuracyMetrics = simulation.getAccuracyMetrics();
        res.json({
            status: 'UP',
            uptimeSeconds: Math.floor(process.uptime()),
            memoryUsage: process.memoryUsage(),
            feed: feedMetrics,
            accuracy: accuracyMetrics,
            system: {
                routes: repo.getRouteCount(),
                trips: repo.getTripCount(),
                stops: repo.getStopCount(),
                activeVehicles: simulation.getVehicleCount(),
                activeDetours: detourStore.getActive().length,
            }
        });
    });

    /** System status */
    router.get('/status', (_req: Request, res: Response) => {
        res.json({
            routes: repo.getRouteCount(),
            trips: repo.getTripCount(),
            stops: repo.getStopCount(),
            activeVehicles: simulation.getVehicleCount(),
            activeDetours: detourStore.getActive().length,
            totalDetours: detourStore.getAll().length,
        });
    });

    return router;
}
