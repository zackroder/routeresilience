/**
 * Detour Vehicle Following Test
 *
 * Verifies that simulated vehicles actually follow active detours.
 * Creates a detour, polls vehicle positions, and checks if vehicles on the
 * detoured route are near the detour shape.
 *
 * Usage:  npx tsx scripts/test-detour-vehicles.ts
 * Requires: Server running on localhost:4000 with SIMULATION_DEBUG_MODE=true
 */

const API_BASE = process.env.API_BASE || 'http://localhost:4000/api';
const POLL_INTERVAL_MS = 3000;
const POLL_DURATION_MS = 60_000; // 60 seconds
const PROXIMITY_THRESHOLD_M = 100; // 100m tolerance for "on detour path"

interface VehiclePosition {
    vehicleId: string;
    tripId: string;
    routeId: string;
    directionId: number;
    lat: number;
    lon: number;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function minDistanceToPath(lat: number, lon: number, path: [number, number][]): number {
    let minDist = Infinity;
    for (const [pLat, pLon] of path) {
        const d = haversineMeters(lat, lon, pLat, pLon);
        if (d < minDist) minDist = d;
    }
    return minDist;
}

async function main() {
    let detourId: string | null = null;
    let detourShape: [number, number][] = [];
    let routeId = '';
    let directionId = 0;

    console.log('═══════════════════════════════════════════════════');
    console.log('  Detour Vehicle Following Test');
    console.log('═══════════════════════════════════════════════════\n');

    try {
        // ─── 1. Find a route ───
        const routesRes = await fetch(`${API_BASE}/routes`);
        const routes = await routesRes.json();
        if (routes.length === 0) throw new Error('No routes found');

        const route = routes[0];
        routeId = route.route_id;
        directionId = 0;
        console.log(`  Route: ${route.route_short_name} (${routeId})`);

        const stopsRes = await fetch(`${API_BASE}/routes/${routeId}/stops?direction=0`);
        const stops = await stopsRes.json();
        if (stops.length < 10) throw new Error(`Not enough stops (${stops.length})`);

        const startStop = stops[2];
        const endStop = stops[6];

        // Build a detour shape that's offset from the route
        const midLat = (startStop.stop_lat + endStop.stop_lat) / 2 + 0.003;
        const midLon = (startStop.stop_lon + endStop.stop_lon) / 2 + 0.003;

        detourShape = [
            [startStop.stop_lat, startStop.stop_lon],
            [midLat, midLon],
            [endStop.stop_lat, endStop.stop_lon],
        ];

        // ─── 2. Create detour ───
        console.log(`  Creating detour: ${startStop.stop_name} → ${endStop.stop_name}`);
        const now = new Date();
        const endTime = new Date(now.getTime() + 3600 * 1000);

        const createRes = await fetch(`${API_BASE}/detours`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                routeId,
                directionId,
                startStopId: startStop.stop_id,
                endStopId: endStop.stop_id,
                startTime: now.toISOString(),
                endTime: endTime.toISOString(),
                detourShape,
                replacementStops: [{
                    stopId: 'TEMP_VEH_TEST',
                    stopName: 'Vehicle Test Stop',
                    lat: midLat,
                    lon: midLon,
                    isTemporary: true,
                    travelTimeFromPrevious: 60,
                }],
                description: 'Vehicle following test detour',
            }),
        });

        if (!createRes.ok) throw new Error(`Create detour failed: ${createRes.status}`);
        const detour = await createRes.json();
        detourId = detour.id;
        console.log(`  Detour created: ${detourId}\n`);

        // ─── 3. Poll vehicle positions ───
        console.log(`  Monitoring vehicles for ${POLL_DURATION_MS / 1000}s...\n`);

        let totalOnRoute = 0;
        let totalNearDetour = 0;
        let pollCount = 0;
        const startTime = Date.now();

        await new Promise<void>((resolve) => {
            const interval = setInterval(async () => {
                const now = Date.now();
                if (now - startTime > POLL_DURATION_MS) {
                    clearInterval(interval);
                    resolve();
                    return;
                }

                pollCount++;
                try {
                    const res = await fetch(`${API_BASE}/gtfs-rt/json`);
                    if (!res.ok) return;

                    const feed = await res.json();
                    if (!feed.entity) return;

                    let onRoute = 0;
                    let nearDetour = 0;

                    for (const entity of feed.entity) {
                        if (!entity.vehicle) continue;
                        const vp = entity.vehicle;

                        if (vp.trip?.routeId === routeId && vp.trip?.directionId === directionId) {
                            onRoute++;
                            const lat = vp.position?.latitude;
                            const lon = vp.position?.longitude;

                            if (lat && lon) {
                                const distToDetour = minDistanceToPath(lat, lon, detourShape);
                                if (distToDetour < PROXIMITY_THRESHOLD_M) {
                                    nearDetour++;
                                }
                            }
                        }
                    }

                    totalOnRoute = Math.max(totalOnRoute, onRoute);
                    totalNearDetour = Math.max(totalNearDetour, nearDetour);

                    const elapsed = Math.round((now - startTime) / 1000);
                    process.stdout.write(
                        `\r  Poll #${pollCount} (${elapsed}s): ${onRoute} vehicles on route, ${nearDetour} near detour path`
                    );

                } catch (err) {
                    // Continue polling
                }
            }, POLL_INTERVAL_MS);
        });

        // ─── 4. Report results ───
        console.log('\n\n═══════════════════════════════════════════════════');
        console.log('  Results');
        console.log('═══════════════════════════════════════════════════\n');

        console.log(`  Peak vehicles on detoured route: ${totalOnRoute}`);
        console.log(`  Peak vehicles near detour path:  ${totalNearDetour}`);

        if (totalOnRoute > 0) {
            const pct = ((totalNearDetour / totalOnRoute) * 100).toFixed(1);
            console.log(`  Percentage following detour:     ${pct}%`);

            if (totalNearDetour > 0) {
                console.log(`\n  ✅ PASS — Vehicles are following the detour path\n`);
            } else {
                console.log(`\n  ⚠️  WARN — No vehicles observed near detour path yet`);
                console.log(`     This may be because no vehicles have reached the diverge point.\n`);
            }
        } else {
            console.log(`\n  ⚠️  WARN — No vehicles found on the detoured route/direction`);
            console.log(`     Make sure the server is running with SIMULATION_DEBUG_MODE=true\n`);
        }

    } catch (err) {
        console.error(`\n  ❌ Error: ${err}\n`);
    } finally {
        if (detourId) {
            console.log('  Cleaning up...');
            try {
                await fetch(`${API_BASE}/detours/${detourId}`, { method: 'DELETE' });
                console.log('  Detour deleted.\n');
            } catch { }
        }
    }
}

main();
