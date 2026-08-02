import { GTFSRepository } from '../gtfs/database.js';
import { parseGTFSTime, ShapePoint } from '../gtfs/types.js';
import { haversineMeters } from '../gtfs/loader.js';
import { DetourEngine } from '../detour/engine.js';
import { DetourStore } from '../detour/store.js';
import { Detour } from '../detour/types.js';
import { VehicleState, InterpolatedShapePoint } from './types.js';
import { VehicleDataSource } from '../realtime/vehicle-data-source.js';
import { RandomFn, SeededRng, nextGaussianFrom } from './rng.js';

/**
 * High-performance vehicle simulation engine.
 * Simulates thousands of buses moving along their routes in real-time.
 *
 * Speed model: per-segment scheduled speed with ±10% normal-distribution
 * variation, capped at MAX_SPEED_MPS.
 */

const DEFAULT_SPEED_MPS = 8.9;            // ~20 mph average city bus speed
const MAX_SPEED_MPS = 15.6;               // ~35 mph — cap for unrealistic schedule segments
const STOP_DWELL_MS = 15_000;             // 15 seconds dwell at each stop
const SIM_TICK_MS = 1_000;                // Update every second
const END_GRACE_S = 3600;                 // despawn margin past the trip's scheduled last arrival

export interface SimulationOptions {
    /** Epoch-ms clock. Defaults to Date.now. */
    clock?: () => number;
    /** Uniform [0,1) RNG. Defaults to Math.random. */
    rng?: RandomFn;
    /** Seed for a deterministic RNG (overrides `rng`). */
    seed?: number;
    /** Manual time control: use advance(seconds) to drive the clock. */
    manual?: boolean;
    /** Interval for the auto tick loop. */
    tickIntervalMs?: number;
    /** Enable per-vehicle speed noise (defaults to SIMULATION_DEBUG_MODE=true). */
    speedNoise?: boolean;
}

export class SimulationEngine implements VehicleDataSource {
    readonly sourceName = 'simulation';
    private vehicles: Map<string, VehicleState> = new Map();
    private vehiclesByTripId: Map<string, string> = new Map(); // tripId → vehicleId
    private interpolatedShapes: Map<string, InterpolatedShapePoint[]> = new Map();
    private detourShapes: Map<string, InterpolatedShapePoint[]> = new Map();
    private stopShapeDistanceCache: Map<string, number> = new Map(); // key: shapeId_stopId // detourId → stitched shape
    private tickTimer: ReturnType<typeof setInterval> | null = null;
    private vehicleCounter = 0;
    private tickCounter = 0;
    private activeTripIds: string[] = [];

    // Congestion overlays: routeId/tripId -> speedMultiplier
    private congestionPresets: Map<string, number> = new Map();
    // stopId -> extra dwell ms applied when a vehicle arrives at that stop
    private stopDwellAdjustMs: Map<string, number> = new Map();

    private readonly clock: () => number;
    private rng: RandomFn;
    private readonly manual: boolean;
    private simTimeEpochMs: number;
    private readonly tickIntervalMs: number;
    private speedNoiseEnabled: boolean;

    constructor(
        private repo: GTFSRepository,
        private detourEngine: DetourEngine,
        private detourStore?: DetourStore,
        options: SimulationOptions = {},
    ) {
        this.manual = options.manual ?? false;
        this.clock = options.clock ?? (() => Date.now());
        this.simTimeEpochMs = options.clock ? options.clock() : Date.now();
        const seeded = options.seed !== undefined ? new SeededRng(options.seed) : undefined;
        this.rng = seeded ? seeded.next.bind(seeded) : (options.rng ?? Math.random);
        this.tickIntervalMs = options.tickIntervalMs ?? SIM_TICK_MS;
        this.speedNoiseEnabled = options.speedNoise ?? (process.env.SIMULATION_DEBUG_MODE === 'true');
    }

    /** Current simulation time (epoch ms). In manual mode this is the advance() clock. */
    now(): number {
        return this.manual ? this.simTimeEpochMs : this.clock();
    }

    /** Provide a reference to the DetourStore (for querying active detours per route). */
    setDetourStore(store: DetourStore): void {
        this.detourStore = store;
    }

    // ─── Shape Interpolation ─────────────────────────────────────────

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

            cumulativeDistance += segDist;
            result.push({ lat: curr.shape_pt_lat, lon: curr.shape_pt_lon, distance: cumulativeDistance });
        }

        return result;
    }

    /**
     * Interpolate an array of [lat, lon] coordinates (e.g. a detour path).
     */
    private interpolateLatLonPath(coords: [number, number][]): InterpolatedShapePoint[] {
        if (coords.length < 2) {
            return coords.map(([lat, lon]) => ({ lat, lon, distance: 0 }));
        }
        const asShapePoints: ShapePoint[] = coords.map(([lat, lon], i) => ({
            shape_id: '',
            shape_pt_lat: lat,
            shape_pt_lon: lon,
            shape_pt_sequence: i,
            shape_dist_traveled: 0,
        }));
        return this.interpolateShape(asShapePoints);
    }

    // ─── Per-Segment Speed Computation ───────────────────────────────

    /**
     * Compute the per-stop-segment scheduled speed for a trip.
     * Returns { segmentSpeeds, segmentDistances } where:
     *   - segmentSpeeds[i] = speed for segment between stop i and stop i+1
     *   - segmentDistances[i] = cumulative distance along shape to stop i
     */
    private computeSegmentSpeeds(
        shapeId: string,
        stopTimes: { stop_id: string; arrival_time: number; departure_time: number }[],
        shape: InterpolatedShapePoint[],
        speedFactor: number,
    ): { segmentSpeeds: number[]; segmentDistances: number[] } {
        // Project each stop onto the interpolated shape to get cumulative distances
        const segmentDistances: number[] = [];

        for (const st of stopTimes) {
            const cacheKey = `${shapeId}_${st.stop_id}`;
            let bestShapeDist = this.stopShapeDistanceCache.get(cacheKey);

            if (bestShapeDist === undefined) {
                const stop = this.repo.getStop(st.stop_id);
                if (!stop) {
                    // Fallback: distribute evenly
                    const fraction = segmentDistances.length / Math.max(stopTimes.length - 1, 1);
                    segmentDistances.push(fraction * shape[shape.length - 1].distance);
                    continue;
                }

                // Find nearest shape point to this stop
                let bestDist = Infinity;
                bestShapeDist = 0;
                for (const sp of shape) {
                    const d = haversineMeters(stop.stop_lat, stop.stop_lon, sp.lat, sp.lon);
                    if (d < bestDist) {
                        bestDist = d;
                        bestShapeDist = sp.distance;
                    }
                }
                this.stopShapeDistanceCache.set(cacheKey, bestShapeDist);
            }
            segmentDistances.push(bestShapeDist);
        }

        // Ensure monotonically increasing
        for (let i = 1; i < segmentDistances.length; i++) {
            if (segmentDistances[i] < segmentDistances[i - 1]) {
                segmentDistances[i] = segmentDistances[i - 1] + 1;
            }
        }

        // Compute speed for each segment
        const segmentSpeeds: number[] = [];
        for (let i = 0; i < stopTimes.length - 1; i++) {
            const dist = segmentDistances[i + 1] - segmentDistances[i];
            const time = stopTimes[i + 1].arrival_time - stopTimes[i].departure_time;

            let speed: number;
            if (time > 0 && dist > 0) {
                speed = (dist / time) * speedFactor;
            } else {
                speed = DEFAULT_SPEED_MPS * speedFactor;
            }

            // Clamp to [2 m/s, MAX_SPEED_MPS]
            speed = Math.max(2, Math.min(MAX_SPEED_MPS, speed));
            segmentSpeeds.push(speed);
        }

        // If somehow we have no segments, add a default
        if (segmentSpeeds.length === 0) {
            segmentSpeeds.push(DEFAULT_SPEED_MPS);
        }

        return { segmentSpeeds, segmentDistances };
    }

    /**
     * Generate a speed factor using normal distribution (mean=1, std=0.1),
     * clamped to [0.7, 1.3]. Uses the injected (optionally seeded) RNG.
     */
    private generateSpeedFactor(): number {
        const z = nextGaussianFrom(this.rng, 0, 0.1);
        return Math.max(0.7, Math.min(1.3, 1.0 + z));
    }

    /**
     * Get the current speed for a vehicle based on its distance along the route.
     */
    private getCurrentSegmentSpeed(vehicle: VehicleState): number {
        if (!vehicle.segmentSpeeds || vehicle.segmentSpeeds.length === 0) {
            return vehicle.speed;
        }

        // Find which segment we're in based on distance traveled
        for (let i = 0; i < vehicle.segmentDistances.length - 1; i++) {
            if (vehicle.distanceTraveled < vehicle.segmentDistances[i + 1]) {
                return vehicle.segmentSpeeds[Math.min(i, vehicle.segmentSpeeds.length - 1)];
            }
        }

        // Past all segments — use last segment speed
        return vehicle.segmentSpeeds[vehicle.segmentSpeeds.length - 1];
    }

    // ─── Detour Shape Stitching ──────────────────────────────────────

    /**
     * Build or retrieve a stitched detour shape:
     *   original[0..diverge] + detour path + original[rejoin..end]
     */
    private getDetourShape(detour: Detour, originalShapeId: string): InterpolatedShapePoint[] | null {
        if (this.detourShapes.has(detour.id)) {
            return this.detourShapes.get(detour.id)!;
        }

        const originalShape = this.getInterpolatedShape(originalShapeId);
        if (!originalShape || originalShape.length < 2) return null;

        // Find detour diverge/rejoin stops
        const startStop = detour.startStopId ? this.repo.getStop(detour.startStopId) : null;
        const endStop = detour.endStopId ? this.repo.getStop(detour.endStopId) : null;
        if ((detour.startStopId && !startStop) || (detour.endStopId && !endStop)) return null;

        // Find nearest shape indices
        let divergeIdx = 0;
        let divergeDist = Infinity;
        let rejoinIdx = originalShape.length - 1;
        let rejoinDist = Infinity;

        if (startStop) {
            for (let i = 0; i < originalShape.length; i++) {
                const dStart = haversineMeters(originalShape[i].lat, originalShape[i].lon, startStop.stop_lat, startStop.stop_lon);
                if (dStart < divergeDist) {
                    divergeDist = dStart;
                    divergeIdx = i;
                }
            }
        }

        if (endStop) {
            for (let i = 0; i < originalShape.length; i++) {
                const dEnd = haversineMeters(originalShape[i].lat, originalShape[i].lon, endStop.stop_lat, endStop.stop_lon);
                if (dEnd < rejoinDist) {
                    rejoinDist = dEnd;
                    rejoinIdx = i;
                }
            }
        }

        if (rejoinIdx <= divergeIdx) {
            // Can't stitch — just use original
            return originalShape;
        }

        // Build stitched shape
        const result: InterpolatedShapePoint[] = [];
        let cumDist = 0;

        // Part 1: original up to diverge
        for (let i = 0; i <= divergeIdx; i++) {
            if (i === 0) {
                result.push({ lat: originalShape[i].lat, lon: originalShape[i].lon, distance: 0 });
            } else {
                cumDist += haversineMeters(
                    originalShape[i - 1].lat, originalShape[i - 1].lon,
                    originalShape[i].lat, originalShape[i].lon,
                );
                result.push({ lat: originalShape[i].lat, lon: originalShape[i].lon, distance: cumDist });
            }
        }

        // Part 2: detour path
        const detourCoords = detour.detourShape;
        if (detourCoords && detourCoords.length > 0) {
            const interpolatedDetour = this.interpolateLatLonPath(detourCoords);
            for (const pt of interpolatedDetour) {
                const prev = result[result.length - 1];
                const segDist = haversineMeters(prev.lat, prev.lon, pt.lat, pt.lon);
                cumDist += segDist;
                result.push({ lat: pt.lat, lon: pt.lon, distance: cumDist });
            }
        }

        // Part 3: original from rejoin to end
        for (let i = rejoinIdx; i < originalShape.length; i++) {
            const prev = result[result.length - 1];
            const segDist = haversineMeters(prev.lat, prev.lon, originalShape[i].lat, originalShape[i].lon);
            cumDist += segDist;
            result.push({ lat: originalShape[i].lat, lon: originalShape[i].lon, distance: cumDist });
        }

        this.detourShapes.set(detour.id, result);
        return result;
    }

    // ─── Vehicle Spawning ────────────────────────────────────────────

    /**
     * Spawn vehicles for trips that should be active right now based on the GTFS schedule.
     */
    spawnActiveVehicles(now: Date = new Date(this.now())): void {
        if (this.manual) this.simTimeEpochMs = now.getTime();
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

            const vehicleId = `v${++this.vehicleCounter}`;

            // Per-segment speeds (with optional per-vehicle noise)
            const speedFactor = this.speedNoiseEnabled ? this.generateSpeedFactor() : 1.0;
            const { segmentSpeeds, segmentDistances } = this.computeSegmentSpeeds(trip.shape_id, stopTimes, shape, speedFactor);

            // Find current stop index
            let currentStopIndex = 0;
            for (let i = 0; i < stopTimes.length; i++) {
                if (stopTimes[i].arrival_time <= nowSecondsSinceMidnight) {
                    currentStopIndex = i;
                }
            }

            // Dwell-aware position: parked at a stop while dwelling, otherwise
            // interpolated through the current segment at its scheduled speed.
            // This keeps the spawn state consistent with the movement model.
            let distanceTraveled: number;
            const stopDist = segmentDistances[currentStopIndex] ?? 0;
            if (nowSecondsSinceMidnight < stopTimes[currentStopIndex].departure_time) {
                distanceTraveled = stopDist; // still dwelling at the current stop
            } else if (currentStopIndex < stopTimes.length - 1) {
                const segStart = stopDist;
                const segEnd = segmentDistances[currentStopIndex + 1] ?? segStart;
                const elapsedInSeg = Math.max(0, nowSecondsSinceMidnight - stopTimes[currentStopIndex].departure_time);
                const segSpeed = segmentSpeeds[Math.min(currentStopIndex, segmentSpeeds.length - 1)] ?? DEFAULT_SPEED_MPS;
                distanceTraveled = Math.min(segEnd, segStart + elapsedInSeg * segSpeed);
            } else {
                distanceTraveled = segmentDistances[segmentDistances.length - 1];
            }
            distanceTraveled = Math.max(0, Math.min(distanceTraveled, shape[shape.length - 1].distance));

            // Find closest shape index
            let shapeIndex = 0;
            for (let i = 0; i < shape.length; i++) {
                if (shape[i].distance >= distanceTraveled) {
                    shapeIndex = i;
                    break;
                }
            }
            // At/past the end of the shape — clamp to the last point
            if (shape[shape.length - 1].distance <= distanceTraveled) {
                shapeIndex = shape.length - 1;
            }

            const pos = shape[shapeIndex];
            const nextPos = shape[Math.min(shapeIndex + 1, shape.length - 1)];
            const bearing = this.calculateBearing(pos.lat, pos.lon, nextPos.lat, nextPos.lon);

            // Calculate base speed from schedule (for diagnostics)
            const totalTripDuration = lastArrival - firstDeparture;
            const tripDistance = shape[shape.length - 1].distance;
            const baseSpeed = (totalTripDuration > 0 && tripDistance > 0) ? (tripDistance / totalTripDuration) : DEFAULT_SPEED_MPS;

            // Initial speed = segment speed at current position
            const initialSpeed = this.getSegmentSpeedAtDistance(distanceTraveled, segmentSpeeds, segmentDistances);

            const nextStopObj = stopTimes[Math.min(currentStopIndex + 1, stopTimes.length - 1)];
            const nextStopData = nextStopObj ? this.repo.getStop(nextStopObj.stop_id) : null;

            this.vehicles.set(vehicleId, {
                vehicleId,
                tripId: trip.trip_id,
                routeId: trip.route_id,
                directionId: trip.direction_id,
                shapeId: trip.shape_id,
                lat: pos.lat,
                lon: pos.lon,
                bearing,
                speed: initialSpeed,
                shapeIndex,
                distanceTraveled,
                totalDistance: shape[shape.length - 1].distance,
                currentStopIndex,
                nextStopId: nextStopObj.stop_id,
                nextStopLat: nextStopData?.stop_lat,
                nextStopLon: nextStopData?.stop_lon,
                cachedStopTimes: stopTimes.map(st => ({ stop_id: st.stop_id, arrival_time: st.arrival_time })),
                status: 'IN_TRANSIT',
                tripStartTime: firstDeparture,
                lastUpdateTime: now.getTime(),
                dwellEndTime: 0,
                segmentSpeeds,
                segmentDistances,
                baseSpeed,
                speedFactor: this.speedNoiseEnabled ? speedFactor : undefined,
                scheduledEndTime: lastArrival,
                congestionMultiplier: 1,
                delaySeconds: 0,
                occupancyStatus: this.getRandomOccupancy(),
                congestionLevel: this.getCongestionFromSpeed(speedFactor),
            });
            this.vehiclesByTripId.set(trip.trip_id, vehicleId);

            spawned++;
        }

        console.log(`Spawned ${spawned} simulated vehicles.`);
    }

    /**
     * Get the segment speed at a given distance along the route.
     */
    private getSegmentSpeedAtDistance(distance: number, segmentSpeeds: number[], segmentDistances: number[]): number {
        for (let i = 0; i < segmentDistances.length - 1; i++) {
            if (distance < segmentDistances[i + 1]) {
                return segmentSpeeds[Math.min(i, segmentSpeeds.length - 1)];
            }
        }
        return segmentSpeeds[segmentSpeeds.length - 1] || DEFAULT_SPEED_MPS;
    }

    // ─── Simulation Loop ─────────────────────────────────────────────

    /**
     * Start the simulation loop.
     * All vehicles are updated in a single batch per tick for performance.
     */
    start(): void {
        if (this.tickTimer) return;

        console.log('Starting vehicle simulation...');
        this.tickTimer = setInterval(() => {
            this.tickAt(this.now());
        }, this.tickIntervalMs);
    }

    stop(): void {
        if (this.tickTimer) {
            clearInterval(this.tickTimer);
            this.tickTimer = null;
        }
    }

    /**
     * Manually advance the simulation clock (manual mode only), ticking at a
     * fixed step. Enables deterministic scenario testing without real-time sleeps.
     */
    advance(seconds: number, stepMs: number = 1000): void {
        if (!this.manual) {
            throw new Error('advance() requires manual mode (options.manual: true)');
        }
        const steps = Math.max(1, Math.ceil((seconds * 1000) / stepMs));
        for (let i = 0; i < steps; i++) {
            this.simTimeEpochMs += stepMs;
            this.tickAt(this.simTimeEpochMs);
        }
    }

    /** Reset all simulation state (vehicles, metrics, presets, counters). */
    reset(): void {
        this.vehicles.clear();
        this.vehiclesByTripId.clear();
        this.arrivalLog = [];
        this.arrivalLogIndex = 0;
        this.totalArrivalsWithPredictions = 0;
        this.sumSquaredError = 0;
        this.sumAbsoluteError = 0;
        this.vehicleCounter = 0;
        this.tickCounter = 0;
        this.activeTripIds = [];
        this.congestionPresets.clear();
        this.stopDwellAdjustMs.clear();
    }

    /**
     * Single simulation tick — updates ALL vehicles.
     * Performance target: < 50ms for 2000+ vehicles.
     */
    private tickAt(now: number): void {
        const toDespawn: string[] = [];
        this.tickCounter++;

        // Check for active detours once per tick (not per vehicle)
        const nowDate = new Date(now);
        const activeDetoursCache = new Map<string, Detour[]>();

        for (const [vehicleId, vehicle] of this.vehicles) {
            if (vehicle.status === 'COMPLETED') {
                toDespawn.push(vehicleId);
                continue;
            }

            // Despawn trips well past their scheduled last arrival (grace period)
            const nowSecSinceMidnight = this.secondsSinceMidnight(now);
            if (vehicle.scheduledEndTime !== undefined && nowSecSinceMidnight > vehicle.scheduledEndTime + END_GRACE_S) {
                toDespawn.push(vehicleId);
                continue;
            }

            // Handle dwelling at stop
            if (vehicle.status === 'AT_STOP') {
                // Apply a deferred hold when the vehicle arrives at the stop
                if (vehicle.holdSecondsPending !== undefined) {
                    const end = now + vehicle.holdSecondsPending * 1000;
                    vehicle.dwellEndTime = Math.max(vehicle.dwellEndTime, end);
                    vehicle.holdUntilEpochMs = end;
                    vehicle.holdSecondsPending = undefined;
                }
                if (now >= vehicle.dwellEndTime) {
                    // Deferred hold: keep dwelling at the stop until the hold expires
                    if (vehicle.holdUntilEpochMs !== undefined && now < vehicle.holdUntilEpochMs) {
                        vehicle.dwellEndTime = vehicle.holdUntilEpochMs;
                    } else {
                        vehicle.holdUntilEpochMs = undefined;
                        vehicle.status = 'IN_TRANSIT';
                        vehicle.currentStopIndex++;

                        if (vehicle.currentStopIndex < vehicle.cachedStopTimes.length) {
                            vehicle.nextStopId = vehicle.cachedStopTimes[vehicle.currentStopIndex].stop_id;
                            const nextStopData = this.repo.getStop(vehicle.nextStopId);
                            vehicle.nextStopLat = nextStopData?.stop_lat;
                            vehicle.nextStopLon = nextStopData?.stop_lon;
                        }
                    }
                }
                continue;
            }

            // ─── Breakdown: freeze the vehicle in place until it recovers ───
            if (vehicle.breakdownUntilEpochMs !== undefined) {
                if (now < vehicle.breakdownUntilEpochMs) {
                    vehicle.lastUpdateTime = now;
                    continue;
                }
                vehicle.breakdownUntilEpochMs = undefined;
            }

            // Get the shape this vehicle follows (may be a detour shape)
            let shape = this.getInterpolatedShape(vehicle.shapeId);
            if (!shape) continue;

            let shapeSwitched = false;
            // ─── Detour following ───
            if (this.detourStore && !vehicle.usingDetourShape) {
                const cacheKey = `${vehicle.routeId}_${vehicle.directionId}`;
                let activeDetours = activeDetoursCache.get(cacheKey);
                if (!activeDetours) {
                    activeDetours = this.detourStore.getActiveForRoute(vehicle.routeId, vehicle.directionId, nowDate);
                    activeDetoursCache.set(cacheKey, activeDetours);
                }
                
                if (activeDetours.length > 0) {
                    const detour = activeDetours[0]; // Use first active detour

                    // Project the diverge stop onto the shape to get its distance along the route
                    const startStop = detour.startStopId ? this.repo.getStop(detour.startStopId) : null;
                    if (startStop) {
                        let divergeDist = Infinity;
                        let divergeShapeDist = 0;
                        for (const sp of shape) {
                            const d = haversineMeters(sp.lat, sp.lon, startStop.stop_lat, startStop.stop_lon);
                            if (d < divergeDist) {
                                divergeDist = d;
                                divergeShapeDist = sp.distance;
                            }
                        }

                        // Only switch if the vehicle hasn't passed the diverge point yet
                        if (vehicle.distanceTraveled < divergeShapeDist) {
                            const detourShape = this.getDetourShape(detour, vehicle.shapeId);
                            if (detourShape && detourShape.length > 2) {
                                shape = detourShape;
                                vehicle.usingDetourShape = true;
                                vehicle.activeDetourId = detour.id;
                                vehicle.totalDistance = detourShape[detourShape.length - 1].distance;
                                shapeSwitched = true;
                            }
                        }
                    } else {
                        // Immediately switch if there's no diverge stop
                        const detourShape = this.getDetourShape(detour, vehicle.shapeId);
                        if (detourShape && detourShape.length > 2) {
                            shape = detourShape;
                            vehicle.usingDetourShape = true;
                            vehicle.activeDetourId = detour.id;
                            vehicle.totalDistance = detourShape[detourShape.length - 1].distance;
                            shapeSwitched = true;
                        }
                    }
                }
            } else if (vehicle.usingDetourShape && vehicle.activeDetourId) {
                // Keep using the cached detour shape
                const detourShape = this.detourShapes.get(vehicle.activeDetourId);
                if (detourShape) {
                    shape = detourShape;
                }
            }

            const dt = (now - vehicle.lastUpdateTime) / 1000; // seconds

            // Update speed based on current segment and congestion
            const baseSegmentSpeed = this.getCurrentSegmentSpeed(vehicle);
            const congestionMultiplier = this.congestionPresets.get(vehicle.routeId)
                ?? this.congestionPresets.get(vehicle.tripId)
                ?? 1.0;

            vehicle.congestionMultiplier = congestionMultiplier;
            vehicle.speed = baseSegmentSpeed * congestionMultiplier;

            const distDelta = vehicle.speed * dt;
            vehicle.distanceTraveled += distDelta;
            vehicle.lastUpdateTime = now;

            // Check if trip is complete
            if (vehicle.distanceTraveled >= vehicle.totalDistance) {
                vehicle.status = 'COMPLETED';
                continue;
            }

            // Advance shape index
            if (shapeSwitched || vehicle.shapeIndex >= shape.length) {
                vehicle.shapeIndex = 0;
            }
            while (vehicle.shapeIndex < shape.length - 1 && shape[vehicle.shapeIndex + 1].distance <= vehicle.distanceTraveled) {
                vehicle.shapeIndex++;
            }

            // Interpolate position between current and next shape point
            const curr = shape[vehicle.shapeIndex];
            const next = shape[Math.min(vehicle.shapeIndex + 1, shape.length - 1)];

            const segmentDist = next.distance - curr.distance;
            const progress = segmentDist > 0 ? (vehicle.distanceTraveled - curr.distance) / segmentDist : 0;

            vehicle.lat = curr.lat + (next.lat - curr.lat) * progress;
            vehicle.lon = curr.lon + (next.lon - curr.lon) * progress;

            // Update bearing
            vehicle.bearing = this.calculateBearing(curr.lat, curr.lon, next.lat, next.lon);

            // Check if near next stop — trigger dwell
            if (vehicle.currentStopIndex < vehicle.cachedStopTimes.length && vehicle.nextStopLat !== undefined && vehicle.nextStopLon !== undefined) {
                const distToStop = haversineMeters(vehicle.lat, vehicle.lon, vehicle.nextStopLat, vehicle.nextStopLon);
                if (distToStop < 30) { // within 30m of stop
                    vehicle.status = 'AT_STOP';
                    vehicle.dwellEndTime = now + STOP_DWELL_MS + (this.stopDwellAdjustMs.get(vehicle.nextStopId) ?? 0);
                    vehicle.lat = vehicle.nextStopLat;
                    vehicle.lon = vehicle.nextStopLon;

                    // Record arrival and compute schedule delay (always on so
                    // schedule-adherence is observable without debug mode).
                    this.recordArrival(vehicle, vehicle.nextStopId, now);
                    const secsSinceMidnight = this.secondsSinceMidnight(now);
                    const scheduledArrival = vehicle.cachedStopTimes[vehicle.currentStopIndex]?.arrival_time;
                    if (scheduledArrival !== undefined) {
                        vehicle.delaySeconds = secsSinceMidnight - scheduledArrival;
                    }
                }
            }
        }

        // Despawn completed vehicles (freeing memory)
        for (const id of toDespawn) {
            const vehicle = this.vehicles.get(id);
            if (vehicle) {
                this.vehiclesByTripId.delete(vehicle.tripId);
                this.vehicles.delete(id);
            }
        }

        // Every 300 ticks (~5 min), refresh active trips schedule for current time of day
        if (this.tickCounter % 300 === 0) {
            this.spawnActiveVehicles(nowDate);
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

    // ─── Public API ──────────────────────────────────────────────────

    /**
     * Get all current vehicle positions. Used by the GTFS-RT feed and the API.
     */
    getVehicles(): VehicleState[] {
        return Array.from(this.vehicles.values());
    }

    /**
     * Get a specific vehicle by trip ID. O(1) via index.
     */
    getVehicleForTrip(tripId: string): VehicleState | undefined {
        const vehicleId = this.vehiclesByTripId.get(tripId);
        if (!vehicleId) return undefined;
        return this.vehicles.get(vehicleId);
    }

    getVehicleCount(): number {
        return this.vehicles.size;
    }

    /**
     * Apply a service hold to a vehicle for `seconds`. If the vehicle is at a
     * stop, the dwell is extended; otherwise the hold is deferred and applied
     * when the vehicle reaches its next stop — guaranteeing `seconds` of hold
     * AT the stop regardless of travel time to it.
     */
    applyHold(vehicleId: string, seconds: number): boolean {
        const vehicle = this.vehicles.get(vehicleId);
        if (!vehicle || vehicle.status === 'COMPLETED') return false;
        const end = this.now() + seconds * 1000;
        vehicle.holdSecondsPending = seconds;
        vehicle.holdUntilEpochMs = end;
        if (vehicle.status === 'AT_STOP') {
            vehicle.dwellEndTime = Math.max(vehicle.dwellEndTime, end);
            vehicle.holdSecondsPending = undefined;
        }
        return true;
    }

    /** Release a vehicle from an active hold. */
    clearHold(vehicleId: string): boolean {
        const vehicle = this.vehicles.get(vehicleId);
        if (!vehicle) return false;
        let changed = false;
        if (vehicle.holdSecondsPending !== undefined) {
            vehicle.holdSecondsPending = undefined;
            changed = true;
        }
        if (vehicle.holdUntilEpochMs !== undefined) {
            vehicle.holdUntilEpochMs = undefined;
            changed = true;
        }
        return changed;
    }

    /** Whether a vehicle has an active (pending or in-effect) hold. */
    isHeld(vehicleId: string): boolean {
        const vehicle = this.vehicles.get(vehicleId);
        return !!vehicle && (
            vehicle.holdSecondsPending !== undefined
            || (vehicle.holdUntilEpochMs !== undefined && vehicle.holdUntilEpochMs > this.now())
        );
    }

    /** Freeze a vehicle in place (even mid-route) for `seconds` to model a breakdown. */
    applyBreakdown(vehicleId: string, seconds: number): boolean {
        const vehicle = this.vehicles.get(vehicleId);
        if (!vehicle || vehicle.status === 'COMPLETED') return false;
        vehicle.breakdownUntilEpochMs = this.now() + seconds * 1000;
        return true;
    }

    /** Whether a vehicle is currently broken down. */
    isBreakdown(vehicleId: string): boolean {
        const vehicle = this.vehicles.get(vehicleId);
        return !!vehicle && vehicle.breakdownUntilEpochMs !== undefined && vehicle.breakdownUntilEpochMs > this.now();
    }

    /** Deterministically rescale a vehicle's segment speeds (bunch/gap scenarios). */
    setSpeedFactor(vehicleId: string, factor: number): boolean {
        const vehicle = this.vehicles.get(vehicleId);
        if (!vehicle || !vehicle.segmentSpeeds) return false;
        vehicle.segmentSpeeds = vehicle.segmentSpeeds.map(s => s * factor);
        vehicle.speedMultiplier = (vehicle.speedMultiplier ?? 1) * factor;
        return true;
    }

    /** Add extra dwell (ms) whenever a vehicle arrives at the given stop. */
    setStopDwell(stopId: string, extraMs: number): void {
        this.stopDwellAdjustMs.set(stopId, extraMs);
    }

    /** Swap in a seeded RNG for reproducible runs. */
    setRandomSeed(seed: number): void {
        const seeded = new SeededRng(seed);
        this.rng = seeded.next.bind(seeded);
    }

    /** Enable/disable per-vehicle speed noise (optionally seeded). */
    setSpeedNoise(enabled: boolean, seed?: number): void {
        this.speedNoiseEnabled = enabled;
        if (seed !== undefined) this.setRandomSeed(seed);
    }

    private secondsSinceMidnight(epochMs: number): number {
        const d = new Date(epochMs);
        return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
    }

    private formatDateStr(date: Date): string {
        return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
    }

    // ─── Arrival Recording ───────────────────────────────────────────

    private arrivalLog: { vehicleId: string, tripId: string, stopId: string, timestamp: number }[] = [];
    private arrivalLogIndex = 0;
    private static readonly MAX_ARRIVALS = 1000;

    // Accuracy metrics
    private totalArrivalsWithPredictions = 0;
    private sumSquaredError = 0;
    private sumAbsoluteError = 0;

    private recordArrival(vehicle: VehicleState, stopId: string, timestamp: number) {
        // Compute prediction error if we have a recent prediction
        if (vehicle.lastPredictedArrivalTime) {
            const actualSeconds = Math.floor(timestamp / 1000);
            const error = actualSeconds - vehicle.lastPredictedArrivalTime;

            this.totalArrivalsWithPredictions++;
            this.sumSquaredError += error * error;
            this.sumAbsoluteError += Math.abs(error);

            // Clear it for the next leg
            vehicle.lastPredictedArrivalTime = undefined;
        }

        // O(1) circular overwrite instead of O(n) shift()
        if (this.arrivalLog.length < SimulationEngine.MAX_ARRIVALS) {
            this.arrivalLog.push({ vehicleId: vehicle.vehicleId, tripId: vehicle.tripId, stopId, timestamp });
        } else {
            this.arrivalLog[this.arrivalLogIndex] = { vehicleId: vehicle.vehicleId, tripId: vehicle.tripId, stopId, timestamp };
            this.arrivalLogIndex = (this.arrivalLogIndex + 1) % SimulationEngine.MAX_ARRIVALS;
        }
    }

    getArrivals() {
        return this.arrivalLog;
    }

    getAccuracyMetrics() {
        if (this.totalArrivalsWithPredictions === 0) {
            return { rmse: 0, mae: 0, sampleCount: 0 };
        }
        return {
            rmse: Math.round(Math.sqrt(this.sumSquaredError / this.totalArrivalsWithPredictions) * 100) / 100,
            mae: Math.round((this.sumAbsoluteError / this.totalArrivalsWithPredictions) * 100) / 100,
            sampleCount: this.totalArrivalsWithPredictions
        };
    }

    private getRandomOccupancy(): number {
        const r = this.rng();
        if (r < 0.05) return 0; // EMPTY
        if (r < 0.45) return 1; // MANY_SEATS_AVAILABLE
        if (r < 0.75) return 2; // FEW_SEATS_AVAILABLE
        if (r < 0.90) return 3; // STANDING_ROOM_ONLY
        return 5;               // FULL
    }

    private getCongestionFromSpeed(speedFactor: number): number {
        if (speedFactor > 0.95) return 1; // RUNNING_SMOOTHLY
        if (speedFactor > 0.75) return 2; // STOP_AND_GO
        if (speedFactor > 0.5) return 3;  // CONGESTION
        return 4;                        // SEVERE_CONGESTION
    }

    /** Set a speed multiplier for a route or trip (e.g. 0.5 for heavy traffic). */
    setCongestionPreset(id: string, multiplier: number) {
        this.congestionPresets.set(id, multiplier);
    }

    /** Clear all congestion presets. */
    clearCongestionPresets() {
        this.congestionPresets.clear();
    }
}
