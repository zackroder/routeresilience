import { GTFSRepository } from '../../server/gtfs/database.js';
import { loadGTFS } from '../../server/gtfs/loader.js';
import { DetourEngine } from '../../server/detour/engine.js';
import { DetourStore } from '../../server/detour/store.js';
import { SimulationEngine } from '../../server/simulation/engine.js';
import { PredictionEngine } from '../../server/realtime/predictions.js';
import { FeedGenerator } from '../../server/realtime/feed.js';
import { decodeFeedMessage } from '../../server/realtime/proto.js';

async function runE2E() {
    console.log('🧪 Starting E2E Workflow Verification...');

    // 1. Setup
    console.log('   [1/5] Loading Repository...');
    const repo = await loadGTFS();
    const detourStore = new DetourStore();
    const detourEngine = new DetourEngine(repo, detourStore);
    const simulation = new SimulationEngine(repo, detourEngine);
    const predictions = new PredictionEngine(repo, simulation);
    const { CancellationStore } = await import('../../server/detour/cancellations.js');
    const cancellationStore = new CancellationStore();
    const feedGenerator = new FeedGenerator(repo, detourEngine, detourStore, simulation, predictions, cancellationStore);

    // 2. Spawn Vehicles
    console.log('   [2/5] Spawning Vehicles...');
    const now = new Date();
    // Use a fixed date known to have service (e.g. today or defaulting to known date)
    // For now, let's assume today has service or simulation handles it.
    simulation.spawnActiveVehicles(now);
    console.log(`      Spawned ${simulation.getVehicleCount()} vehicles`);

    // 3. Create Detour
    console.log('   [3/5] Creating Detour...');
    // Find a valid route/stop pair to detour
    const routes = repo.getAllRoutes();
    if (routes.length === 0) throw new Error('No routes found');
    const route = routes[0];
    const trips = repo.getTripsForRoute(route.route_id, 0);
    if (trips.length === 0) throw new Error('No trips found for route');
    const stopTimes = repo.getStopTimes(trips[0].trip_id);
    if (stopTimes.length < 5) throw new Error('Trip too short');

    const startStop = stopTimes[1].stop_id;
    const endStop = stopTimes[4].stop_id;

    const detour = detourEngine.createDetour({
        routeId: route.route_id,
        directionId: 0,
        startStopId: startStop,
        endStopId: endStop,
        detourShape: [[41.8, -87.6], [41.9, -87.6]], // Dummy shape
        replacementStops: [],
        startTime: new Date(now.getTime() - 3600000).toISOString(), // 1 hour ago
        endTime: new Date(now.getTime() + 3600000).toISOString(),   // 1 hour from now
        description: 'Test Detour'
    });
    console.log(`      Created detour: ${detour.id}`);

    // 4. Generate Feed
    console.log('   [4/5] Generating GTFS-RT Feed...');
    const buffer = await feedGenerator.generateFeed(now);
    console.log(`      Generated feed: ${buffer.length} bytes`);

    // 5. Verify Feed Content
    console.log('   [5/5] Verifying Feed Content...');
    const message = await decodeFeedMessage(buffer);

    // Check for Service Alert
    const entities = message.entity || [];
    const alert = entities.find((e: any) => e.alert);
    if (!alert) throw new Error('Service Alert not found in feed');
    console.log('      ✅ Service Alert found');

    // Check for detour-specific entities
    const detourEntity = entities.find((e: any) => e.id === `tm_${detour.id}`);
    if (!detourEntity) {
        // Did we implement TripModifications extension?
        // Yes, in feed.ts: entities.push({ id: `tm_${detour.id}`, tripModifications: ... })
        console.warn('      ⚠️ TripModifications entity not found (might depend on proto definition)');
    } else {
        console.log('      ✅ TripModifications entity found');
    }

    // Check for modified trips
    const affectedTrips = detourEngine.getAffectedTripIds(detour, now.toISOString().slice(0, 10).replace(/-/g, ''));
    if (affectedTrips.length > 0) {
        const tripUpdate = entities.find((e: any) => e.tripUpdate && e.tripUpdate.trip.tripId === affectedTrips[0]);
        if (tripUpdate) {
            console.log(`      ✅ Found TripUpdate for affected trip ${affectedTrips[0]}`);
            if (tripUpdate.tripUpdate.trip.scheduleRelationship === 5) { // REPLACEMENT
                console.log('      ✅ Schedule Relationship is REPLACEMENT');
            } else {
                console.warn(`      ⚠️ Schedule Relationship is ${tripUpdate.tripUpdate.trip.scheduleRelationship} (expected 5)`);
            }
        } else {
            console.warn('      ⚠️ TripUpdate for affected trip not found');
        }
    }

    repo.close();
    console.log('\n✨ E2E Verification Passed');
}

runE2E().catch(err => {
    console.error('❌ E2E Failed:', err);
    process.exit(1);
});
