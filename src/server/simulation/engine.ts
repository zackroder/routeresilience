import { GTFSRepository } from '../gtfs/database.js';
import { parseGTFSTime, ShapePoint } from '../gtfs/types.js';
import { haversineMeters } from '../gtfs/loader.js';
import { DetourEngine } from '../detour/engine.js';
import { VehicleState, InterpolatedShapePoint } from './types.js';

/**
 * High-performance vehicle simulation engine.
 * Simulates thousands of buses moving along their routes in real-time.
 */

const INTERPOLATION_INTERVAL_METERS = 10; // interpolate a point every 10m
const DEFAULT_SPEED_MPS = 8.9;            // ~20 mph average city bus speed
const STOP_DWELL_MS = 15_000;             // 15 seconds dwell at each stop
const SIM_TICK_MS = 1_000;                // Update every second

export class SimulationEngine {
    private vehicles: Map<string, VehicleState> = new Map();
    private interpolatedShapes: Map<string, InterpolatedShapePoint[]> = new Map();
    private tickTimer: ReturnType<typeof setInterval> | null = null;
    private vehicleCounter = 0;
    private tickCounter = 0;
    private targetVehicleCount = 0;
    private activeTripIds: string[] = [];

    constructor(
        private repo: GTFSRepository,
        private detourEngine: DetourEngine,
    ) { }

    /**
     * Lazy-load and interpolate a shape if not already cached.
     */
    private getInterpolatedShape(shapeId: string): InterpolatedShapePoint[] | null {
        if (!shapeId) return null;
        if (this.interpolatedShapes.has(shapeId)) {
            return this.interpolatedShapes.get(shapeId)!;
        }

        const points = this.repo.getShape(shapeId);
        if (!points || points.length === 0) return null;

        const interpolated = this.interpolateShape(points);
        this.interpolatedShapes.set(shapeId, interpolated);
        return interpolated;
    }

    private interpolateShape(points: ShapePoint[]): InterpolatedShapePoint[] {
        if (points.length < 2) {
            return points.map(p => ({ lat: p.shape_pt_lat, lon: p.shape_pt_lon, distance: 0 }));
        }

        const result: InterpolatedShapePoint[] = [];
        let cumulativeDistance = 0;
        result.push({ lat: points[0].shape_pt_lat, lon: points[0].shape_pt_lon, distance: 0 });

        for (let i = 1; i < points.length; i++) {
            const prev = points[i - 1];
            const curr = points[i];
            const segDist = haversineMeters(prev.shape_pt_lat, prev.shape_pt_lon, curr.shape_pt_lat, curr.shape_pt_lon);

            // Add interpolated points along this segment
            const numInterpPoints = Math.floor(segDist / INTERPOLATION_INTERVAL_METERS);
            for (let j = 1; j <= numInterpPoints; j++) {
                const t = j / (numInterpPoints + 1);
                cumulativeDistance += INTERPOLATION_INTERVAL_METERS;
                result.push({
                    lat: prev.shape_pt_lat + t * (curr.shape_pt_lat - prev.shape_pt_lat),
                    lon: prev.shape_pt_lon + t * (curr.shape_pt_lon - prev.shape_pt_lon),
                    distance: cumulativeDistance,
                });
            }

            cumulativeDistance += segDist - numInterpPoints * INTERPOLATION_INTERVAL_METERS;
            result.push({ lat: curr.shape_pt_lat, lon: curr.shape_pt_lon, distance: cumulativeDistance });
        }

        return result;
    }

    /**
     * Spawn vehicles for trips that should be active right now based on the GTFS schedule.
     */
    spawnActiveVehicles(now: Date = new Date()): void {
        const dateStr = this.formatDateStr(now);
        const nowSecondsSinceMidnight = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

        // Optimized query for active trips
        const activeTrips = this.repo.getActiveTrips(dateStr, nowSecondsSinceMidnight);
        console.log(`Found ${activeTrips.length} active trips for ${dateStr} @ ${nowSecondsSinceMidnight}`);

        let spawned = 0;
        this.activeTripIds = [];

        for (const trip of activeTrips) {
            const stopTimes = this.repo.getStopTimes(trip.trip_id);
            if (!stopTimes || stopTimes.length < 2) continue;

            const firstDeparture = stopTimes[0].departure_time;
            const lastArrival = stopTimes[stopTimes.length - 1].arrival_time;

            // Double check (query handles this mostly, but good for safety)
            if (nowSecondsSinceMidnight < firstDeparture || nowSecondsSinceMidnight > lastArrival) continue;

            const shape = this.getInterpolatedShape(trip.shape_id);
            if (!shape || shape.length < 2) continue;

            this.activeTripIds.push(trip.trip_id);

            // Check if already spawned
            if (this.getVehicleForTrip(trip.trip_id)) continue;

            // Calculate approximate position along the route based on elapsed time
            const elapsed = nowSecondsSinceMidnight - firstDeparture;
            const totalTripTime = lastArrival - firstDeparture;
            const progress = Math.min(elapsed / totalTripTime, 1.0);
            const distanceTraveled = progress * shape[shape.length - 1].distance;

            // Find closest shape index
            let shapeIndex = 0;
            for (let i = 0; i < shape.length; i++) {
                if (shape[i].distance >= distanceTraveled) {
                    shapeIndex = i;
                    break;
                }
            }

            // Find current stop index
            let currentStopIndex = 0;
            for (let i = 0; i < stopTimes.length; i++) {
                if (stopTimes[i].arrival_time <= nowSecondsSinceMidnight) {
                    currentStopIndex = i;
                }
            }

            const vehicleId = `v${++this.vehicleCounter}`;
            const pos = shape[shapeIndex];
            const nextPos = shape[Math.min(shapeIndex + 1, shape.length - 1)];
            const bearing = this.calculateBearing(pos.lat, pos.lon, nextPos.lat, nextPos.lon);

            // Calculate base speed from schedule
            const totalTripDuration = lastArrival - firstDeparture;
            const tripDistance = shape[shape.length - 1].distance;
            const baseSpeed = (totalTripDuration > 0 && tripDistance > 0) ? (tripDistance / totalTripDuration) : DEFAULT_SPEED_MPS;

            // Simulation variability (Debug Mode only)
            let speed = DEFAULT_SPEED_MPS;
            let speedFactor = 1.0;
            let isLost = false;

            if (process.env.SIMULATION_DEBUG_MODE === 'true') {
                isLost = Math.random() < 0.05;
                const u1 = Math.random();
                const u2 = Math.random();
                const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
                speedFactor = 1.0 + (z * 0.1);
                speedFactor = Math.max(0.7, Math.min(1.3, speedFactor));
                speed = baseSpeed * speedFactor;
            } else {
                speed = DEFAULT_SPEED_MPS;
            }

            this.vehicles.set(vehicleId, {
                vehicleId,
                tripId: trip.trip_id,
                routeId: trip.route_id,
                directionId: trip.direction_id,
                lat: pos.lat,
                lon: pos.lon,
                bearing,
                speed,
                shapeIndex,
                distanceTraveled,
                totalDistance: shape[shape.length - 1].distance,
                currentStopIndex,
                nextStopId: stopTimes[Math.min(currentStopIndex + 1, stopTimes.length - 1)].stop_id,
                status: 'IN_TRANSIT',
                tripStartTime: firstDeparture,
                lastUpdateTime: now.getTime(),
                dwellEndTime: 0,
                isLost,
                lostHeading: isLost ? Math.random() * 360 : undefined,
                baseSpeed,
                speedFactor: process.env.SIMULATION_DEBUG_MODE === 'true' ? speedFactor : undefined
            });

            spawned++;
        }

        this.targetVehicleCount = Math.max(spawned, 800); // Keep at least 800 vehicles
        console.log(`Spawned ${spawned} simulated vehicles (target: ${this.targetVehicleCount})`);
    }

    /**
     * Respawn a vehicle by assigning it to a random trip and placing it at the start.
     * This maintains a consistent fleet size.
     */
    private respawnVehicle(vehicleId: string, now: number): void {
        if (this.activeTripIds.length === 0) return;

        // Pick a random trip from the active pool
        const tripId = this.activeTripIds[Math.floor(Math.random() * this.activeTripIds.length)];
        const trip = this.repo.getTrip(tripId);
        if (!trip) return;

        const shape = this.getInterpolatedShape(trip.shape_id);
        if (!shape || shape.length < 2) return;

        const stopTimes = this.repo.getStopTimes(tripId);
        if (!stopTimes || stopTimes.length < 2) return;

        const firstDeparture = stopTimes[0].departure_time;

        // Start the vehicle at a random point along the first 20% of the route
        const startProgress = Math.random() * 0.2;
        const distanceTraveled = startProgress * shape[shape.length - 1].distance;

        let shapeIndex = 0;
        for (let i = 0; i < shape.length; i++) {
            if (shape[i].distance >= distanceTraveled) {
                shapeIndex = i;
                break;
            }
        }

        const pos = shape[shapeIndex];
        const nextPos = shape[Math.min(shapeIndex + 1, shape.length - 1)];

        this.vehicles.set(vehicleId, {
            vehicleId,
            tripId,
            routeId: trip.route_id,
            directionId: trip.direction_id,
            lat: pos.lat,
            lon: pos.lon,
            bearing: this.calculateBearing(pos.lat, pos.lon, nextPos.lat, nextPos.lon),

            speed: DEFAULT_SPEED_MPS, // will be overridden below if debug
            shapeIndex,
            distanceTraveled,
            totalDistance: shape[shape.length - 1].distance,
            currentStopIndex: 0,
            nextStopId: stopTimes[0].stop_id,
            status: 'IN_TRANSIT',
            tripStartTime: firstDeparture,
            lastUpdateTime: now,
            dwellEndTime: 0,
        });

        // Apply debug variability if enabled
        if (process.env.SIMULATION_DEBUG_MODE === 'true') {
            const v = this.vehicles.get(vehicleId);
            if (v) {
                const totalDuration = stopTimes[stopTimes.length - 1].arrival_time - firstDeparture;
                const baseSpeed = (totalDuration > 0 && v.totalDistance > 0) ? (v.totalDistance / totalDuration) : DEFAULT_SPEED_MPS;

                const u1 = Math.random();
                const u2 = Math.random();
                const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
                let speedFactor = 1.0 + (z * 0.1);
                speedFactor = Math.max(0.7, Math.min(1.3, speedFactor));

                v.baseSpeed = baseSpeed;
                v.speedFactor = speedFactor;
                v.speed = baseSpeed * speedFactor;
            }
        }
    }

    /**
     * Start the simulation loop.
     * All vehicles are updated in a single batch per tick for performance.
     */
    start(): void {
        if (this.tickTimer) return;

        console.log('Starting vehicle simulation...');
        this.tickTimer = setInterval(() => {
            this.tick();
        }, SIM_TICK_MS);
    }

    stop(): void {
        if (this.tickTimer) {
            clearInterval(this.tickTimer);
            this.tickTimer = null;
        }
    }

    /**
     * Single simulation tick — updates ALL vehicles.
     * Performance target: < 50ms for 2000+ vehicles.
     */
    private tick(): void {
        const now = Date.now();
        const toRespawn: string[] = [];
        this.tickCounter++;

        for (const [vehicleId, vehicle] of this.vehicles) {
            if (vehicle.status === 'COMPLETED') {
                toRespawn.push(vehicleId);
                continue;
            }

            // Handle dwelling at stop
            if (vehicle.status === 'AT_STOP') {
                if (now >= vehicle.dwellEndTime) {
                    vehicle.status = 'IN_TRANSIT';
                    vehicle.currentStopIndex++;

                    const stopTimes = this.repo.getStopTimes(vehicle.tripId);
                    if (stopTimes && vehicle.currentStopIndex < stopTimes.length) {
                        vehicle.nextStopId = stopTimes[vehicle.currentStopIndex].stop_id;
                    }
                }
                continue;
            }

            // Move vehicle along shape
            const trip = this.repo.getTrip(vehicle.tripId);
            if (!trip) continue;

            // Optimization: Get shape from cache
            const shape = this.getInterpolatedShape(trip.shape_id);
            if (!shape) continue;

            const dt = (now - vehicle.lastUpdateTime) / 1000; // seconds
            const distDelta = vehicle.speed * dt;
            vehicle.distanceTraveled += distDelta;
            vehicle.lastUpdateTime = now;

            // Check if trip is complete
            if (vehicle.distanceTraveled >= vehicle.totalDistance) {
                vehicle.status = 'COMPLETED';
                continue;
            }

            // Advance shape index
            while (vehicle.shapeIndex < shape.length - 1 && shape[vehicle.shapeIndex + 1].distance <= vehicle.distanceTraveled) {
                vehicle.shapeIndex++;
            }

            // Interpolate position between current and next shape point
            const curr = shape[vehicle.shapeIndex];
            const next = shape[Math.min(vehicle.shapeIndex + 1, shape.length - 1)];

            if (vehicle.isLost && vehicle.lostHeading !== undefined) {
                // Lost behavior: drift away from route
                const distLat = (vehicle.speed * dt) / 111111; // rough meters to degrees
                const distLon = (vehicle.speed * dt) / (111111 * Math.cos(vehicle.lat * Math.PI / 180));

                const rads = (vehicle.lostHeading * Math.PI) / 180;
                vehicle.lat += distLat * Math.cos(rads);
                vehicle.lon += distLon * Math.sin(rads);

                // Slowly change heading
                vehicle.lostHeading += (Math.random() - 0.5) * 10;
                vehicle.bearing = vehicle.lostHeading;
            } else {
                const segmentDist = next.distance - curr.distance;
                const progress = segmentDist > 0 ? (vehicle.distanceTraveled - curr.distance) / segmentDist : 0;

                vehicle.lat = curr.lat + (next.lat - curr.lat) * progress;
                vehicle.lon = curr.lon + (next.lon - curr.lon) * progress;

                // Update bearing
                vehicle.bearing = this.calculateBearing(curr.lat, curr.lon, next.lat, next.lon);
            }

            // Check if near next stop — trigger dwell
            const stopTimes = this.repo.getStopTimes(vehicle.tripId);
            if (stopTimes && vehicle.currentStopIndex < stopTimes.length) {
                const nextStop = this.repo.getStop(vehicle.nextStopId);
                if (nextStop) {
                    const distToStop = haversineMeters(vehicle.lat, vehicle.lon, nextStop.stop_lat, nextStop.stop_lon);
                    if (distToStop < 30) { // within 30m of stop
                        vehicle.dwellEndTime = now + STOP_DWELL_MS;
                        vehicle.lat = nextStop.stop_lat;
                        vehicle.lon = nextStop.stop_lon;

                        // Record arrival if in debug mode
                        if (process.env.SIMULATION_DEBUG_MODE === 'true') {
                            this.recordArrival(vehicle, nextStop.stop_id, now);
                        }
                    }
                }
            }
        }

        // Respawn completed vehicles instead of deleting them
        for (const id of toRespawn) {
            this.respawnVehicle(id, now);
        }

        // Every 30 ticks (~30s), check if we need to spawn more to maintain target
        if (this.tickCounter % 30 === 0 && this.vehicles.size < this.targetVehicleCount) {
            const deficit = this.targetVehicleCount - this.vehicles.size;
            for (let i = 0; i < Math.min(deficit, 50); i++) {
                const vehicleId = `v${++this.vehicleCounter}`;
                this.respawnVehicle(vehicleId, now);
            }
        }
    }

    private calculateBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const lat1r = lat1 * Math.PI / 180;
        const lat2r = lat2 * Math.PI / 180;
        const y = Math.sin(dLon) * Math.cos(lat2r);
        const x = Math.cos(lat1r) * Math.sin(lat2r) - Math.sin(lat1r) * Math.cos(lat2r) * Math.cos(dLon);
        return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
    }

    /**
     * Get all current vehicle positions. Used by the GTFS-RT feed and the API.
     */
    getVehicles(): VehicleState[] {
        return Array.from(this.vehicles.values());
    }

    /**
     * Get a specific vehicle by trip ID.
     */
    getVehicleForTrip(tripId: string): VehicleState | undefined {
        for (const v of this.vehicles.values()) {
            if (v.tripId === tripId) return v;
        }
        return undefined;
    }

    getVehicleCount(): number {
        return this.vehicles.size;
    }

    private formatDateStr(date: Date): string {
        return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
    }

    private arrivalLog: { vehicleId: string, tripId: string, stopId: string, timestamp: number }[] = [];

    private recordArrival(vehicle: VehicleState, stopId: string, timestamp: number) {
        // Keep last 1000 arrivals
        if (this.arrivalLog.length > 1000) this.arrivalLog.shift();
        this.arrivalLog.push({
            vehicleId: vehicle.vehicleId,
            tripId: vehicle.tripId,
            stopId,
            timestamp
        });
    }

    getArrivals() {
        return this.arrivalLog;
    }
}
