import { parse } from 'csv-parse';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import unzipper from 'unzipper';
import { GTFSRepository } from './database.js';

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

async function extractZip(zipPath: string, destDir: string): Promise<void> {
    fs.mkdirSync(destDir, { recursive: true });
    await fs.createReadStream(zipPath)
        .pipe(unzipper.Extract({ path: destDir }))
        .promise();
}

// ─── Parse CSV Stream ───

function parseCSVStream(filePath: string, onRecord: (record: any) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(filePath)) {
            console.warn(`GTFS file not found: ${filePath}`);
            resolve();
            return;
        }
        
        const parser = parse({
            columns: true,
            skip_empty_lines: true,
            trim: true,
            cast: false,
            bom: true
        });

        parser.on('readable', function() {
            let record;
            while ((record = parser.read()) !== null) {
                onRecord(record);
            }
        });

        parser.on('error', reject);
        parser.on('end', resolve);
        
        fs.createReadStream(filePath).pipe(parser);
    });
}

// ─── Main Loader ───

export async function loadGTFS(): Promise<GTFSRepository> {
    // Download and Extract
    if (!fs.existsSync(GTFS_ZIP_PATH)) {
        console.log('Downloading CTA GTFS feed...');
        await downloadFile(CTA_GTFS_URL, GTFS_ZIP_PATH);
        console.log('Download complete.');
    }

    const requiredFiles = ['routes.txt', 'trips.txt', 'stops.txt', 'stop_times.txt', 'shapes.txt', 'calendar.txt'];
    const missingFiles = requiredFiles.some(f => !fs.existsSync(path.join(GTFS_EXTRACTED_DIR, f)));

    if (!fs.existsSync(GTFS_EXTRACTED_DIR) || missingFiles) {
        console.log('Extracting GTFS feed...');
        await extractZip(GTFS_ZIP_PATH, GTFS_EXTRACTED_DIR);
        console.log('Extraction complete.');
    }

    const DB_PATH = path.join(DATA_DIR, 'gtfs.db');
    const dbExists = fs.existsSync(DB_PATH);
    console.log(`  [GTFS] DB_PATH=${DB_PATH} exists=${dbExists}`);
    
    if (dbExists) {
        const stat = fs.statSync(DB_PATH);
        console.log(`  [GTFS] DB size=${(stat.size / 1024 / 1024).toFixed(1)}MB`);
    }

    // Open in readonly mode initially to prevent Docker overlayFS from copying the 700MB file on boot
    console.log(`  [GTFS] Opening database (readonly=${dbExists})...`);
    const openStart = Date.now();
    let repo = new GTFSRepository({ readonly: dbExists });
    console.log(`  [GTFS] Database opened in ${Date.now() - openStart}ms`);
    let db = repo.getDb();

    // Check if DB is populated (O(1) instead of O(N) full table scan)
    console.log('  [GTFS] Running population check...');
    const checkStart = Date.now();
    const routeCheck = db.prepare('SELECT 1 FROM routes LIMIT 1').get();
    const tripCheck = db.prepare('SELECT 1 FROM trips LIMIT 1').get();
    const stCheck = db.prepare('SELECT 1 FROM stop_times LIMIT 1').get();
    console.log(`  [GTFS] Population check done in ${Date.now() - checkStart}ms (routes=${!!routeCheck} trips=${!!tripCheck} stop_times=${!!stCheck})`);

    if (routeCheck && tripCheck && stCheck) {
        console.log('GTFS database already populated. skipping import.');
        return repo;
    } else {
        console.log('GTFS database is empty or corrupted. Rebuilding...');
        repo.close();
        repo = new GTFSRepository({ clear: true, readonly: false });
        db = repo.getDb();
    }

    const gtfsPath = (file: string) => path.join(GTFS_EXTRACTED_DIR, file);
    console.log('Importing GTFS data into SQLite using async streams...');
    const startTime = Date.now();

    // Optimize SQLite for bulk inserts while strictly adhering to Fly.io 512MB VM limits
    db.pragma('synchronous = OFF');
    db.pragma('temp_store = MEMORY');
    db.pragma('cache_size = -16000'); // 16MB cache (safe budget for 512MB Fly.io container)

    // Drop indexes to speed up bulk inserts
    db.exec(`
        DROP INDEX IF EXISTS idx_trips_route_dir;
        DROP INDEX IF EXISTS idx_trips_service;
        DROP INDEX IF EXISTS idx_trips_starttime;
        DROP INDEX IF EXISTS idx_trips_endtime;
        DROP INDEX IF EXISTS idx_stops_loc;
        DROP INDEX IF EXISTS idx_st_trip;
        DROP INDEX IF EXISTS idx_st_stop;
        DROP INDEX IF EXISTS idx_shapes_id;
    `);

    db.exec('BEGIN TRANSACTION');

    try {
        // 1. Routes
        let routeCountInserted = 0;
        const validRouteIds = new Set<string>();
        const insertRoute = db.prepare(`
            INSERT INTO routes (route_id, agency_id, route_short_name, route_long_name, route_type, route_color, route_text_color)
            VALUES (@route_id, @agency_id, @route_short_name, @route_long_name, @route_type, @route_color, @route_text_color)
        `);

        await parseCSVStream(gtfsPath('routes.txt'), (r) => {
            if (parseInt(r.route_type) === 3) {
                validRouteIds.add(r.route_id);
                insertRoute.run({
                    route_id: r.route_id,
                    agency_id: r.agency_id || '',
                    route_short_name: r.route_short_name || '',
                    route_long_name: r.route_long_name || '',
                    route_type: 3,
                    route_color: r.route_color || '0000FF',
                    route_text_color: r.route_text_color || 'FFFFFF'
                });
                routeCountInserted++;
            }
        });
        console.log(`Imported ${routeCountInserted} routes`);

        // 2. Trips
        const validTripIds = new Set<string>();
        const validShapeIds = new Set<string>();
        const insertTrip = db.prepare(`
            INSERT INTO trips (trip_id, route_id, service_id, direction_id, direction, trip_headsign, shape_id, block_id)
            VALUES (@trip_id, @route_id, @service_id, @direction_id, @direction, @trip_headsign, @shape_id, @block_id)
        `);

        await parseCSVStream(gtfsPath('trips.txt'), (t) => {
            if (!validRouteIds.has(t.route_id)) return;
            validTripIds.add(t.trip_id);
            if (t.shape_id) validShapeIds.add(t.shape_id);

            insertTrip.run({
                trip_id: t.trip_id,
                route_id: t.route_id,
                service_id: t.service_id,
                direction_id: parseInt(t.direction_id) || 0,
                direction: t.direction || '',
                trip_headsign: t.trip_headsign || '',
                shape_id: t.shape_id || '',
                block_id: t.block_id || ''
            });
        });
        console.log(`Imported ${validTripIds.size} trips`);

        // 3. Stops
        let stopCountInserted = 0;
        const insertStop = db.prepare(`
            INSERT INTO stops (stop_id, stop_name, stop_lat, stop_lon, stop_code, location_type, parent_station)
            VALUES (@stop_id, @stop_name, @stop_lat, @stop_lon, @stop_code, @location_type, @parent_station)
        `);

        await parseCSVStream(gtfsPath('stops.txt'), (s) => {
            insertStop.run({
                stop_id: s.stop_id,
                stop_name: s.stop_name || '',
                stop_lat: parseFloat(s.stop_lat),
                stop_lon: parseFloat(s.stop_lon),
                stop_code: s.stop_code || '',
                location_type: parseInt(s.location_type) || 0,
                parent_station: s.parent_station || ''
            });
            stopCountInserted++;
        });
        console.log(`Imported ${stopCountInserted} stops`);

        // 4. Stop Times
        let stCountInserted = 0;
        const insertStopTime = db.prepare(`
            INSERT INTO stop_times (trip_id, arrival_time, departure_time, stop_id, stop_sequence, pickup_type, drop_off_type, shape_dist_traveled)
            VALUES (@trip_id, @arrival_time, @departure_time, @stop_id, @stop_sequence, @pickup_type, @drop_off_type, @shape_dist_traveled)
        `);

        const parseTime = (t: string) => {
            if (!t) return 0;
            const [h, m, s] = t.split(':').map(Number);
            return h * 3600 + m * 60 + s;
        };

        const tripBoundsMap = new Map<string, { minTime: number; maxTime: number; minSeq: number; maxSeq: number; firstStopId: string; lastStopId: string }>();

        await parseCSVStream(gtfsPath('stop_times.txt'), (st) => {
            if (!validTripIds.has(st.trip_id)) return;

            const arrTime = parseTime(st.arrival_time);
            const depTime = parseTime(st.departure_time);
            const seq = parseInt(st.stop_sequence);

            insertStopTime.run({
                trip_id: st.trip_id,
                arrival_time: arrTime,
                departure_time: depTime,
                stop_id: st.stop_id,
                stop_sequence: seq,
                pickup_type: parseInt(st.pickup_type) || 0,
                drop_off_type: parseInt(st.drop_off_type) || 0,
                shape_dist_traveled: parseFloat(st.shape_dist_traveled) || 0
            });
            stCountInserted++;

            const bound = tripBoundsMap.get(st.trip_id);
            if (!bound) {
                tripBoundsMap.set(st.trip_id, {
                    minTime: arrTime,
                    maxTime: depTime,
                    minSeq: seq,
                    maxSeq: seq,
                    firstStopId: st.stop_id,
                    lastStopId: st.stop_id,
                });
            } else {
                if (arrTime < bound.minTime) bound.minTime = arrTime;
                if (depTime > bound.maxTime) bound.maxTime = depTime;
                if (seq < bound.minSeq) {
                    bound.minSeq = seq;
                    bound.firstStopId = st.stop_id;
                }
                if (seq > bound.maxSeq) {
                    bound.maxSeq = seq;
                    bound.lastStopId = st.stop_id;
                }
            }
        });
        console.log(`Imported ${stCountInserted} stop times`);

        // 5. Shapes
        let shapeCountInserted = 0;
        const insertShape = db.prepare(`
            INSERT INTO shapes (shape_id, shape_pt_lat, shape_pt_lon, shape_pt_sequence, shape_dist_traveled)
            VALUES (@shape_id, @shape_pt_lat, @shape_pt_lon, @shape_pt_sequence, @shape_dist_traveled)
        `);

        await parseCSVStream(gtfsPath('shapes.txt'), (sp) => {
            if (!validShapeIds.has(sp.shape_id)) return;

            insertShape.run({
                shape_id: sp.shape_id,
                shape_pt_lat: parseFloat(sp.shape_pt_lat),
                shape_pt_lon: parseFloat(sp.shape_pt_lon),
                shape_pt_sequence: parseInt(sp.shape_pt_sequence),
                shape_dist_traveled: parseFloat(sp.shape_dist_traveled) || 0
            });
            shapeCountInserted++;
        });
        console.log(`Imported ${shapeCountInserted} shape points`);

        // 6. Calendar & Calendar Dates
        const insertCalendar = db.prepare(`
            INSERT INTO calendar (service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date)
            VALUES (@service_id, @monday, @tuesday, @wednesday, @thursday, @friday, @saturday, @sunday, @start_date, @end_date)
        `);

        await parseCSVStream(gtfsPath('calendar.txt'), (c) => {
            insertCalendar.run({
                service_id: c.service_id,
                monday: parseInt(c.monday),
                tuesday: parseInt(c.tuesday),
                wednesday: parseInt(c.wednesday),
                thursday: parseInt(c.thursday),
                friday: parseInt(c.friday),
                saturday: parseInt(c.saturday),
                sunday: parseInt(c.sunday),
                start_date: c.start_date,
                end_date: c.end_date
            });
        });

        const insertCalendarDate = db.prepare(`
            INSERT INTO calendar_dates (service_id, date, exception_type)
            VALUES (@service_id, @date, @exception_type)
        `);

        await parseCSVStream(gtfsPath('calendar_dates.txt'), (cd) => {
            insertCalendarDate.run({
                service_id: cd.service_id,
                date: cd.date,
                exception_type: parseInt(cd.exception_type)
            });
        });
        console.log('Imported calendars');

        // 7. Update Directions JSON in Routes
        console.log('Inferring route directions...');
        const routes = db.prepare('SELECT route_id FROM routes').all() as { route_id: string }[];
        const updateRoute = db.prepare('UPDATE routes SET directions = ? WHERE route_id = ?');

        for (const r of routes) {
            const directions: { [key: number]: string } = {};
            for (const dir of [0, 1]) {
                const trips = db.prepare('SELECT direction FROM trips WHERE route_id = ? AND direction_id = ? LIMIT 50').all(r.route_id, dir) as { direction: string }[];

                const counts: { [key: string]: number } = {};
                for (const t of trips) {
                    if (t.direction) counts[t.direction] = (counts[t.direction] || 0) + 1;
                }

                let best = '';
                let max = 0;
                for (const [name, count] of Object.entries(counts)) {
                    if (count > max) { max = count; best = name; }
                }
                if (best) directions[dir] = best;
            }
            if (Object.keys(directions).length > 0) {
                updateRoute.run(JSON.stringify(directions), r.route_id);
            }
        }

        // 8. Update Trip Start/End Times and Stop IDs
        console.log('Updating trip start/end times and stop IDs...');
        const updateTripInfo = db.prepare(`
            UPDATE trips 
            SET start_time = @startTime, end_time = @endTime, start_stop_id = @startStopId, end_stop_id = @endStopId
            WHERE trip_id = @tripId
        `);
        for (const [tripId, bound] of tripBoundsMap.entries()) {
            updateTripInfo.run({
                tripId,
                startTime: bound.minTime,
                endTime: bound.maxTime,
                startStopId: bound.firstStopId,
                endStopId: bound.lastStopId,
            });
        }

        // COMMIT the huge transaction
        db.exec('COMMIT');

        console.log('Rebuilding database indexes...');
        const indexStart = Date.now();
        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_trips_route_dir ON trips(route_id, direction_id);
            CREATE INDEX IF NOT EXISTS idx_trips_service ON trips(service_id);
            CREATE INDEX IF NOT EXISTS idx_trips_starttime ON trips(start_time);
            CREATE INDEX IF NOT EXISTS idx_trips_endtime ON trips(end_time);
            CREATE INDEX IF NOT EXISTS idx_stops_loc ON stops(stop_lat, stop_lon);
            CREATE INDEX IF NOT EXISTS idx_st_trip ON stop_times(trip_id);
            CREATE INDEX IF NOT EXISTS idx_st_stop ON stop_times(stop_id);
            CREATE INDEX IF NOT EXISTS idx_shapes_id ON shapes(shape_id);
        `);
        console.log(`Indexes built in ${Date.now() - indexStart}ms`);

        // Restore safe pragmas
        db.pragma('synchronous = NORMAL');
        db.pragma('cache_size = -2000');

    } catch (err) {
        db.exec('ROLLBACK');
        console.error('Error during GTFS import, rolling back:', err);
        throw err;
    }

    console.log(`GTFS import complete in ${Date.now() - startTime}ms`);
    return repo;
}

// ─── Helpers ───

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
