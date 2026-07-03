import { VehicleState } from '../simulation/types.js';

/**
 * Vehicle data source abstraction.
 *
 * In simulation mode, backed by SimulationEngine.
 * In production, implement this against a real AVL (Automatic Vehicle Location)
 * API — e.g., CTA Bus Tracker, SIRI-VM, or any vendor-specific endpoint.
 *
 * This interface is intentionally minimal. Extend it as needed when integrating
 * with real-world data sources.
 */

export interface ArrivalRecord {
    vehicleId: string;
    tripId: string;
    stopId: string;
    timestamp: number; // epoch ms
}

export interface VehicleDataSource {
    /** Human-readable name for logging (e.g., "simulation", "cta-bus-tracker") */
    readonly sourceName: string;

    /** Get all currently tracked vehicles. */
    getVehicles(): VehicleState[];

    /** Get a specific vehicle by its assigned trip ID. Returns undefined if not found. */
    getVehicleForTrip(tripId: string): VehicleState | undefined;

    /** Get the number of actively tracked vehicles. */
    getVehicleCount(): number;

    /**
     * Get recorded stop arrival events.
     * In simulation, these come from the engine's arrival log.
     * In production, these would come from an AVL timestamp feed or
     * stop-crossing detection system.
     */
    getArrivals(): ArrivalRecord[];
}
