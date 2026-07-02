import { GTFSRepository } from '../gtfs/database.js';
import { DetourEngine, ModifiedTrip } from '../detour/engine.js';
import { DetourStore } from '../detour/store.js';
import { SimulationEngine } from '../simulation/engine.js';
import { PredictionEngine, TripPrediction } from './predictions.js';
import { encodeFeedMessage } from './proto.js';

/**
 * GTFS-RT Feed Generator
 * 
 * Generates a complete GTFS-RT feed containing:
 * 1. VehiclePosition entities for all tracked vehicles
 * 2. TripUpdate entities for ALL active trips
 * 3. TripModifications entities for active detours
 * 4. ServiceAlert entities
 */

// Cache for the compiled feed
let cachedFeed: Buffer | null = null;
let cachedFeedJson: any = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 1_000; // 1 second

export class FeedGenerator {
    constructor(
        private repo: GTFSRepository,
        private detourEngine: DetourEngine,
        private detourStore: DetourStore,
        private simulation: SimulationEngine,
        private predictions: PredictionEngine,
    ) { }

    /**
     * Generate the full GTFS-RT feed as a binary protobuf buffer.
     */
    async generateFeed(now: Date = new Date()): Promise<Buffer> {
        if (cachedFeed && (Date.now() - cacheTimestamp) < CACHE_TTL_MS) {
            return cachedFeed;
        }

        const feedMessage = await this.buildFeedMessage(now);
        const buffer = await encodeFeedMessage(feedMessage);

        cachedFeed = buffer;
        cachedFeedJson = feedMessage;
        cacheTimestamp = Date.now();

        return buffer;
    }

    /**
     * Get the feed as a JSON object (for debugging).
     */
    async generateFeedJson(now: Date = new Date()): Promise<any> {
        if (cachedFeedJson && (Date.now() - cacheTimestamp) < CACHE_TTL_MS) {
            return cachedFeedJson;
        }
        await this.generateFeed(now);
        return cachedFeedJson;
    }

    /**
     * Build the complete GTFS-RT FeedMessage object.
     */
    private async buildFeedMessage(now: Date): Promise<any> {
        const entities: any[] = [];
        const nowEpoch = Math.floor(now.getTime() / 1000);
        const dateStr = this.formatDateStr(now);
        const nowSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
        let entityId = 1;

        // Get all modified trips from active detours
        const modifiedTrips = this.detourEngine.getAllModifiedTrips(now);
        const activeDetours = this.detourStore.getActive(now);

        // ─── 1. Vehicle Position entities for ALL tracked vehicles ───
        const vehicles = this.simulation.getVehicles();
        for (const vehicle of vehicles) {
            entities.push({
                id: String(entityId++),
                vehicle: {
                    trip: {
                        tripId: vehicle.tripId,
                        routeId: vehicle.routeId,
                        directionId: vehicle.directionId,
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
                    timestamp: Math.floor(vehicle.lastUpdateTime / 1000),
                },
            });
        }

        // ─── 2. TripUpdate entities for ALL active trips ───
        const activeTrips = this.repo.getActiveTrips(dateStr, nowSeconds);

        for (const trip of activeTrips) {
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
                        scheduleRelationship: 5, // REPLACEMENT
                    },
                    stopTimeUpdate: modTrip.modifiedStopTimes.map(ms => ({
                        stopSequence: ms.stopSequence,
                        stopId: ms.stopId,
                        arrival: { time: Math.floor(now.getTime() / 1000) - now.getHours() * 3600 - now.getMinutes() * 60 - now.getSeconds() + ms.arrivalTime },
                        departure: { time: Math.floor(now.getTime() / 1000) - now.getHours() * 3600 - now.getMinutes() * 60 - now.getSeconds() + ms.departureTime },
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
                        startStopSelector: { stopId: detour.startStopId },
                        endStopSelector: { stopId: detour.endStopId },
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
                    encodedPolyline: encodePolyline(detour.detourShape),
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

        return {
            header: {
                gtfsRealtimeVersion: '2.0',
                incrementality: 0, // FULL_DATASET
                timestamp: nowEpoch,
            },
            entity: entities,
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
