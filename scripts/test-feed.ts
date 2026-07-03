/**
 * GTFS-RT Feed Structure Test
 *
 * Fetches the GTFS-RT protobuf feed, decodes it, and asserts:
 *   - Header timestamp is recent
 *   - VehiclePosition entities have valid coordinates + trip info
 *   - TripUpdate entities have ascending stop time updates
 *   - Entity counts are logged with pass/fail summary
 *
 * Usage:  npx tsx scripts/test-feed.ts
 * Requires: Server running on localhost:4000 with SIMULATION_DEBUG_MODE=true
 */

import protobuf from 'protobufjs';
import path from 'path';

const FEED_URL = process.env.FEED_URL || 'http://localhost:4000/api/gtfs-rt';
const PROTO_PATH = path.resolve(process.cwd(), 'proto', 'gtfs-realtime.proto');

// Chicago metro bounding box for lat/lon validation
const CHICAGO_BBOX = {
    minLat: 41.6,
    maxLat: 42.1,
    minLon: -88.0,
    maxLon: -87.4,
};

interface TestResult {
    name: string;
    passed: boolean;
    detail: string;
}

async function main() {
    const results: TestResult[] = [];
    console.log('═══════════════════════════════════════════════════');
    console.log('  GTFS-RT Feed Structure Test');
    console.log('═══════════════════════════════════════════════════');
    console.log(`\nFetching: ${FEED_URL}\n`);

    try {
        const response = await fetch(FEED_URL, {
            headers: { 'X-API-Key': 'dev-key' }
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        const buffer = await response.arrayBuffer();
        const ui8 = new Uint8Array(buffer);
        console.log(`Downloaded ${ui8.length} bytes.\n`);

        // Load proto definition
        const root = await protobuf.load(PROTO_PATH);
        const FeedMessage = root.lookupType('transit_realtime.FeedMessage');

        // Decode
        const message = FeedMessage.decode(ui8);
        const obj = FeedMessage.toObject(message, {
            longs: Number,
            enums: String,
            bytes: String,
        });

        // ─── Test 1: Header ───
        console.log('─── Header ───');
        console.log(JSON.stringify(obj.header, null, 2));

        const headerTimestamp = obj.header?.timestamp;
        const nowEpoch = Math.floor(Date.now() / 1000);
        const headerAge = nowEpoch - headerTimestamp;

        results.push({
            name: 'Header timestamp is recent (< 60s old)',
            passed: headerAge >= 0 && headerAge < 60,
            detail: `Age: ${headerAge}s`,
        });

        results.push({
            name: 'GTFS-RT version is 2.0',
            passed: obj.header?.gtfsRealtimeVersion === '2.0',
            detail: `Version: ${obj.header?.gtfsRealtimeVersion}`,
        });

        // ─── Categorize entities ───
        const entities = obj.entity || [];
        let tripUpdates = 0;
        let vehiclePositions = 0;
        let alerts = 0;
        let tripModifications = 0;
        let shapes = 0;
        let stops = 0;
        let other = 0;

        for (const entity of entities) {
            if (entity.tripUpdate) tripUpdates++;
            else if (entity.vehicle) vehiclePositions++;
            else if (entity.alert) alerts++;
            else if (entity.tripModifications) tripModifications++;
            else if (entity.shape) shapes++;
            else if (entity.stop) stops++;
            else other++;
        }

        console.log(`\n─── Entity Summary ───`);
        console.log(`  Total:              ${entities.length}`);
        console.log(`  VehiclePositions:   ${vehiclePositions}`);
        console.log(`  TripUpdates:        ${tripUpdates}`);
        console.log(`  ServiceAlerts:      ${alerts}`);
        console.log(`  TripModifications:  ${tripModifications}`);
        console.log(`  Shapes:             ${shapes}`);
        console.log(`  Stops:              ${stops}`);
        if (other > 0) console.log(`  Other:              ${other}`);

        results.push({
            name: 'Feed has entities',
            passed: entities.length > 0,
            detail: `${entities.length} entities`,
        });

        // ─── Test 2: Vehicle Positions ───
        if (vehiclePositions > 0) {
            let validPositions = 0;
            let invalidPositions: string[] = [];

            for (const entity of entities) {
                if (!entity.vehicle) continue;
                const vp = entity.vehicle;

                const lat = vp.position?.latitude;
                const lon = vp.position?.longitude;
                const tripId = vp.trip?.tripId;
                const routeId = vp.trip?.routeId;
                const speed = vp.position?.speed;

                const hasValidCoords = lat >= CHICAGO_BBOX.minLat && lat <= CHICAGO_BBOX.maxLat &&
                    lon >= CHICAGO_BBOX.minLon && lon <= CHICAGO_BBOX.maxLon;
                const hasTrip = !!tripId && !!routeId;

                if (hasValidCoords && hasTrip) {
                    validPositions++;
                } else {
                    if (invalidPositions.length < 3) {
                        invalidPositions.push(
                            `${vp.vehicle?.id}: lat=${lat}, lon=${lon}, trip=${tripId}, route=${routeId}`
                        );
                    }
                }
            }

            results.push({
                name: 'All VehiclePositions have valid coordinates',
                passed: validPositions === vehiclePositions,
                detail: `${validPositions}/${vehiclePositions} valid` +
                    (invalidPositions.length > 0 ? ` | Examples: ${invalidPositions.join('; ')}` : ''),
            });

            console.log('\n─── Sample VehiclePosition ───');
            const sample = entities.find((e: any) => e.vehicle);
            console.log(JSON.stringify(sample?.vehicle, null, 2));
        }

        results.push({
            name: 'VehiclePositions present (simulation active)',
            passed: vehiclePositions > 0,
            detail: `${vehiclePositions} vehicles`,
        });

        // ─── Test 3: Trip Updates ───
        if (tripUpdates > 0) {
            let validUpdates = 0;
            let ascendingErrors = 0;

            for (const entity of entities) {
                if (!entity.tripUpdate) continue;
                const tu = entity.tripUpdate;

                const hasTrip = !!tu.trip?.tripId;
                const hasStops = tu.stopTimeUpdate && tu.stopTimeUpdate.length > 0;

                if (hasTrip && hasStops) {
                    // Verify ascending arrival times
                    let lastTime = 0;
                    let ascending = true;
                    for (const stu of tu.stopTimeUpdate) {
                        const arrTime = stu.arrival?.time || 0;
                        if (arrTime > 0 && arrTime < lastTime) {
                            ascending = false;
                            ascendingErrors++;
                            break;
                        }
                        if (arrTime > 0) lastTime = arrTime;
                    }
                    if (ascending) validUpdates++;
                }
            }

            results.push({
                name: 'TripUpdates have ascending arrival times',
                passed: ascendingErrors === 0,
                detail: `${validUpdates}/${tripUpdates} valid, ${ascendingErrors} with non-ascending times`,
            });

            console.log('\n─── Sample TripUpdate ───');
            const sample = entities.find((e: any) => e.tripUpdate);
            console.log(JSON.stringify(sample?.tripUpdate, null, 2));
        }

        results.push({
            name: 'TripUpdates present',
            passed: tripUpdates > 0,
            detail: `${tripUpdates} trip updates`,
        });

        // ─── Phase 3: OTP Compliance Checks ───
        console.log('\n─── OTP Compliance ───');

        const hasStartDate = entities.every((e: any) => {
            const trip = e.tripUpdate?.trip || e.vehicle?.trip;
            if (!trip) return true;
            return /^\d{8}$/.test(trip.startDate);
        });
        results.push({
            name: 'TripDescriptor has startDate (YYYYMMDD)',
            passed: hasStartDate,
            detail: hasStartDate ? 'Verified YYYYMMDD format' : 'Missing or invalid startDate found',
        });

        let chronologicalHops = true;
        let hopErrorDetail = '';
        for (const e of entities) {
            if (!e.tripUpdate?.stopTimeUpdate) continue;
            let lastDeparture = 0;
            for (const stu of e.tripUpdate.stopTimeUpdate) {
                const arr = stu.arrival?.time || 0;
                const dep = stu.departure?.time || 0;
                if (arr > 0 && arr < lastDeparture) {
                    chronologicalHops = false;
                    hopErrorDetail = `Trip ${e.tripUpdate.trip.tripId}: arrival ${arr} < previous departure ${lastDeparture}`;
                    break;
                }
                if (dep > 0) lastDeparture = dep;
                else if (arr > 0) lastDeparture = arr;
            }
            if (!chronologicalHops) break;
        }

        results.push({
            name: 'Strictly chronological stop times (arrival >= last departure)',
            passed: chronologicalHops,
            detail: chronologicalHops ? 'No negative hops detected' : hopErrorDetail,
        });

    } catch (err) {
        results.push({
            name: 'Feed fetch and decode',
            passed: false,
            detail: String(err),
        });
    }

    // ─── Print Summary ───
    console.log('\n═══════════════════════════════════════════════════');
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
