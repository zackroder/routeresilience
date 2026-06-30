import { Detour } from './types.js';

/**
 * In-memory store for detours.
 * All access is synchronous since we're single-threaded.
 */
export class DetourStore {
    private detours: Map<string, Detour> = new Map();

    add(detour: Detour): void {
        this.detours.set(detour.id, detour);
    }

    remove(id: string): boolean {
        return this.detours.delete(id);
    }

    get(id: string): Detour | undefined {
        return this.detours.get(id);
    }

    getAll(): Detour[] {
        return Array.from(this.detours.values());
    }

    /** Returns detours that are currently active (now falls within their time window) */
    getActive(now: Date = new Date()): Detour[] {
        const nowMs = now.getTime();
        return this.getAll().filter(d => {
            const start = new Date(d.startTime).getTime();
            const end = new Date(d.endTime).getTime();
            return nowMs >= start && nowMs <= end;
        });
    }

    /** Returns detours for a specific route + direction */
    getForRoute(routeId: string, directionId: number): Detour[] {
        return this.getAll().filter(d => d.routeId === routeId && d.directionId === directionId);
    }

    /** Returns active detours for a specific route + direction */
    getActiveForRoute(routeId: string, directionId: number, now: Date = new Date()): Detour[] {
        return this.getActive(now).filter(d => d.routeId === routeId && d.directionId === directionId);
    }
}
