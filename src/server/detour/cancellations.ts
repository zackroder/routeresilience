
import fs from 'fs';
import path from 'path';

/**
 * In-memory store for cancelled trips.
 */
export class CancellationStore {
    private cancelledTripIds: Set<string> = new Set();
    private readonly storeDir = process.env.PERSISTENT_DATA_DIR || path.resolve(process.cwd(), 'data');
    private readonly storePath = path.join(this.storeDir, 'cancellations.json');

    constructor() {
        this.load();
    }

    private load(): void {
        try {
            if (fs.existsSync(this.storePath)) {
                const data = fs.readFileSync(this.storePath, 'utf-8');
                const array: string[] = JSON.parse(data);
                this.cancelledTripIds = new Set(array);
                console.log(`Loaded ${this.cancelledTripIds.size} cancelled trips from disk`);
            }
        } catch (e) {
            console.error('Failed to load cancellations from disk:', e);
        }
    }

    private save(): void {
        try {
            if (!fs.existsSync(this.storeDir)) {
                fs.mkdirSync(this.storeDir, { recursive: true });
            }
            const data = JSON.stringify(this.getAllCancelled(), null, 2);
            fs.writeFileSync(this.storePath, data, 'utf-8');
        } catch (e) {
            console.error('Failed to save cancellations to disk:', e);
        }
    }

    /**
     * Mark a trip as cancelled.
     */
    cancelTrip(tripId: string): void {
        if (!this.cancelledTripIds.has(tripId)) {
            this.cancelledTripIds.add(tripId);
            this.save();
        }
    }

    /**
     * Restore a cancelled trip.
     */
    restoreTrip(tripId: string): void {
        if (this.cancelledTripIds.delete(tripId)) {
            this.save();
        }
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
