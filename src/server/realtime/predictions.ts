import { GTFSRepository } from '../gtfs/database.js';
import { haversineMeters } from '../gtfs/loader.js';
import { SimulationEngine } from '../simulation/engine.js';

/**
 * Prediction engine: computes ETA predictions for each active trip.
 * Uses vehicle positions (from simulation or real AVL) + route geometry to estimate
 * arrival/departure times at upcoming stops.
 */

export interface StopPrediction {
    stopId: string;
    stopSequence: number;
    arrivalTime: number;     // epoch seconds
    departureTime: number;   // epoch seconds
    isRealtime: boolean;     // true if based on live vehicle position, false if schedule-based
}

export interface TripPrediction {
    tripId: string;
    routeId: string;
    vehicleId: string | null;
    predictions: StopPrediction[];
    timestamp: number;
}

export class PredictionEngine {
    constructor(
        private repo: GTFSRepository,
        private simulation: SimulationEngine,
    ) { }

    /**
     * Generate predictions for a single trip.
     */
    predictTrip(tripId: string, now: Date = new Date()): TripPrediction | null {
        const trip = this.repo.getTrip(tripId);
        if (!trip) return null;

        const stopTimes = this.repo.getStopTimes(tripId);
        if (!stopTimes || stopTimes.length === 0) return null;

        const vehicle = this.simulation.getVehicleForTrip(tripId);
        const nowEpoch = Math.floor(now.getTime() / 1000);
        const midnightEpoch = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);

        const predictions: StopPrediction[] = [];

        if (vehicle && vehicle.status !== 'COMPLETED') {
            // ─── Real-time predictions based on vehicle position ───
            const vehicleLat = vehicle.lat;
            const vehicleLon = vehicle.lon;
            const vehicleSpeed = Math.max(vehicle.speed, 3); // min 3 m/s

            for (let i = 0; i < stopTimes.length; i++) {
                const st = stopTimes[i];
                const stop = this.repo.getStop(st.stop_id);
                if (!stop) continue;

                if (i <= vehicle.currentStopIndex) {
                    predictions.push({
                        stopId: st.stop_id,
                        stopSequence: st.stop_sequence,
                        arrivalTime: midnightEpoch + st.arrival_time,
                        departureTime: midnightEpoch + st.departure_time,
                        isRealtime: false,
                    });
                } else {
                    const distToStop = haversineMeters(vehicleLat, vehicleLon, stop.stop_lat, stop.stop_lon);
                    const routeFactor = 1.3;
                    const estimatedTravelTime = (distToStop * routeFactor) / vehicleSpeed;
                    const estimatedArrival = nowEpoch + Math.round(estimatedTravelTime);
                    const estimatedDeparture = estimatedArrival + 20;

                    predictions.push({
                        stopId: st.stop_id,
                        stopSequence: st.stop_sequence,
                        arrivalTime: estimatedArrival,
                        departureTime: estimatedDeparture,
                        isRealtime: true,
                    });
                }
            }
        } else {
            // ─── Schedule-based predictions ───
            for (const st of stopTimes) {
                predictions.push({
                    stopId: st.stop_id,
                    stopSequence: st.stop_sequence,
                    arrivalTime: midnightEpoch + st.arrival_time,
                    departureTime: midnightEpoch + st.departure_time,
                    isRealtime: false,
                });
            }
        }

        return {
            tripId,
            routeId: trip.route_id,
            vehicleId: vehicle?.vehicleId || null,
            predictions,
            timestamp: nowEpoch,
        };
    }

    /**
     * Generate predictions for modified trips (under a detour).
     */
    predictModifiedTrip(
        tripId: string,
        routeId: string,
        modifiedStops: { stopId: string; stopSequence: number; arrivalTime: number; departureTime: number; lat: number; lon: number }[],
        now: Date = new Date(),
    ): TripPrediction | null {
        const vehicle = this.simulation.getVehicleForTrip(tripId);
        const nowEpoch = Math.floor(now.getTime() / 1000);
        const midnightEpoch = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);

        const predictions: StopPrediction[] = [];

        for (const ms of modifiedStops) {
            if (vehicle && vehicle.status !== 'COMPLETED') {
                const distToStop = haversineMeters(vehicle.lat, vehicle.lon, ms.lat, ms.lon);
                const vehicleSpeed = Math.max(vehicle.speed, 3);
                const routeFactor = 1.3;
                const estimatedTravelTime = (distToStop * routeFactor) / vehicleSpeed;
                const estimatedArrival = nowEpoch + Math.round(estimatedTravelTime);

                predictions.push({
                    stopId: ms.stopId,
                    stopSequence: ms.stopSequence,
                    arrivalTime: estimatedArrival,
                    departureTime: estimatedArrival + 20,
                    isRealtime: true,
                });
            } else {
                predictions.push({
                    stopId: ms.stopId,
                    stopSequence: ms.stopSequence,
                    arrivalTime: midnightEpoch + ms.arrivalTime,
                    departureTime: midnightEpoch + ms.departureTime,
                    isRealtime: false,
                });
            }
        }

        return {
            tripId,
            routeId,
            vehicleId: vehicle?.vehicleId || null,
            predictions,
            timestamp: nowEpoch,
        };
    }
}
