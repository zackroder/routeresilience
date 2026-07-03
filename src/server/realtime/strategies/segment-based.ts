import { VehicleState } from '../../simulation/types.js';
import { PredictionStrategy, StopPrediction, StopTimeEntry, StopLocation } from './types.js';

const DWELL_TIME_S = 20;  // seconds per intermediate stop
const MIN_SPEED_MPS = 3;  // minimum speed to prevent division issues
const DELAY_DECAY_PER_STOP = 0.85; // decay factor: delay diminishes per future stop

/**
 * Segment-based prediction strategy.
 *
 * Uses the vehicle's per-segment speeds and cumulative distances (computed by
 * the simulation engine from GTFS schedules) to predict arrival times by
 * walking along the route geometry — no haversine guessing.
 *
 * Schedule adherence: propagates the vehicle's measured delay (delaySeconds)
 * into future predictions, with exponential decay per stop to model gradual
 * schedule recovery.
 * For each future stop:
 *   1. Remaining distance = segmentDistances[stop_i] - distanceTraveled
 *   2. Travel time = sum of (segment_distance / segment_speed) per segment
 *   3. Dwell = 15s per intermediate stop
 */
export class SegmentBasedStrategy implements PredictionStrategy {
    readonly name = 'segment-based';

    predictUpcomingStops(
        vehicle: VehicleState,
        stopTimes: StopTimeEntry[],
        _stopLocations: Map<string, StopLocation>,
        startIndex: number,
        nowEpoch: number,
    ): StopPrediction[] {
        const predictions: StopPrediction[] = [];
        const { segmentSpeeds, segmentDistances, distanceTraveled } = vehicle;

        // Fall back to simple speed-based if segment data isn't available
        if (!segmentSpeeds?.length || !segmentDistances?.length || segmentDistances.length < stopTimes.length) {
            return this.fallbackConstantSpeed(vehicle, stopTimes, startIndex, nowEpoch);
        }

        let cumulativeTime = 0; // seconds from now
        let lastDepartureTime = 0;

        for (let i = startIndex; i < stopTimes.length; i++) {
            const st = stopTimes[i];

            // Distance along route to this stop
            const stopDist = segmentDistances[i] ?? segmentDistances[segmentDistances.length - 1];

            // Remaining route distance from vehicle to this stop
            const remainingDist = Math.max(0, stopDist - distanceTraveled);

            // Walk through segments from current position to this stop,
            // summing time at each segment's speed
            cumulativeTime = this.computeTravelTime(
                distanceTraveled,
                stopDist,
                segmentSpeeds,
                segmentDistances,
            );

            // Add dwell time for each intermediate stop between startIndex and i
            const intermediateStops = i - startIndex;
            const dwellTotal = intermediateStops * DWELL_TIME_S;

            // Propagate measured delay with exponential decay
            const stopsFromCurrent = i - startIndex;
            const delayBias = vehicle.delaySeconds * Math.pow(DELAY_DECAY_PER_STOP, stopsFromCurrent);

            let estimatedArrival = nowEpoch + Math.round(cumulativeTime + dwellTotal + delayBias);
            const DEPARTURE_OFFSET = 20;

            // Enforce strictly monotonic: arrival must be >= previous departure + 1s
            const minArrival = lastDepartureTime + 1;
            if (estimatedArrival < minArrival) {
                estimatedArrival = minArrival;
            }

            const estimatedDeparture = estimatedArrival + DEPARTURE_OFFSET;

            predictions.push({
                stopId: st.stop_id,
                stopSequence: st.stop_sequence,
                arrivalTime: estimatedArrival,
                departureTime: estimatedDeparture,
                isRealtime: true,
            });

            lastDepartureTime = estimatedDeparture;
        }

        return predictions;
    }

    /**
     * Walk through segment speeds to compute total travel time from currentDist to targetDist.
     */
    private computeTravelTime(
        currentDist: number,
        targetDist: number,
        segmentSpeeds: number[],
        segmentDistances: number[],
    ): number {
        if (targetDist <= currentDist) return 0;

        let totalTime = 0;
        let pos = currentDist;

        for (let seg = 0; seg < segmentSpeeds.length; seg++) {
            const segStart = segmentDistances[seg] ?? 0;
            const segEnd = segmentDistances[seg + 1] ?? Infinity;
            const speed = Math.max(segmentSpeeds[seg], MIN_SPEED_MPS);

            // Skip segments we've already passed
            if (pos >= segEnd) continue;

            // Stop if we've reached the target
            if (pos >= targetDist) break;

            // Portion of this segment we need to traverse
            const entryPoint = Math.max(pos, segStart);
            const exitPoint = Math.min(targetDist, segEnd);
            const distance = exitPoint - entryPoint;

            if (distance > 0) {
                totalTime += distance / speed;
                pos = exitPoint;
            }
        }

        return totalTime;
    }

    /**
     * Fallback for vehicles without segment data — constant speed estimate.
     */
    private fallbackConstantSpeed(
        vehicle: VehicleState,
        stopTimes: StopTimeEntry[],
        startIndex: number,
        nowEpoch: number,
    ): StopPrediction[] {
        const predictions: StopPrediction[] = [];
        const speed = Math.max(vehicle.speed, MIN_SPEED_MPS);
        const remainingDist = vehicle.totalDistance - vehicle.distanceTraveled;
        const remainingStops = stopTimes.length - startIndex;
        const distPerStop = remainingStops > 0 ? remainingDist / remainingStops : 0;

        let lastDepartureTime = 0;

        for (let i = startIndex; i < stopTimes.length; i++) {
            const stopsAhead = i - startIndex + 1;
            const dist = distPerStop * stopsAhead;
            const travelTime = dist / speed;
            const dwellTime = (i - startIndex) * DWELL_TIME_S;

            let estimatedArrival = nowEpoch + Math.round(travelTime + dwellTime);
            const DEPARTURE_OFFSET = 20;

            const minArrival = lastDepartureTime + 1;
            if (estimatedArrival < minArrival) {
                estimatedArrival = minArrival;
            }

            const estimatedDeparture = estimatedArrival + DEPARTURE_OFFSET;

            predictions.push({
                stopId: stopTimes[i].stop_id,
                stopSequence: stopTimes[i].stop_sequence,
                arrivalTime: estimatedArrival,
                departureTime: estimatedDeparture,
                isRealtime: true,
            });
            lastDepartureTime = estimatedDeparture;
        }

        return predictions;
    }
}
