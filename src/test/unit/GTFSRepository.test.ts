import { GTFSRepository } from '../../server/gtfs/database.js';
import { loadGTFS } from '../../server/gtfs/loader.js';
import path from 'path';
import fs from 'fs';

async function runTests() {
    console.log('🧪 Starting GTFSRepository Unit Tests...');

    // Ensure DB exists or load it (using loader logic for test setup)
    const dbPath = path.resolve(process.cwd(), 'data', 'gtfs.db');
    let repo: GTFSRepository;

    // Always use loadGTFS, which handles "exists but empty" by importing,
    // and "exists and populated" by skipping import.
    repo = await loadGTFS();

    try {
        // Test 1: Basic Counts
        console.log('\n[Test 1] Basic Data Integrity');
        const routes = repo.getAllRoutes();
        const stops = repo.getAllStops();
        console.log(`   Routes: ${routes.length}`);
        console.log(`   Stops: ${stops.length}`);

        if (routes.length === 0 || stops.length === 0) {
            throw new Error('Database is empty!');
        }
        console.log('   ✅ Basic counts OK');

        // Test 2: Active Trips Query
        console.log('\n[Test 2] getActiveTrips Query');
        // Pick a date that likely has service (e.g. current date or known date)
        const now = new Date();
        const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
        const timeSeconds = 12 * 3600; // Noon

        console.log(`   Querying for ${dateStr} at 12:00:00 (${timeSeconds}s)`);
        const activeTrips = repo.getActiveTrips(dateStr, timeSeconds);
        console.log(`   Active trips found: ${activeTrips.length}`);

        if (activeTrips.length > 0) {
            const sample = activeTrips[0];
            console.log(`   Sample Trip: ${sample.trip_id} (Route ${sample.route_id})`);
            const stopTimes = repo.getStopTimes(sample.trip_id);
            console.log(`   Stop Times: ${stopTimes.length} stops`);
            console.log(`   Start: ${stopTimes[0].departure_time}, End: ${stopTimes[stopTimes.length - 1].arrival_time}`);
        } else {
            console.warn('   ⚠️ No active trips found (might be expected if no service today, or late at night)');
        }
        console.log('   ✅ Active trips query ran without error');

        // Test 3: Shape Retrieval
        console.log('\n[Test 3] Shape Retrieval');
        if (routes.length > 0) {
            // Get a trip from first route
            const trips = repo.getTripsForRoute(routes[0].route_id, 0);
            if (trips.length > 0 && trips[0].shape_id) {
                const shape = repo.getShape(trips[0].shape_id);
                console.log(`   Shape ${trips[0].shape_id} has ${shape.length} points`);
                if (shape.length === 0) throw new Error('Shape points missing');
            }
        }
        console.log('   ✅ Shape retrieval OK');

        // Test 4: Spatial Query
        console.log('\n[Test 4] Spatial Query (getStopsInBounds)');
        // Bounds for Chicago roughly
        const stopsInChicago = repo.getStopsInBounds(41.8, -87.7, 42.0, -87.5);
        console.log(`   Stops in Chicago bounds: ${stopsInChicago.length}`);
        console.log('   ✅ Spatial query OK');

    } catch (err) {
        console.error('❌ Test Failed:', err);
        process.exit(1);
    } finally {
        repo.close();
        console.log('\n✨ All Tests Completed');
    }
}

runTests();
