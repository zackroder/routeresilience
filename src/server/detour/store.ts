import { Detour } from './types.js';
import fs from 'fs';
import path from 'path';

/**
 * In-memory store for detours.
 * All access is synchronous since we're single-threaded.
 */
export class DetourStore {
    private detours: Map<string, Detour> = new Map();

    private readonly storePath = path.resolve(process.cwd(), 'data', 'detours.json');

    constructor() {
        this.load();
    }

    private load(): void {
        try {
            if (fs.existsSync(this.storePath)) {
                const data = fs.readFileSync(this.storePath, 'utf-8');
                const array: Detour[] = JSON.parse(data);
                for (const d of array) {
                    this.detours.set(d.id, d);
                }
                console.log(`Loaded ${this.detours.size} detours from disk`);
            }
        } catch (e) {
            console.error('Failed to load detours from disk:', e);
        }
    }

    private save(): void {
        try {
            const data = JSON.stringify(this.getAll(), null, 2);
            fs.writeFileSync(this.storePath, data, 'utf-8');
        } catch (e) {
            console.error('Failed to save detours to disk:', e);
        }
    }

    add(detour: Detour): void {
        this.detours.set(detour.id, detour);
        this.save();
    }

    remove(id: string): boolean {
        const removed = this.detours.delete(id);
        if (removed) this.save();
        return removed;
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
