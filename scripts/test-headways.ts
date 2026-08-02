// Headway Service + /api/headways verification
// Run: npx tsx scripts/test-headways.ts
import express from 'express';
import { createServer } from 'http';
import { loadGTFS } from '../src/server/gtfs/loader.js';
import { DetourEngine } from '../src/server/detour/engine.js';
import { DetourStore } from '../src/server/detour/store.js';
import { CancellationStore } from '../src/server/detour/cancellations.js';
import { SimulationEngine } from '../src/server/simulation/engine.js';
import { PredictionEngine } from '../src/server/realtime/predictions.js';
import { FeedGenerator } from '../src/server/realtime/feed.js';
import { HeadwayService } from '../src/server/headway/service.js';
import { InstructionStore } from '../src/server/instructions/store.js';
import { createApiRouter } from '../src/server/api/routes.js';

function assert(cond: boolean, msg: string) {
    if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
    console.log('   ✅ ' + msg);
}

async function main() {
    console.log('🧪 Headway Service Verification...');

    // 1. Setup full stack
    const repo = await loadGTFS();
    const detourStore = new DetourStore();
    const cancellationStore = new CancellationStore();
    const instructionStore = new InstructionStore();
    const detourEngine = new DetourEngine(repo, detourStore);
    const simulation = new SimulationEngine(repo, detourEngine, detourStore);
    const predictions = new PredictionEngine(repo, simulation);
    const headwayService = new HeadwayService(repo, simulation, predictions);
    const feedGenerator = new FeedGenerator(repo, detourEngine, detourStore, simulation, predictions, cancellationStore);

    simulation.spawnActiveVehicles(new Date());
    console.log(`   Spawned ${simulation.getVehicleCount()} vehicles`);

    // 2. Pick a route (prefer one with active vehicles)
    const routes = repo.getAllRoutes();
    assert(routes.length > 0, 'GTFS contains routes');
    const vehicleRouteIds = new Set(simulation.getVehicles().map(v => v.routeId));
    const withVehicles = routes.find(r => vehicleRouteIds.has(r.route_id));
    const testRouteId = withVehicles ? withVehicles.route_id : routes[0].route_id;
    console.log(`   Testing route ${testRouteId}${withVehicles ? ' (has active vehicles)' : ''}`);

    // 3. Direct service test
    const res = headwayService.getHeadways(testRouteId, undefined, new Date());
    assert(Array.isArray(res.vehicles), 'response has vehicles array');
    assert(Array.isArray(res.controlPoints), 'response has controlPoints array');
    assert(Array.isArray(res.topology.branches), 'response has topology.branches');
    assert(res.topology.trunk.length > 0, `full-route trunk has stops (${res.topology.trunk.length})`);
    assert(res.targetHeadwaySeconds > 0, `target headway positive (${res.targetHeadwaySeconds}s)`);
    assert(typeof res.timestamp === 'number' && res.timestamp > 0, 'response has timestamp');
    for (const v of res.vehicles) {
        assert(typeof v.axisPosition === 'number' && v.axisPosition >= 0 && v.axisPosition <= 1, 'vehicle has axisPosition in [0,1]');
        assert(typeof v.progress === 'number', 'vehicle has progress');
        assert(typeof v.leaderVehicleId === 'string' || v.leaderVehicleId === null, 'vehicle has leaderVehicleId');
        assert(typeof v.followerVehicleId === 'string' || v.followerVehicleId === null, 'vehicle has followerVehicleId');
        assert(Array.isArray(v.points), 'vehicle has points');
        for (const p of v.points) {
            assert(p.stopId && p.stopSequence > 0, 'point has stopId + stopSequence');
        }
    }
    const statuses = new Set(res.vehicles.map(v => v.headwayStatus));
    for (const s of statuses) {
        assert(['UNKNOWN', 'STALE', 'NORMAL', 'BUNCHED', 'GAPPED'].includes(s), `valid headwayStatus (${s})`);
    }
    console.log(`   Statuses observed: ${[...statuses].join(', ') || '(none)'}`);
    console.log(`   Trunk: ${res.topology.trunk.length} stops, ${res.topology.branches.length} branch(es)`);

    // Topology stability + caching: repeated calls return the same trunk
    const res2 = headwayService.getHeadways(testRouteId, undefined, new Date());
    const trunkIds = res.topology.trunk.map(cp => cp.stopId).join('>');
    const trunkIds2 = res2.topology.trunk.map(cp => cp.stopId).join('>');
    assert(trunkIds === trunkIds2, 'topology stable across calls (cached)');

    // 4. Invalid route
    let threw = false;
    try { headwayService.getHeadways('__no_such_route__'); } catch (e) { threw = (e as Error).message === 'Route not found'; }
    assert(threw, 'invalid route throws "Route not found"');

    // 5. HTTP route test
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter(repo, detourEngine, detourStore, simulation, feedGenerator, cancellationStore, headwayService, instructionStore));
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    const ok = await fetch(`http://localhost:${port}/api/headways?route_id=${encodeURIComponent(testRouteId)}`);
    const json = await ok.json();
    assert(ok.status === 200, 'GET /api/headways returns 200');
    assert(Array.isArray(json.vehicles) && Array.isArray(json.controlPoints), 'HTTP response shape correct');

    const bad = await fetch(`http://localhost:${port}/api/headways`);
    assert(bad.status === 400, 'GET /api/headways without route_id returns 400');

    const badDir = await fetch(`http://localhost:${port}/api/headways?route_id=${testRouteId}&direction=abc`);
    assert(badDir.status === 400, 'non-numeric direction returns 400');

    const notFound = await fetch(`http://localhost:${port}/api/headways?route_id=__no_such_route__`);
    assert(notFound.status === 404, 'unknown route returns 404');

    server.close();
    repo.close();
    console.log('\n✨ Headway Verification Passed');
    process.exit(0);
}

main().catch(err => {
    console.error('❌ Headway Verification Failed:', err);
    process.exit(1);
});
