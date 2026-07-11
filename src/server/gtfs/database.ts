import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { Route, Trip, Stop, StopTime, ShapePoint, Calendar, CalendarDate } from './types.js';

const DB_PATH = path.resolve(process.cwd(), 'data', 'gtfs.db');

// Schema definition
const SCHEMA = `
    CREATE TABLE IF NOT EXISTS routes (
        route_id TEXT PRIMARY KEY,
        agency_id TEXT,
        route_short_name TEXT,
        route_long_name TEXT,
        route_type INTEGER,
        route_color TEXT,
        route_text_color TEXT,
        directions TEXT -- JSON string
    );

    CREATE TABLE IF NOT EXISTS trips (
        trip_id TEXT PRIMARY KEY,
        route_id TEXT,
        service_id TEXT,
        direction_id INTEGER,
        direction TEXT,
        trip_headsign TEXT,
        shape_id TEXT,
        block_id TEXT,
        start_time INTEGER, -- computed from stop_times
        end_time INTEGER,   -- computed from stop_times
        FOREIGN KEY(route_id) REFERENCES routes(route_id)
    );
    CREATE INDEX IF NOT EXISTS idx_trips_route_dir ON trips(route_id, direction_id);
    CREATE INDEX IF NOT EXISTS idx_trips_service ON trips(service_id);
    CREATE INDEX IF NOT EXISTS idx_trips_starttime ON trips(start_time);
    CREATE INDEX IF NOT EXISTS idx_trips_endtime ON trips(end_time);

    CREATE TABLE IF NOT EXISTS stops (
        stop_id TEXT PRIMARY KEY,
        stop_name TEXT,
        stop_lat REAL,
        stop_lon REAL,
        stop_code TEXT,
        location_type INTEGER,
        parent_station TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_stops_loc ON stops(stop_lat, stop_lon);

    CREATE TABLE IF NOT EXISTS stop_times (
        trip_id TEXT,
        arrival_time INTEGER, -- seconds from midnight
        departure_time INTEGER, -- seconds from midnight
        stop_id TEXT,
        stop_sequence INTEGER,
        pickup_type INTEGER,
        drop_off_type INTEGER,
        shape_dist_traveled REAL,
        PRIMARY KEY (trip_id, stop_sequence),
        FOREIGN KEY(trip_id) REFERENCES trips(trip_id),
        FOREIGN KEY(stop_id) REFERENCES stops(stop_id)
    );
    CREATE INDEX IF NOT EXISTS idx_st_trip ON stop_times(trip_id);
    CREATE INDEX IF NOT EXISTS idx_st_stop ON stop_times(stop_id);

    CREATE TABLE IF NOT EXISTS shapes (
        shape_id TEXT,
        shape_pt_lat REAL,
        shape_pt_lon REAL,
        shape_pt_sequence INTEGER,
        shape_dist_traveled REAL,
        PRIMARY KEY (shape_id, shape_pt_sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_shapes_id ON shapes(shape_id);

    CREATE TABLE IF NOT EXISTS calendar (
        service_id TEXT PRIMARY KEY,
        monday INTEGER,
        tuesday INTEGER,
        wednesday INTEGER,
        thursday INTEGER,
        friday INTEGER,
        saturday INTEGER,
        sunday INTEGER,
        start_date TEXT,
        end_date TEXT
    );

    CREATE TABLE IF NOT EXISTS calendar_dates (
        service_id TEXT,
        date TEXT,
        exception_type INTEGER,
        PRIMARY KEY (service_id, date)
    );
`;

export class GTFSRepository {
    private db: Database.Database;

    constructor(options: { clear?: boolean, readonly?: boolean } = {}) {
        const dataDir = path.dirname(DB_PATH);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        // Only delete if explicitly requested
        if (options.clear && fs.existsSync(DB_PATH)) {
            try {
                fs.unlinkSync(DB_PATH);
            } catch (e) {
                console.warn('Could not delete existing DB, might be in use:', e);
            }
        }

        this.db = new Database(DB_PATH, { readonly: options.readonly || false });
        
        if (!options.readonly) {
            this.db.pragma('journal_mode = WAL');
            this.db.exec(SCHEMA);
        }
    }

    // ─── Transaction Helper ───
    transaction(fn: () => void): void {
        const txn = this.db.transaction(fn);
        txn();
    }

    getDb(): Database.Database {
        return this.db;
    }

    // ─── Data Access Methods ───

    getAllRoutes(): Route[] {
        const rows = this.db.prepare('SELECT * FROM routes ORDER BY route_short_name').all() as any[];
        return rows.map(r => ({
            ...r,
            directions: r.directions ? JSON.parse(r.directions) : undefined
        }));
    }

    getRoute(routeId: string): Route | undefined {
        const row = this.db.prepare('SELECT * FROM routes WHERE route_id = ?').get(routeId) as any;
        if (!row) return undefined;
        return {
            ...row,
            directions: row.directions ? JSON.parse(row.directions) : undefined
        };
    }

    getAllStops(): Stop[] {
        return this.db.prepare('SELECT * FROM stops').all() as Stop[];
    }

    getStop(stopId: string): Stop | undefined {
        return this.db.prepare('SELECT * FROM stops WHERE stop_id = ?').get(stopId) as Stop | undefined;
    }

    getStopsInBounds(minLat: number, minLon: number, maxLat: number, maxLon: number): Stop[] {
        return this.db.prepare(`
            SELECT * FROM stops 
            WHERE stop_lat BETWEEN ? AND ? 
            AND stop_lon BETWEEN ? AND ?
        `).all(minLat, maxLat, minLon, maxLon) as Stop[];
    }

    getTripsForRoute(routeId: string, directionId: number): Trip[] {
        return this.db.prepare('SELECT * FROM trips WHERE route_id = ? AND direction_id = ?').all(routeId, directionId) as Trip[];
    }

    getTrip(tripId: string): Trip | undefined {
        return this.db.prepare('SELECT * FROM trips WHERE trip_id = ?').get(tripId) as Trip | undefined;
    }

    getStopTimes(tripId: string): StopTime[] {
        return this.db.prepare('SELECT * FROM stop_times WHERE trip_id = ? ORDER BY stop_sequence').all(tripId) as StopTime[];
    }

    getShape(shapeId: string): ShapePoint[] {
        return this.db.prepare('SELECT * FROM shapes WHERE shape_id = ? ORDER BY shape_pt_sequence').all(shapeId) as ShapePoint[];
    }

    // ─── Optimized Queries ───

    /**
     * Get trips that are active at a specific time (seconds from midnight) on a specific date.
     * Replaces the O(N) loop in SimulationEngine.
     */
    getActiveTrips(dateStr: string, timeSeconds: number): Trip[] {
        // 1. Find active services for the date
        const dayOfWeek = this.getDayColumnName(dateStr);

        // This query joins trips with calendar/calendar_dates and stop_times bounds
        // to find exactly which trips are running right now.
        // optimization: pre-filter services

        const stmt = this.db.prepare(`
            SELECT t.*
            FROM trips t
        JOIN(
            SELECT service_id FROM calendar 
                WHERE start_date <= ? AND end_date >= ? AND ${dayOfWeek} = 1
                UNION
                SELECT service_id FROM calendar_dates 
                WHERE date = ? AND exception_type = 1
                EXCEPT
                SELECT service_id FROM calendar_dates 
                WHERE date = ? AND exception_type = 2
        ) active_services ON t.service_id = active_services.service_id
            WHERE t.start_time <= ? AND t.end_time >= ?
            `);

        // We check if current time is within [start_time, end_time]
        return stmt.all(dateStr, dateStr, dateStr, dateStr, timeSeconds, timeSeconds) as Trip[];
    }

    private getDayColumnName(dateStr: string): string {
        const year = parseInt(dateStr.substring(0, 4));
        const month = parseInt(dateStr.substring(4, 6)) - 1;
        const day = parseInt(dateStr.substring(6, 8));
        const date = new Date(year, month, day);
        const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        return days[date.getDay()];
    }

    /** Returns true if the given service_id runs on the given date (YYYYMMDD). */
    isServiceActiveToday(serviceId: string, dateStr: string): boolean {
        // 1. Check calendar_dates exceptions
        const exception = this.db.prepare(
            'SELECT exception_type FROM calendar_dates WHERE service_id = ? AND date = ?'
        ).get(serviceId, dateStr) as { exception_type: number } | undefined;
        if (exception) return exception.exception_type === 1;

        // 2. Fall back to regular calendar
        const cal = this.db.prepare(
            'SELECT * FROM calendar WHERE service_id = ?'
        ).get(serviceId) as any;
        if (!cal) return false;
        if (dateStr < cal.start_date || dateStr > cal.end_date) return false;
        const col = this.getDayColumnName(dateStr);
        return cal[col] === 1;
    }

    /**
     * Get all unique shape IDs for a route/direction
     */
    getRouteShapeIds(routeId: string, directionId: number): string[] {
        const rows = this.db.prepare('SELECT DISTINCT shape_id FROM trips WHERE route_id = ? AND direction_id = ?').all(routeId, directionId) as { shape_id: string }[];
        return rows.map(r => r.shape_id).filter(id => id);
    }

    /**
     * Get all trips for a specific date, grouped by block_id.
     * Returns a map of block_id -> Trip[].
     */
    getBlocks(dateStr: string): Map<string, (Trip & { start_stop_name: string; end_stop_name: string })[]> {
        const dayOfWeek = this.getDayColumnName(dateStr);

        const rows = this.db.prepare(`
            WITH active_trips AS (
                SELECT t.*
                FROM trips t
                JOIN (
                    SELECT service_id FROM calendar 
                    WHERE start_date <= ? AND end_date >= ? AND ${dayOfWeek} = 1
                    UNION
                    SELECT service_id FROM calendar_dates 
                    WHERE date = ? AND exception_type = 1
                    EXCEPT
                    SELECT service_id FROM calendar_dates 
                    WHERE date = ? AND exception_type = 2
                ) active_services ON t.service_id = active_services.service_id
                WHERE t.block_id IS NOT NULL AND t.block_id != ''
            )
            SELECT 
                at.*,
                s_start.stop_name as start_stop_name,
                s_end.stop_name as end_stop_name
            FROM active_trips at
            LEFT JOIN stops s_start ON at.start_stop_id = s_start.stop_id
            LEFT JOIN stops s_end ON at.end_stop_id = s_end.stop_id
            ORDER BY at.block_id, at.start_time
        `).all(dateStr, dateStr, dateStr, dateStr) as (Trip & { start_stop_name: string; end_stop_name: string })[];

        const blocks = new Map<string, (Trip & { start_stop_name: string; end_stop_name: string })[]>();
        for (const trip of rows) {
            if (!blocks.has(trip.block_id)) {
                blocks.set(trip.block_id, []);
            }
            blocks.get(trip.block_id)!.push(trip);
        }
        return blocks;
    }

    // ─── Counts ───

    getRouteCount(): number {
        return (this.db.prepare('SELECT count(*) as c FROM routes').get() as { c: number }).c;
    }

    getTripCount(): number {
        return (this.db.prepare('SELECT count(*) as c FROM trips').get() as { c: number }).c;
    }

    getStopCount(): number {
        return (this.db.prepare('SELECT count(*) as c FROM stops').get() as { c: number }).c;
    }

    close(): void {
        this.db.close();
    }
}
