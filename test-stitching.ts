import { GTFSRepository } from './src/server/gtfs/database.js';
import { DetourEngine } from './src/server/detour/engine.js';
import { DetourStore } from './src/server/detour/store.js';

const repo = new GTFSRepository();
const store = new DetourStore();
const engine = new DetourEngine(repo, store);

// Mock a detour on Route 49 (Western)
// Western & Hubbard (stop_id: 8196) -> Western & Roosevelt (stop_id: 8159)
const detourReq = {
    routeId: '49',
    directionId: 1, // Southbound?
    startStopId: '8196',
    endStopId: '8159',
    replacementStops: [
        { stopId: 'TEMP_1', stopName: 'Temp Stop', lat: 41.89, lon: -87.69, isTemporary: true, travelTimeFromPrevious: 120 }
    ],
    detourShape: [
        [41.895, -87.69],
        [41.89, -87.69]
    ],
    startTime: new Date().toISOString(),
    endTime: new Date(Date.now() + 3600000).toISOString(),
    description: 'Test Detour'
};

const detour = engine.createDetour(detourReq);
console.log('Detour ID:', detour.id);
console.log('Stitched path points:', detour.path?.length);

if (detour.path && detour.path.length > 10) {
    console.log('First 5 points:', JSON.stringify(detour.path.slice(0, 5)));
    console.log('Last 5 points:', JSON.stringify(detour.path.slice(-5)));

    // Check for "jumps" - distance between consecutive points should be small
    let anomalies = 0;
    for (let i = 1; i < detour.path.length; i++) {
        const p1 = detour.path[i - 1];
        const p2 = detour.path[i];
        const dist = Math.sqrt(Math.pow(p1[0] - p2[0], 2) + Math.pow(p1[1] - p2[1], 2));
        if (dist > 0.05) { // Roughly 5km jump
            console.warn(`Anomaly at index ${i}: distance ${dist}`);
            anomalies++;
        }
    }
    console.log(`Total anomalies: ${anomalies}`);
}

const modified = engine.computeModifiedTrip('some_trip_id', detour);
// Need a real trip id
const trips = repo.getTripsForRoute('49', 1);
if (trips.length > 0) {
    const mod = engine.computeModifiedTrip(trips[0].trip_id, detour);
    if (mod) {
        console.log('Modified stop sequences:', mod.modifiedStopTimes.map(ms => `${ms.stopId}:${ms.stopSequence}`).join(', '));
    }
}
