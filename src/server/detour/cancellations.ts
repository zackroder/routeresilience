
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
        // Run cleanup every 12 hours to automatically purge past dates
        setInterval(() => this.cleanup(), 1000 * 60 * 60 * 12);
    }

    private load(): void {
        try {
            if (fs.existsSync(this.storePath)) {
                const data = fs.readFileSync(this.storePath, 'utf-8');
                const array: string[] = JSON.parse(data);
                this.cancelledTripIds = new Set(array);
                console.log(`Loaded ${this.cancelledTripIds.size} cancelled trips from disk`);
                this.cleanup();
            }
        } catch (e) {
            console.error('Failed to load cancellations from disk:', e);
        }
    }

    private cleanup(): void {
        const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        let changed = false;
        
        for (const key of this.cancelledTripIds) {
            const dateStr = key.split('_')[1];
            if (dateStr && dateStr < todayStr) {
                this.cancelledTripIds.delete(key);
                changed = true;
            }
        }
        
        if (changed) {
            console.log('Cleaned up past trip cancellations.');
            this.save();
        }
    }

    private async save(): Promise<void> {
        try {
            if (!fs.existsSync(this.storeDir)) {
                await fs.promises.mkdir(this.storeDir, { recursive: true });
            }
            const data = JSON.stringify(this.getAllCancelled(), null, 2);
            await fs.promises.writeFile(this.storePath, data, 'utf-8');
        } catch (e) {
            console.error('Failed to save cancellations to disk:', e);
        }
    }

    /**
     * Mark a trip as cancelled for a specific date range.
     * Expects dates in YYYYMMDD format.
     */
    cancelTrip(tripId: string, startDate: string, endDate: string): void {
        const start = this.parseYYYYMMDD(startDate);
        const end = this.parseYYYYMMDD(endDate);
        
        if (isNaN(start.getTime()) || isNaN(end.getTime())) {
            console.error('Invalid dates for cancelTrip');
            return;
        }

        let current = start;
        while (current <= end) {
            const dateStr = this.formatYYYYMMDD(current);
            const key = `${tripId}_${dateStr}`;
            this.cancelledTripIds.add(key);
            
            // Advance by 1 day
            current.setDate(current.getDate() + 1);
        }
        this.save();
    }

    restoreTrip(tripId: string, targetDate: string): void {
        const key = `${tripId}_${targetDate}`;
        if (this.cancelledTripIds.delete(key)) {
            this.save();
        }
    }

    /**
     * Mark multiple trips as cancelled for specific date ranges in a single operation.
     */
    bulkCancelTrips(payloads: {tripId: string, startDate: string, endDate: string}[]): void {
        let changed = false;
        for (const payload of payloads) {
            const start = this.parseYYYYMMDD(payload.startDate);
            const end = this.parseYYYYMMDD(payload.endDate);
            
            if (isNaN(start.getTime()) || isNaN(end.getTime())) {
                console.error(`Invalid dates for cancelTrip in bulk: ${payload.startDate} - ${payload.endDate}`);
                continue;
            }

            let current = start;
            while (current <= end) {
                const dateStr = this.formatYYYYMMDD(current);
                const key = `${payload.tripId}_${dateStr}`;
                if (!this.cancelledTripIds.has(key)) {
                    this.cancelledTripIds.add(key);
                    changed = true;
                }
                current.setDate(current.getDate() + 1);
            }
        }
        
        if (changed) {
            this.save();
        }
    }

    /**
     * Restore multiple trips in a single operation.
     * @param keys Array of tripId_YYYYMMDD strings
     */
    bulkRestoreTrips(keys: string[]): void {
        let changed = false;
        for (const key of keys) {
            if (this.cancelledTripIds.delete(key)) {
                changed = true;
            }
        }
        
        if (changed) {
            this.save();
        }
    }

    /**
     * Check if a trip is cancelled on a specific date.
     */
    isCancelled(tripId: string, targetDate: string): boolean {
        return this.cancelledTripIds.has(`${tripId}_${targetDate}`);
    }

    /**
     * Get all raw cancelled keys.
     */
    getAllCancelled(): string[] {
        return Array.from(this.cancelledTripIds);
    }

    // Helper functions for parsing and formatting YYYYMMDD
    private parseYYYYMMDD(dateStr: string): Date {
        if (!dateStr || dateStr.length !== 8) return new Date(NaN);
        const y = parseInt(dateStr.slice(0, 4), 10);
        const m = parseInt(dateStr.slice(4, 6), 10) - 1;
        const d = parseInt(dateStr.slice(6, 8), 10);
        return new Date(y, m, d);
    }

    private formatYYYYMMDD(date: Date): string {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}${m}${d}`;
    }
}
