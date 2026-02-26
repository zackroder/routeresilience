import { VehicleState } from '../../simulation/types.js';

/**
 * Prediction strategy interface.
 *
 * Implement this to add new prediction models (e.g., ML-based, historical
 * lookup, exponential smoothing). The PredictionEngine delegates all ETA
 * computation to the active strategy.
 *
 * Contract:
 *   - Returns StopPrediction[] for upcoming stops only (already-passed stops
 *     are handled by PredictionEngine itself).
 *   - Arrival/departure times are epoch seconds.
 *   - Predictions MUST be monotonically increasing in time.
 */

export interface StopPrediction {
    stopId: string;
    stopSequence: number;
    arrivalTime: number;     // epoch seconds
    departureTime: number;   // epoch seconds
    isRealtime: boolean;
}

export interface StopTimeEntry {
    stop_id: string;
    stop_sequence: number;
    arrival_time: number;    // seconds since midnight
    departure_time: number;  // seconds since midnight
}

export interface StopLocation {
    stop_id: string;
    stop_lat: number;
    stop_lon: number;
}

export interface PredictionStrategy {
    /** Human-readable name for logging/diagnostics */
    readonly name: string;

    /**
     * Predict arrival/departure times for upcoming stops.
     *
     * @param vehicle      Current vehicle state (position, speed, segment data)
     * @param stopTimes    Full ordered stop_times for the trip
     * @param stopLocations Map of stop_id → {lat, lon} for all stops in the trip
     * @param startIndex   Index of the first stop to predict (stops before this are already passed)
     * @param nowEpoch     Current time as epoch seconds
     * @returns            Array of predictions for stops from startIndex onward
     */
    predictUpcomingStops(
        vehicle: VehicleState,
        stopTimes: StopTimeEntry[],
        stopLocations: Map<string, StopLocation>,
        startIndex: number,
        nowEpoch: number,
    ): StopPrediction[];
}
