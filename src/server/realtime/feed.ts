import { GTFSRepository } from '../gtfs/database.js';
import { DetourEngine, ModifiedTrip } from '../detour/engine.js';
import { DetourStore } from '../detour/store.js';
import { VehicleDataSource } from './vehicle-data-source.js';
import { PredictionEngine, TripPrediction } from './predictions.js';
import { encodeFeedMessage } from './proto.js';
import { CancellationStore } from '../detour/cancellations.js';

export class FeedGenerator {
    // #5: instance-level cache — not shared across multiple instances
    private cachedFeed: Buffer | null = null;
    private cachedFeedJson: any = null;
    private cacheTimestamp = 0;
    private static readonly CACHE_TTL_MS = 1_000;

    // Metrics tracking
    private lastEntityCount = 0;
    private lastVehicleCount = 0;
    private lastTripUpdateCount = 0;
    private lastDetourCount = 0;
    private lastGenerationTime = 0;

    // Differential tracking
    private lastEntityStates = new Map<string, string>(); // entityId -> stringified state

    constructor(
        private repo: GTFSRepository,
        private detourEngine: DetourEngine,
        private detourStore: DetourStore,
        private vehicleSource: VehicleDataSource,
        private predictions: PredictionEngine,
        private cancellationStore: CancellationStore,
    ) { }

    /**
     * Generate the full GTFS-RT feed as a binary protobuf buffer.
     */
    async generateFeed(now: Date = new Date(), isDifferential = false): Promise<Buffer> {
        // We only cache the full dataset. Differential updates are generated fresh.
        if (!isDifferential && this.cachedFeed && (Date.now() - this.cacheTimestamp) < FeedGenerator.CACHE_TTL_MS) {
            return this.cachedFeed;
        }

        const feedMessage = await this.buildFeedMessage(now, isDifferential);
        const buffer = await encodeFeedMessage(feedMessage);

        if (!isDifferential) {
            this.cachedFeed = buffer;
            this.cachedFeedJson = feedMessage;
            this.cacheTimestamp = Date.now();
        }

        return buffer;
    }

    /**
     * Get the feed as a JSON object (for debugging).
     */
    async generateFeedJson(now: Date = new Date(), isDifferential = false): Promise<any> {
        if (!isDifferential && this.cachedFeedJson && (Date.now() - this.cacheTimestamp) < FeedGenerator.CACHE_TTL_MS) {
            return this.cachedFeedJson;
        }
        return await this.buildFeedMessage(now, isDifferential);
    }

    /**
     * Build the complete GTFS-RT FeedMessage object.
     */
    private async buildFeedMessage(now: Date, isDifferential = false): Promise<any> {
        const entities: any[] = [];
        const nowEpoch = Math.floor(now.getTime() / 1000);
        const dateStr = this.formatDateStr(now);
        const nowSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
        // #4: correct midnight epoch — mirrors PredictionEngine.predictTrip()
        const midnightEpoch = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
        let entityId = 1;

        // Get all modified trips from active detours
        const modifiedTrips = this.detourEngine.getAllModifiedTrips(now);
        const activeDetours = this.detourStore.getActive(now);

        // ─── 1. Vehicle Position entities for ALL tracked vehicles ───
        const vehicles = this.vehicleSource.getVehicles();
        for (const vehicle of vehicles) {
            // Skip cancelled trips
            if (this.cancellationStore.isCancelled(vehicle.tripId)) continue;

            entities.push({
                id: String(entityId++),
                vehicle: {
                    trip: {
                        tripId: vehicle.tripId,
                        routeId: vehicle.routeId,
                        directionId: vehicle.directionId,
                        startDate: dateStr,
                        scheduleRelationship: modifiedTrips.has(vehicle.tripId) ? 5 : 0, // REPLACEMENT or SCHEDULED
                    },
                    vehicle: {
                        id: vehicle.vehicleId,
                        label: `Bus ${vehicle.vehicleId}`,
                    },
                    position: {
                        latitude: vehicle.lat,
                        longitude: vehicle.lon,
                        bearing: vehicle.bearing,
                        speed: vehicle.speed,
                    },
                    currentStopSequence: vehicle.currentStopIndex + 1,
                    stopId: vehicle.nextStopId,
                    currentStatus: vehicle.status === 'AT_STOP' ? 1 : 2, // STOPPED_AT or IN_TRANSIT_TO
                    congestionLevel: vehicle.congestionLevel,
                    occupancyStatus: vehicle.occupancyStatus,
                    timestamp: Math.floor(vehicle.lastUpdateTime / 1000),
                },
            });
        }

        // ─── 2. TripUpdate entities for ALL active trips ───
        const activeTrips = this.repo.getActiveTrips(dateStr, nowSeconds);

        for (const trip of activeTrips) {
            // Handle cancelled trips
            if (this.cancellationStore.isCancelled(trip.trip_id)) {
                entities.push({
                    id: String(entityId++),
                    tripUpdate: {
                        trip: {
                            tripId: trip.trip_id,
                            routeId: trip.route_id,
                            directionId: trip.direction_id,
                            startDate: dateStr,
                            scheduleRelationship: 3, // CANCELED
                        },
                        timestamp: nowEpoch,
                    },
                });
                continue;
            }

            // If trip is modified, it's handled in the modified section
            if (modifiedTrips.has(trip.trip_id)) continue;

            const stopTimes = this.repo.getStopTimes(trip.trip_id);
            if (!stopTimes || stopTimes.length === 0) continue;

            const prediction = this.predictions.predictTrip(trip.trip_id, now);
            if (!prediction) continue;

            entities.push({
                id: String(entityId++),
                tripUpdate: {
                    trip: {
                        tripId: trip.trip_id,
                        routeId: trip.route_id,
                        directionId: trip.direction_id,
                        startDate: dateStr,
                        scheduleRelationship: 0, // SCHEDULED
                    },
                    stopTimeUpdate: prediction.predictions.map(p => ({
                        stopSequence: p.stopSequence,
                        stopId: p.stopId,
                        arrival: { time: p.arrivalTime },
                        departure: { time: p.departureTime },
                        scheduleRelationship: 0, // SCHEDULED
                    })),
                    timestamp: nowEpoch,
                },
            });
        }

        // ─── 3. TripUpdate entities for MODIFIED trips (detoured) ───
        for (const [tripId, modTrip] of modifiedTrips) {
            const trip = this.repo.getTrip(tripId);
            if (!trip) continue;

            entities.push({
                id: String(entityId++),
                tripUpdate: {
                    trip: {
                        tripId: tripId,
                        routeId: trip.route_id,
                        directionId: trip.direction_id,
                        startDate: dateStr,
                        scheduleRelationship: 5, // REPLACEMENT
                        modifiedTrip: {
                            modificationsId: `tm_${modTrip.detourId}`,
                            affectedTripId: tripId,
                        }
                    },
                    stopTimeUpdate: modTrip.modifiedStopTimes.map(ms => ({
                        stopSequence: ms.stopSequence,
                        stopId: ms.stopId,
                        // #4: use pre-computed midnightEpoch instead of flawed inline formula
                        arrival: { time: midnightEpoch + ms.arrivalTime },
                        departure: { time: midnightEpoch + ms.departureTime },
                        scheduleRelationship: 0,
                    })),
                    timestamp: nowEpoch,
                },
            });
        }

        // ─── 4. TripModifications entities for active detours ───
        for (const detour of activeDetours) {
            const affectedTripIds = this.detourEngine.getAffectedTripIds(detour, dateStr);
            if (affectedTripIds.length === 0) continue;

            const detourShapeId = `detour_${detour.id}`;
            const serviceAlertId = `alert_${detour.id}`;

            entities.push({
                id: `tm_${detour.id}`,
                tripModifications: {
                    selectedTrips: [{
                        tripIds: affectedTripIds,
                        shapeId: detourShapeId,
                    }],
                    modifications: [{
                        ...(detour.startStopId ? { startStopSelector: { stopId: detour.startStopId } } : {}),
                        ...(detour.endStopId ? { endStopSelector: { stopId: detour.endStopId } } : {}),
                        propagatedModificationDelay: 0,
                        replacementStops: detour.replacementStops.map(rs => ({
                            stopId: rs.stopId,
                            travelTimeToStop: rs.travelTimeFromPrevious,
                        })),
                        serviceAlertId: serviceAlertId,
                    }],
                },
            });

            // ─── 5. Shape entity for the detour geometry ───
            entities.push({
                id: `shape_${detour.id}`,
                shape: {
                    shapeId: detourShapeId,
                    encodedPolyline: encodePolyline(detour.path || detour.detourShape),
                },
            });

            // ─── 6. Stop entities for temporary stops ───
            for (const rs of detour.replacementStops) {
                if (rs.isTemporary) {
                    entities.push({
                        id: `stop_${rs.stopId}`,
                        stop: {
                            stopId: rs.stopId,
                            stopName: {
                                translation: [{ text: rs.stopName, language: 'en' }],
                            },
                            stopLat: rs.lat,
                            stopLon: rs.lon,
                        },
                    });
                }
            }

            // ─── 7. ServiceAlert entity for the detour ───
            entities.push({
                id: serviceAlertId,
                alert: {
                    activePeriod: [{
                        start: Math.floor(new Date(detour.startTime).getTime() / 1000),
                        end: Math.floor(new Date(detour.endTime).getTime() / 1000),
                    }],
                    informedEntity: [{
                        routeId: detour.routeId,
                        directionId: detour.directionId,
                    }],
                    cause: 10,  // CONSTRUCTION
                    effect: 4,  // DETOUR
                    headerText: {
                        translation: [{ text: `Detour on Route ${detour.routeId}`, language: 'en' }],
                    },
                    descriptionText: {
                        translation: [{ text: detour.description || `Route ${detour.routeId} is on detour.`, language: 'en' }],
                    },
                },
            });
        }

        // Filter for differential updates if requested
        let finalEntities = entities;
        if (isDifferential) {
            finalEntities = entities.filter(entity => {
                const state = JSON.stringify(entity);
                const lastState = this.lastEntityStates.get(entity.id);
                if (state === lastState) return false;
                this.lastEntityStates.set(entity.id, state);
                return true;
            });
        } else {
            // Update all states on full dataset generation
            for (const entity of entities) {
                this.lastEntityStates.set(entity.id, JSON.stringify(entity));
            }
        }

        const feedMessage = {
            header: {
                gtfsRealtimeVersion: '2.0',
                incrementality: isDifferential ? 1 : 0, // DIFFERENTIAL or FULL_DATASET
                timestamp: nowEpoch,
            },
            entity: finalEntities,
        };

        // Update metrics
        this.lastGenerationTime = Date.now();
        this.lastEntityCount = finalEntities.length;
        this.lastVehicleCount = vehicles.length;
        this.lastTripUpdateCount = finalEntities.filter(e => e.tripUpdate).length;
        this.lastDetourCount = activeDetours.length;

        return feedMessage;
    }

    /**
     * Get health metrics for the feed generator.
     */
    getHealthMetrics() {
        return {
            lastGenerationTime: this.lastGenerationTime,
            entityCount: this.lastEntityCount,
            vehicleCount: this.lastVehicleCount,
            tripUpdateCount: this.lastTripUpdateCount,
            detourCount: this.lastDetourCount,
            cacheAgeMs: Date.now() - this.cacheTimestamp,
        };
    }

    private formatDateStr(date: Date): string {
        return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
    }
}

// ─── Google Polyline Encoding ───

function encodePolyline(points: [number, number][]): string {
    let encoded = '';
    let prevLat = 0;
    let prevLon = 0;

    for (const [lat, lon] of points) {
        const latE5 = Math.round(lat * 1e5);
        const lonE5 = Math.round(lon * 1e5);
        encoded += encodeSignedNumber(latE5 - prevLat);
        encoded += encodeSignedNumber(lonE5 - prevLon);
        prevLat = latE5;
        prevLon = lonE5;
    }

    return encoded;
}

function encodeSignedNumber(num: number): string {
    let sgn = num << 1;
    if (num < 0) sgn = ~sgn;
    let encoded = '';
    while (sgn >= 0x20) {
        encoded += String.fromCharCode((0x20 | (sgn & 0x1f)) + 63);
        sgn >>= 5;
    }
    encoded += String.fromCharCode(sgn + 63);
    return encoded;
}
