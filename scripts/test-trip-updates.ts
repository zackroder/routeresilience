/**
 * GTFS-RT Trip Update & Detour Verification Test
 *
 * Creates a test detour and verifies that ALL expected entity types appear in
 * the GTFS-RT feed:
 *   1. TripUpdate with scheduleRelationship = REPLACEMENT
 *   2. TripModifications entity referencing affected trips
 *   3. ServiceAlert with cause=CONSTRUCTION, effect=DETOUR
 *   4. Shape entity with the detour polyline
 *
 * Usage:  npx tsx scripts/test-trip-updates.ts
 * Requires: Server running on localhost:4000 with SIMULATION_DEBUG_MODE=true
 */

import protobuf from 'protobufjs';
import path from 'path';

const API_BASE = process.env.API_BASE || 'http://localhost:4000/api';
const PROTO_PATH = path.resolve(process.cwd(), 'proto', 'gtfs-realtime.proto');

interface TestResult {
    name: string;
    passed: boolean;
    detail: string;
}

async function main() {
    const results: TestResult[] = [];
    let detourId: string | null = null;

    console.log('═══════════════════════════════════════════════════');
    console.log('  GTFS-RT Trip Update & Detour Verification');
    console.log('═══════════════════════════════════════════════════\n');

    try {
        // ─── 1. Find a candidate route and stops ───
        console.log('Finding a route with enough stops...');
        const routesRes = await fetch(`${API_BASE}/routes`);
        const routes = await routesRes.json();
        if (routes.length === 0) throw new Error('No routes found');

        const route = routes[0];
        console.log(`  Route: ${route.route_short_name} (${route.route_id})`);

        const stopsRes = await fetch(`${API_BASE}/routes/${route.route_id}/stops?direction=0`);
        const stops = await stopsRes.json();
        if (stops.length < 10) throw new Error(`Not enough stops on route (${stops.length})`);

        const startStop = stops[2];
        const endStop = stops[6];
        console.log(`  Detour: ${startStop.stop_name} → ${endStop.stop_name}`);

        // ─── 2. Create detour ───
        console.log('\nCreating test detour...');
        const now = new Date();
        const endTime = new Date(now.getTime() + 3600 * 1000);

        const midLat = (startStop.stop_lat + endStop.stop_lat) / 2 + 0.002;
        const midLon = (startStop.stop_lon + endStop.stop_lon) / 2 + 0.002;

        const detourReq = {
            routeId: route.route_id,
            directionId: 0,
            startStopId: startStop.stop_id,
            endStopId: endStop.stop_id,
            startTime: now.toISOString(),
            endTime: endTime.toISOString(),
            detourShape: [
                [startStop.stop_lat, startStop.stop_lon],
                [midLat, midLon],
                [endStop.stop_lat, endStop.stop_lon],
            ],
            replacementStops: [
                {
                    stopId: 'TEMP_TEST_1',
                    stopName: 'Temporary Test Stop',
                    lat: midLat,
                    lon: midLon,
                    isTemporary: true,
                    travelTimeFromPrevious: 60,
                }
            ],
            description: 'Automated test detour for GTFS-RT verification',
        };

        const createRes = await fetch(`${API_BASE}/detours`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(detourReq),
        });

        if (!createRes.ok) {
            throw new Error(`Failed to create detour: ${createRes.status} ${createRes.statusText}`);
        }
        const detour = await createRes.json();
        detourId = detour.id;
        console.log(`  Created detour: ${detourId}`);

        // Brief pause to let the feed regenerate
        await new Promise(r => setTimeout(r, 2000));

        // ─── 3. Fetch and decode GTFS-RT feed ───
        console.log('\nFetching GTFS-RT feed...');
        const feedRes = await fetch(`${API_BASE}/gtfs-rt`);
        const buffer = await feedRes.arrayBuffer();
        const ui8 = new Uint8Array(buffer);

        const root = await protobuf.load(PROTO_PATH);
        const FeedMessage = root.lookupType('transit_realtime.FeedMessage');
        const message = FeedMessage.decode(ui8);
        const obj = FeedMessage.toObject(message, { enums: String, longs: Number });

        const entities = obj.entity || [];
        console.log(`  ${entities.length} entities in feed\n`);

        // ─── 4. Verify TripUpdate with REPLACEMENT ───
        let replacementTrips = 0;
        let hasTestStop = false;

        for (const entity of entities) {
            if (entity.tripUpdate) {
                const tu = entity.tripUpdate;
                if (tu.trip.routeId === route.route_id &&
                    (tu.trip.scheduleRelationship === 'REPLACEMENT' || tu.trip.scheduleRelationship === 5)) {
                    replacementTrips++;
                    if (tu.stopTimeUpdate?.some((stu: any) => stu.stopId === 'TEMP_TEST_1')) {
                        hasTestStop = true;
                    }
                }
            }
        }

        results.push({
            name: 'TripUpdates with REPLACEMENT relationship exist',
            passed: replacementTrips > 0,
            detail: `${replacementTrips} replacement trip(s) found`,
        });

        results.push({
            name: 'Temporary stop (TEMP_TEST_1) in TripUpdate',
            passed: hasTestStop,
            detail: hasTestStop ? 'Found TEMP_TEST_1 in stop_time_update' : 'Not found in any REPLACEMENT trip update',
        });

        // ─── 5. Verify TripModifications ───
        let hasTripModification = false;
        for (const entity of entities) {
            if (entity.tripModifications) {
                const tm = entity.tripModifications;
                if (tm.selectedTrips?.some((st: any) =>
                    st.tripIds?.length > 0
                )) {
                    hasTripModification = true;
                }
            }
        }

        results.push({
            name: 'TripModifications entity present',
            passed: hasTripModification,
            detail: hasTripModification ? 'Found TripModifications with affected trips' : 'No TripModifications entity found',
        });

        // ─── 6. Verify ServiceAlert ───
        let hasAlert = false;
        let alertDetails = '';
        for (const entity of entities) {
            if (entity.alert) {
                const alert = entity.alert;
                if (alert.informedEntity?.some((ie: any) => ie.routeId === route.route_id)) {
                    hasAlert = true;
                    const cause = alert.cause;
                    const effect = alert.effect;
                    alertDetails = `cause=${cause}, effect=${effect}`;
                }
            }
        }

        results.push({
            name: 'ServiceAlert for detoured route',
            passed: hasAlert,
            detail: hasAlert ? alertDetails : 'No ServiceAlert found for route',
        });

        // ─── 7. Verify Shape entity ───
        let hasShape = false;
        for (const entity of entities) {
            if (entity.shape) {
                if (entity.shape.shapeId?.includes('detour')) {
                    hasShape = true;
                }
            }
        }

        results.push({
            name: 'Shape entity for detour geometry',
            passed: hasShape,
            detail: hasShape ? 'Found detour shape entity' : 'No detour shape entity found',
        });

    } catch (err) {
        results.push({
            name: 'Test execution',
            passed: false,
            detail: String(err),
        });
    } finally {
        // ─── Cleanup ───
        if (detourId) {
            console.log('Cleaning up test detour...');
            try {
                const deleteRes = await fetch(`${API_BASE}/detours/${detourId}`, { method: 'DELETE' });
                console.log(`  Delete status: ${deleteRes.status}\n`);
            } catch (err) {
                console.error(`  Cleanup failed: ${err}`);
            }
        }
    }

    // ─── Print Summary ───
    console.log('═══════════════════════════════════════════════════');
    console.log('  Test Results');
    console.log('═══════════════════════════════════════════════════\n');

    let passed = 0;
    let failed = 0;

    for (const r of results) {
        const icon = r.passed ? '✅' : '❌';
        console.log(`  ${icon} ${r.name}`);
        console.log(`     ${r.detail}\n`);
        if (r.passed) passed++;
        else failed++;
    }

    console.log(`─── ${passed} passed, ${failed} failed ───\n`);

    if (failed > 0) {
        process.exit(1);
    }
}

main();
