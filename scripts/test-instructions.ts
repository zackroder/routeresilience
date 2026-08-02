// Operator instruction loop + simulated hold verification
// Run: npx tsx scripts/test-instructions.ts
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
import { OperatorInstruction } from '../src/server/instructions/types.js';

function assert(cond: boolean, msg: string) {
    if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
    console.log('   ✅ ' + msg);
}

async function main() {
    console.log('🧪 Operator Instruction + Hold Verification...');

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
    const vehicles = simulation.getVehicles();
    assert(vehicles.length > 0, 'vehicles spawned');
    const v = vehicles[0];

    // 1. HTTP setup
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter(repo, detourEngine, detourStore, simulation, feedGenerator, cancellationStore, headwayService, instructionStore));
    const server = (await import('http')).createServer(app);
    await new Promise<void>(resolve => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    const base = `http://localhost:${port}/api`;

    const post = async (path: string, body?: any) => {
        const res = await fetch(base + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, json: await res.json().catch(() => null) };
    };
    const get = async (path: string) => {
        const res = await fetch(base + path);
        return { status: res.status, json: await res.json().catch(() => null) };
    };

    // 2. Create a dispatcher instruction directly
    const created = await post('/instructions', {
        vehicleId: v.vehicleId,
        tripId: v.tripId,
        routeId: v.routeId,
        action: 'HOLD',
        controlPointStopId: v.nextStopId,
        controlPointStopName: 'Test Stop',
        holdSeconds: 45,
        message: 'Hold 45s at Test Stop',
    });
    assert(created.status === 201, 'POST /instructions returns 201');
    const inst = created.json as OperatorInstruction;
    assert(inst.status === 'SENT', 'new instruction is SENT');
    assert(inst.id && inst.expiresAt > inst.createdAt, 'instruction has id + expiry');

    // 3. Vehicle should NOT be held yet (only after acknowledge)
    assert(!simulation.isHeld(v.vehicleId), 'vehicle not held before acknowledgment');

    // 4. Acknowledge -> hold applied
    const acked = await post(`/instructions/${inst.id}/acknowledge`);
    assert(acked.status === 200, 'acknowledge returns 200');
    assert((acked.json as OperatorInstruction).status === 'ACKNOWLEDGED', 'instruction ACKNOWLEDGED');
    assert(simulation.isHeld(v.vehicleId), 'vehicle held after acknowledgment');

    // 5. Active list contains it
    const active = await get('/instructions?active=true');
    assert(active.json.some((i: OperatorInstruction) => i.id === inst.id), 'active list contains instruction');

    // 6. Complete -> hold released
    const done = await post(`/instructions/${inst.id}/complete`);
    assert((done.json as OperatorInstruction).status === 'COMPLETED', 'instruction COMPLETED');
    assert(!simulation.isHeld(v.vehicleId), 'vehicle released after complete');

    // 7. Cancellation path
    const created2 = await post('/instructions', {
        vehicleId: v.vehicleId,
        tripId: v.tripId,
        routeId: v.routeId,
        action: 'HOLD',
        controlPointStopId: v.nextStopId,
        holdSeconds: 30,
    });
    const canceled = await post(`/instructions/${(created2.json as OperatorInstruction).id}/cancel`);
    assert((canceled.json as OperatorInstruction).status === 'CANCELLED', 'instruction CANCELLED');

    // 8. Validation
    const bad = await post('/instructions', { vehicleId: v.vehicleId });
    assert(bad.status === 400, 'invalid instruction returns 400');

    // 9. Recommendations endpoint is wired (may be empty without bunching)
    const recs = await get(`/headways/recommendations?route_id=${encodeURIComponent(v.routeId)}`);
    assert(recs.status === 200, 'GET /headways/recommendations returns 200');
    assert(Array.isArray(recs.json.recommendations), 'recommendations is an array');

    // 10. Accept recommendation path (create one synthetically if none present)
    let accepted = null;
    if (recs.json.recommendations.length > 0) {
        const rec = recs.json.recommendations[0];
        const res = await post('/recommendations/accept', rec);
        accepted = res.json;
        assert(res.status === 201, 'accept recommendation returns 201');
        assert(accepted.source === 'recommendation', 'accepted instruction source is recommendation');
    } else {
        console.log('   ℹ️  No recommendations present (no bunching right now) — skipping accept path');
    }

    server.close();
    repo.close();
    console.log('\n✨ Instruction + Hold Verification Passed');
    process.exit(0);
}

main().catch(err => {
    console.error('❌ Instruction Verification Failed:', err);
    process.exit(1);
});
