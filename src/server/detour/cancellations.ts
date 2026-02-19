
/**
 * In-memory store for cancelled trips.
 */
export class CancellationStore {
    private cancelledTripIds: Set<string> = new Set();

    /**
     * Mark a trip as cancelled.
     */
    cancelTrip(tripId: string): void {
        this.cancelledTripIds.add(tripId);
    }

    /**
     * Restore a cancelled trip.
     */
    restoreTrip(tripId: string): void {
        this.cancelledTripIds.delete(tripId);
    }

    /**
     * Check if a trip is cancelled.
     */
    isCancelled(tripId: string): boolean {
        return this.cancelledTripIds.has(tripId);
    }

    /**
     * Get all cancelled trip IDs.
     */
    getAllCancelled(): string[] {
        return Array.from(this.cancelledTripIds);
    }
}
