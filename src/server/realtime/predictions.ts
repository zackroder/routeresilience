import { GTFSRepository } from '../gtfs/database.js';
import { VehicleDataSource } from './vehicle-data-source.js';
import { PredictionStrategy, StopPrediction, StopLocation } from './strategies/types.js';
import { SegmentBasedStrategy } from './strategies/segment-based.js';

// Re-export for consumers
export type { StopPrediction } from './strategies/types.js';

/**
 * Prediction engine: computes ETA predictions for each active trip.
 *
 * Delegates real-time prediction to a pluggable PredictionStrategy.
 * Default strategy: SegmentBasedStrategy (uses route geometry + per-segment speeds).
 *
 * To swap in a future model (ML, historical, etc.), call setStrategy() with
 * any implementation of PredictionStrategy.
 */

export interface TripPrediction {
    tripId: string;
    routeId: string;
    vehicleId: string | null;
    predictions: StopPrediction[];
    timestamp: number;
}

export class PredictionEngine {
    private strategy: PredictionStrategy;

    constructor(
        private repo: GTFSRepository,
        private vehicleSource: VehicleDataSource,
        strategy?: PredictionStrategy,
    ) {
        this.strategy = strategy ?? new SegmentBasedStrategy();
        console.log(`PredictionEngine using strategy: ${this.strategy.name}`);
    }

    /**
     * Swap the prediction strategy at runtime.
     */
    setStrategy(strategy: PredictionStrategy): void {
        console.log(`PredictionEngine switching strategy: ${this.strategy.name} → ${strategy.name}`);
        this.strategy = strategy;
    }

    getStrategyName(): string {
        return this.strategy.name;
    }

    /**
     * Generate predictions for a single trip.
     */
    predictTrip(tripId: string, now: Date = new Date()): TripPrediction | null {
        const trip = this.repo.getTrip(tripId);
        if (!trip) return null;

        const stopTimes = this.repo.getStopTimes(tripId);
        if (!stopTimes || stopTimes.length === 0) return null;

        const vehicle = this.vehicleSource.getVehicleForTrip(tripId);
        const nowEpoch = Math.floor(now.getTime() / 1000);
        const midnightEpoch = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);

        const predictions: StopPrediction[] = [];

        if (vehicle && vehicle.status !== 'COMPLETED') {
            // ─── Already-passed stops: use actual observed times when available ───
            const arrivals = this.vehicleSource.getArrivals();
            const tripArrivals = new Map<string, number>(); // stopId → epoch seconds
            for (const a of arrivals) {
                if (a.tripId === tripId) {
                    tripArrivals.set(a.stopId, Math.floor(a.timestamp / 1000));
                }
            }

            for (let i = 0; i <= vehicle.currentStopIndex && i < stopTimes.length; i++) {
                const st = stopTimes[i];
                const observed = tripArrivals.get(st.stop_id);
                predictions.push({
                    stopId: st.stop_id,
                    stopSequence: st.stop_sequence,
                    arrivalTime: observed ?? (midnightEpoch + st.arrival_time),
                    departureTime: (observed ? observed + 20 : midnightEpoch + st.departure_time),
                    isRealtime: !!observed,
                });
            }

            // ─── Future stops: delegate to strategy ───
            const startIndex = vehicle.currentStopIndex + 1;
            if (startIndex < stopTimes.length) {
                const stopLocations = this.buildStopLocationMap(stopTimes.map(st => st.stop_id));
                const upcoming = this.strategy.predictUpcomingStops(
                    vehicle,
                    stopTimes,
                    stopLocations,
                    startIndex,
                    nowEpoch,
                );
                predictions.push(...upcoming);

                // Store next stop prediction for accuracy tracking
                if (upcoming.length > 0) {
                    vehicle.lastPredictedArrivalTime = upcoming[0].arrivalTime;
                }
            }
        } else {
            // ─── No vehicle: schedule-based fallback ───
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

        // Final safety: enforce monotonically increasing arrival times
        this.enforceMonotonicity(predictions);

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
     * Uses the same strategy for consistency.
     */
    predictModifiedTrip(
        tripId: string,
        routeId: string,
        modifiedStops: { stopId: string; stopSequence: number; arrivalTime: number; departureTime: number; lat: number; lon: number }[],
        now: Date = new Date(),
    ): TripPrediction | null {
        const vehicle = this.vehicleSource.getVehicleForTrip(tripId);
        const nowEpoch = Math.floor(now.getTime() / 1000);
        const midnightEpoch = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);

        const predictions: StopPrediction[] = [];

        if (vehicle && vehicle.status !== 'COMPLETED') {
            // Convert modified stops to strategy-compatible format and use strategy
            const stopTimes = modifiedStops.map(ms => ({
                stop_id: ms.stopId,
                stop_sequence: ms.stopSequence,
                arrival_time: ms.arrivalTime,
                departure_time: ms.departureTime,
            }));

            const stopLocations = new Map<string, StopLocation>();
            for (const ms of modifiedStops) {
                stopLocations.set(ms.stopId, {
                    stop_id: ms.stopId,
                    stop_lat: ms.lat,
                    stop_lon: ms.lon,
                });
            }

            const upcoming = this.strategy.predictUpcomingStops(
                vehicle,
                stopTimes,
                stopLocations,
                0, // All stops are "upcoming" for modified trips
                nowEpoch,
            );
            predictions.push(...upcoming);
        } else {
            for (const ms of modifiedStops) {
                predictions.push({
                    stopId: ms.stopId,
                    stopSequence: ms.stopSequence,
                    arrivalTime: midnightEpoch + ms.arrivalTime,
                    departureTime: midnightEpoch + ms.departureTime,
                    isRealtime: false,
                });
            }
        }

        // Final safety: enforce monotonically increasing arrival times
        this.enforceMonotonicity(predictions);

        return {
            tripId,
            routeId,
            vehicleId: vehicle?.vehicleId || null,
            predictions,
            timestamp: nowEpoch,
        };
    }

    /**
     * Build a stop location map for the given stop IDs.
     */
    private buildStopLocationMap(stopIds: string[]): Map<string, StopLocation> {
        const map = new Map<string, StopLocation>();
        for (const id of stopIds) {
            if (map.has(id)) continue;
            const stop = this.repo.getStop(id);
            if (stop) {
                map.set(id, {
                    stop_id: stop.stop_id,
                    stop_lat: stop.stop_lat,
                    stop_lon: stop.stop_lon,
                });
            }
        }
        return map;
    }

    /**
     * Enforce monotonically increasing arrival times across all predictions.
     * Mutates the array in place.
     */
    private enforceMonotonicity(predictions: StopPrediction[]): void {
        for (let i = 1; i < predictions.length; i++) {
            const lastDep = predictions[i - 1].departureTime;
            if (predictions[i].arrivalTime <= lastDep) {
                predictions[i].arrivalTime = lastDep + 1;
                // Ensure departure is also at least 20s later
                const minDep = predictions[i].arrivalTime + 20;
                if (predictions[i].departureTime < minDep) {
                    predictions[i].departureTime = minDep;
                }
            }
        }
    }
}
