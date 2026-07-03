import { DetourStore } from './src/server/detour/store.js';
import { CancellationStore } from './src/server/detour/cancellations.js';
import * as crypto from 'crypto';

console.log("Creating new DetourStore...");
const ds = new DetourStore();
ds.add({
    id: crypto.randomUUID(),
    routeId: '1',
    directionId: 1,
    startStopId: '1',
    endStopId: '2',
    replacementStops: [],
    detourShape: [[0, 0]],
    startTime: new Date().toISOString(),
    endTime: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
    createdAt: new Date().toISOString()
});
console.log(`DetourStore size: ${ds.getAll().length}`);

console.log("Creating new CancellationStore...");
const cs = new CancellationStore();
cs.cancelTrip('test_trip');
console.log(`CancellationStore size: ${cs.getAllCancelled().length}`);

console.log("Done adding. Loading new stores to verify persistence:");
const ds2 = new DetourStore();
const cs2 = new CancellationStore();
console.log(`DetourStore size after reload: ${ds2.getAll().length}`);
console.log(`CancellationStore size after reload: ${cs2.getAllCancelled().length}`);
