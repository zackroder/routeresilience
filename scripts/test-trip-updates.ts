
import protobuf from 'protobufjs';
import path from 'path';

const API_BASE = 'http://localhost:3001/api';
const PROTO_PATH = path.resolve(process.cwd(), 'proto', 'gtfs-realtime.proto');

async function main() {
    console.log('Starting Trip Update Verification...');

    try {
        // 1. Find a candidate route and stops
        const routesRes = await fetch(`${API_BASE}/routes`);
        const routes = await routesRes.json();
        if (routes.length === 0) throw new Error('No routes found');

        const route = routes[0];
        console.log(`Selected Route: ${route.route_short_name} (${route.route_id})`);

        const stopsRes = await fetch(`${API_BASE}/routes/${route.route_id}/stops?direction=0`);
        const stops = await stopsRes.json();
        if (stops.length < 10) throw new Error('Not enough stops on route');

        const startStop = stops[2];
        const endStop = stops[6];
        console.log(`Detour from ${startStop.stop_name} (${startStop.stop_id}) to ${endStop.stop_name} (${endStop.stop_id})`);

        // 2. Create Detour
        const now = new Date();
        const endTime = new Date(now.getTime() + 3600 * 1000); // +1 hour

        const detourReq = {
            routeId: route.route_id,
            directionId: 0,
            startStopId: startStop.stop_id,
            endStopId: endStop.stop_id,
            startTime: now.toISOString(),
            endTime: endTime.toISOString(),
            detourShape: [], // Empty shape for test
            replacementStops: [
                { stopId: 'TEMP_1', stopName: 'Temporary Stop', lat: startStop.stop_lat + 0.001, lon: startStop.stop_lon + 0.001, isTemporary: true, travelTimeFromPrevious: 60 }
            ],
            description: 'Test Detour'
        };

        console.log('Creating detour...');
        const createRes = await fetch(`${API_BASE}/detours`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(detourReq)
        });

        if (!createRes.ok) {
            throw new Error(`Failed to create detour: ${createRes.statusText}`);
        }
        const detour = await createRes.json();
        console.log(`Detour created: ${detour.id}`);

        // 3. Verify in GTFS-RT
        console.log('Fetching GTFS-RT feed...');
        const feedRes = await fetch(`${API_BASE}/gtfs-rt`);
        const buffer = await feedRes.arrayBuffer();
        const ui8 = new Uint8Array(buffer);

        const root = await protobuf.load(PROTO_PATH);
        const FeedMessage = root.lookupType('transit_realtime.FeedMessage');
        const message = FeedMessage.decode(ui8);
        const obj = FeedMessage.toObject(message, { enums: String });

        // Find a trip affected by this detour
        // We look for any TripUpdate with scheduleRelationship = REPLACEMENT (5)
        // Or check if replacement stops are present

        let found = false;
        if (obj.entity) {
            for (const entity of obj.entity) {
                if (entity.tripUpdate) {
                    const tu = entity.tripUpdate;
                    if (tu.trip.routeId === route.route_id && tu.trip.scheduleRelationship === 'REPLACEMENT') {
                        console.log(`\nFound Modified Trip: ${tu.trip.tripId}`);
                        console.log(`Relationship: ${tu.trip.scheduleRelationship}`);

                        // Check stops
                        const hasTempStop = tu.stopTimeUpdate.some((stu: any) => stu.stopId === 'TEMP_1');
                        if (hasTempStop) {
                            console.log('✅ Temporary stop found in TripUpdate');
                            found = true;
                            // break; // Keep looking to see how many (optional)
                        } else {
                            console.warn('⚠️ Trip marked REPLACEMENT but TEMP_1 not found in updates?');
                        }
                    }
                }
            }
        }

        if (found) {
            console.log('\n✅ TripUpdate verification PASSED.');
        } else {
            console.error('\n❌ TripUpdate verification FAILED: No REPLACEMENT trips found with temp stop.');
            // Don't exit 1 yet, try to clean up
        }

        // 4. Cleanup
        console.log('Cleaning up detour...');
        await fetch(`${API_BASE}/detours/${detour.id}`, { method: 'DELETE' });
        console.log('Detour deleted.');

    } catch (err) {
        console.error('Test Failed:', err);
    }
}

main();
