import { parse } from 'csv-parse/sync';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import AdmZip from 'adm-zip';
import {
    GTFSData, Route, Trip, Stop, StopTime, ShapePoint, Calendar, CalendarDate,
    gridKey, GRID_CELL_SIZE,
} from './types.js';

const CTA_GTFS_URL = 'https://www.transitchicago.com/downloads/sch_data/google_transit.zip';
const DATA_DIR = path.resolve(process.cwd(), 'data');
const GTFS_ZIP_PATH = path.join(DATA_DIR, 'google_transit.zip');
const GTFS_EXTRACTED_DIR = path.join(DATA_DIR, 'gtfs');

// ─── Download ───

function downloadFile(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const file = fs.createWriteStream(dest);
        const makeRequest = (requestUrl: string) => {
            const client = requestUrl.startsWith('https') ? https : http;
            client.get(requestUrl, (response) => {
                // Handle redirects
                if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    makeRequest(response.headers.location);
                    return;
                }
                if (response.statusCode !== 200) {
                    reject(new Error(`Download failed with status ${response.statusCode}`));
                    return;
                }
                response.pipe(file);
                file.on('finish', () => { file.close(); resolve(); });
            }).on('error', (err) => {
                fs.unlinkSync(dest);
                reject(err);
            });
        };
        makeRequest(url);
    });
}

// ─── Extract ───

function extractZip(zipPath: string, destDir: string): void {
    fs.mkdirSync(destDir, { recursive: true });
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(destDir, true);
}

// ─── Parse CSV ───

function parseCSV<T>(filePath: string): T[] {
    if (!fs.existsSync(filePath)) {
        console.warn(`GTFS file not found: ${filePath}`);
        return [];
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    // Remove BOM if present
    const cleaned = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
    return parse(cleaned, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        cast: false,        // We'll cast manually for type safety
    });
}

// ─── Build Spatial Grid ───

function buildSpatialGrid(stops: Map<string, Stop>): Map<string, Stop[]> {
    const grid = new Map<string, Stop[]>();
    for (const stop of stops.values()) {
        const key = gridKey(stop.stop_lat, stop.stop_lon);
        let cell = grid.get(key);
        if (!cell) {
            cell = [];
            grid.set(key, cell);
        }
        cell.push(stop);
    }
    return grid;
}

// ─── Main Loader ───

export async function loadGTFS(): Promise<GTFSData> {
    // Download if not cached
    if (!fs.existsSync(GTFS_ZIP_PATH)) {
        console.log('Downloading CTA GTFS feed...');
        await downloadFile(CTA_GTFS_URL, GTFS_ZIP_PATH);
        console.log('Download complete.');
    }

    // Extract if not already
    if (!fs.existsSync(GTFS_EXTRACTED_DIR) || !fs.existsSync(path.join(GTFS_EXTRACTED_DIR, 'routes.txt'))) {
        console.log('Extracting GTFS feed...');
        extractZip(GTFS_ZIP_PATH, GTFS_EXTRACTED_DIR);
        console.log('Extraction complete.');
    }

    const gtfsPath = (file: string) => path.join(GTFS_EXTRACTED_DIR, file);

    console.log('Parsing GTFS data...');
    const startTime = Date.now();

    // Parse routes — filter to buses only (route_type === 3)
    const rawRoutes = parseCSV<Record<string, string>>(gtfsPath('routes.txt'));
    const routes = new Map<string, Route>();
    for (const r of rawRoutes) {
        if (parseInt(r.route_type) === 3) {
            routes.set(r.route_id, {
                route_id: r.route_id,
                agency_id: r.agency_id || '',
                route_short_name: r.route_short_name || '',
                route_long_name: r.route_long_name || '',
                route_type: 3,
                route_color: r.route_color || '0000FF',
                route_text_color: r.route_text_color || 'FFFFFF',
            });
        }
    }

    // Parse trips — only those belonging to bus routes
    const rawTrips = parseCSV<Record<string, string>>(gtfsPath('trips.txt'));
    const trips = new Map<string, Trip>();
    const tripsByRoute = new Map<string, string[]>();
    for (const t of rawTrips) {
        if (!routes.has(t.route_id)) continue;
        const trip: Trip = {
            trip_id: t.trip_id,
            route_id: t.route_id,
            service_id: t.service_id,
            direction_id: parseInt(t.direction_id) || 0,
            trip_headsign: t.trip_headsign || '',
            shape_id: t.shape_id || '',
            block_id: t.block_id || '',
        };
        trips.set(trip.trip_id, trip);

        const key = `${trip.route_id}_${trip.direction_id}`;
        let arr = tripsByRoute.get(key);
        if (!arr) {
            arr = [];
            tripsByRoute.set(key, arr);
        }
        arr.push(trip.trip_id);
    }

    // Parse stops
    const rawStops = parseCSV<Record<string, string>>(gtfsPath('stops.txt'));
    const stops = new Map<string, Stop>();
    for (const s of rawStops) {
        stops.set(s.stop_id, {
            stop_id: s.stop_id,
            stop_name: s.stop_name || '',
            stop_lat: parseFloat(s.stop_lat),
            stop_lon: parseFloat(s.stop_lon),
            stop_code: s.stop_code || '',
            location_type: parseInt(s.location_type) || 0,
            parent_station: s.parent_station || '',
        });
    }

    // Parse stop_times — only for bus trips
    const rawStopTimes = parseCSV<Record<string, string>>(gtfsPath('stop_times.txt'));
    const stopTimesByTrip = new Map<string, StopTime[]>();
    for (const st of rawStopTimes) {
        if (!trips.has(st.trip_id)) continue;
        const stopTime: StopTime = {
            trip_id: st.trip_id,
            arrival_time: st.arrival_time,
            departure_time: st.departure_time,
            stop_id: st.stop_id,
            stop_sequence: parseInt(st.stop_sequence),
            pickup_type: parseInt(st.pickup_type) || 0,
            drop_off_type: parseInt(st.drop_off_type) || 0,
            shape_dist_traveled: parseFloat(st.shape_dist_traveled) || 0,
        };
        let arr = stopTimesByTrip.get(st.trip_id);
        if (!arr) {
            arr = [];
            stopTimesByTrip.set(st.trip_id, arr);
        }
        arr.push(stopTime);
    }

    // Sort stop times by sequence
    for (const [, arr] of stopTimesByTrip) {
        arr.sort((a, b) => a.stop_sequence - b.stop_sequence);
    }

    // Parse shapes — only for shapes used by bus trips
    const usedShapeIds = new Set<string>();
    for (const trip of trips.values()) {
        if (trip.shape_id) usedShapeIds.add(trip.shape_id);
    }

    const rawShapes = parseCSV<Record<string, string>>(gtfsPath('shapes.txt'));
    const shapePoints = new Map<string, ShapePoint[]>();
    for (const sp of rawShapes) {
        if (!usedShapeIds.has(sp.shape_id)) continue;
        const point: ShapePoint = {
            shape_id: sp.shape_id,
            shape_pt_lat: parseFloat(sp.shape_pt_lat),
            shape_pt_lon: parseFloat(sp.shape_pt_lon),
            shape_pt_sequence: parseInt(sp.shape_pt_sequence),
            shape_dist_traveled: parseFloat(sp.shape_dist_traveled) || 0,
        };
        let arr = shapePoints.get(sp.shape_id);
        if (!arr) {
            arr = [];
            shapePoints.set(sp.shape_id, arr);
        }
        arr.push(point);
    }

    // Sort shapes by sequence
    for (const [, arr] of shapePoints) {
        arr.sort((a, b) => a.shape_pt_sequence - b.shape_pt_sequence);
    }

    // Parse calendars
    const rawCalendars = parseCSV<Record<string, string>>(gtfsPath('calendar.txt'));
    const calendars = new Map<string, Calendar>();
    for (const c of rawCalendars) {
        calendars.set(c.service_id, {
            service_id: c.service_id,
            monday: parseInt(c.monday),
            tuesday: parseInt(c.tuesday),
            wednesday: parseInt(c.wednesday),
            thursday: parseInt(c.thursday),
            friday: parseInt(c.friday),
            saturday: parseInt(c.saturday),
            sunday: parseInt(c.sunday),
            start_date: c.start_date,
            end_date: c.end_date,
        });
    }

    // Parse calendar_dates
    const rawCalendarDates = parseCSV<Record<string, string>>(gtfsPath('calendar_dates.txt'));
    const calendarDates = new Map<string, CalendarDate[]>();
    for (const cd of rawCalendarDates) {
        const entry: CalendarDate = {
            service_id: cd.service_id,
            date: cd.date,
            exception_type: parseInt(cd.exception_type),
        };
        let arr = calendarDates.get(cd.service_id);
        if (!arr) {
            arr = [];
            calendarDates.set(cd.service_id, arr);
        }
        arr.push(entry);
    }

    // Build spatial grid
    const stopSpatialGrid = buildSpatialGrid(stops);

    const elapsed = Date.now() - startTime;
    console.log(`GTFS loaded in ${elapsed}ms: ${routes.size} routes, ${trips.size} trips, ${stops.size} stops, ${stopTimesByTrip.size} trip stop-time lists, ${shapePoints.size} shapes`);

    return {
        routes,
        trips,
        stops,
        stopTimesByTrip,
        tripsByRoute,
        shapePoints,
        calendars,
        calendarDates,
        stopSpatialGrid,
    };
}

// ─── Spatial Queries ───

export function findNearbyStops(gtfs: GTFSData, lat: number, lon: number, radiusMeters: number = 500): Stop[] {
    const radiusDeg = radiusMeters / 111_000; // rough conversion
    const results: Stop[] = [];

    // Check surrounding grid cells
    const cellsToCheck = Math.ceil(radiusDeg / GRID_CELL_SIZE) + 1;
    const centerGx = Math.floor(lat / GRID_CELL_SIZE);
    const centerGy = Math.floor(lon / GRID_CELL_SIZE);

    for (let dx = -cellsToCheck; dx <= cellsToCheck; dx++) {
        for (let dy = -cellsToCheck; dy <= cellsToCheck; dy++) {
            const key = `${centerGx + dx}_${centerGy + dy}`;
            const cell = gtfs.stopSpatialGrid.get(key);
            if (!cell) continue;
            for (const stop of cell) {
                const dist = haversineMeters(lat, lon, stop.stop_lat, stop.stop_lon);
                if (dist <= radiusMeters) {
                    results.push(stop);
                }
            }
        }
    }

    return results;
}

// ─── Service Date Helpers ───

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

export function isServiceActiveOnDate(gtfs: GTFSData, serviceId: string, dateStr: string): boolean {
    // Check calendar_dates exceptions first
    const exceptions = gtfs.calendarDates.get(serviceId) || [];
    for (const exc of exceptions) {
        if (exc.date === dateStr) {
            return exc.exception_type === 1; // 1 = added, 2 = removed
        }
    }

    // Check regular calendar
    const cal = gtfs.calendars.get(serviceId);
    if (!cal) return false;

    // Check date range
    if (dateStr < cal.start_date || dateStr > cal.end_date) return false;

    // Check day of week
    const year = parseInt(dateStr.substring(0, 4));
    const month = parseInt(dateStr.substring(4, 6)) - 1;
    const day = parseInt(dateStr.substring(6, 8));
    const date = new Date(year, month, day);
    const dayOfWeek = date.getDay(); // 0 = Sunday
    const dayName = DAY_NAMES[dayOfWeek];

    return cal[dayName] === 1;
}

export function getActiveTripsForDate(gtfs: GTFSData, routeId: string, directionId: number, dateStr: string): Trip[] {
    const key = `${routeId}_${directionId}`;
    const tripIds = gtfs.tripsByRoute.get(key) || [];
    return tripIds
        .map(id => gtfs.trips.get(id)!)
        .filter(trip => trip && isServiceActiveOnDate(gtfs, trip.service_id, dateStr));
}

// ─── Haversine Distance ───

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6_371_000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}
