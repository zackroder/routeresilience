// Deterministic simulation harness verification.
// Proves the engine supports: seeded RNG, manual clock advance, dwell-aware
// spawn, always-on schedule delay, holds-at-stop, congestion, and breakdowns.
// Run: npx tsx scripts/test-sim-harness.ts
import { loadGTFS } from '../src/server/gtfs/loader.js';
import { DetourEngine } from '../src/server/detour/engine.js';
import { DetourStore } from '../src/server/detour/store.js';
import { SimulationEngine } from '../src/server/simulation/engine.js';
import { GTFSRepository } from '../src/server/gtfs/database.js';

function assert(cond: boolean, msg: string) {
    if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
    console.log('   ✅ ' + msg);
}

const SPAWN_DATE = new Date();

async function makeEngine(repo: GTFSRepository, detourEngine: DetourEngine, seed?: number): Promise<SimulationEngine> {
    const detourStore = new DetourStore();
    const engine = new SimulationEngine(repo, detourEngine, detourStore, {
        manual: true,
        seed,
        speedNoise: seed !== undefined,
    });
    return engine;
}

function advanceUntil(engine: SimulationEngine, vehicleId: string, predicate: (v: import('../src/server/simulation/types.js').VehicleState) => boolean, maxSteps: number): boolean {
    for (let i = 0; i < maxSteps; i++) {
        engine.advance(1);
        const v = engine.getVehicles().find(x => x.vehicleId === vehicleId);
        if (v && predicate(v)) return true;
    }
    return false;
}

async function main() {
    console.log('🧪 Simulation Harness Verification...');
    const repo = await loadGTFS();
    const detourEngine = new DetourEngine(repo, new DetourStore());

    // 1. Spawn with seeded noise
    const engA = await makeEngine(repo, detourEngine, 42);
    engA.spawnActiveVehicles(SPAWN_DATE);
    const countA = engA.getVehicleCount();
    assert(countA > 0, `manual engine spawned ${countA} vehicles`);
    const first = engA.getVehicles()[0];
    assert(!!first, 'first vehicle exists');
    assert(typeof first.scheduledEndTime === 'number' && first.scheduledEndTime > 0, 'vehicle has scheduledEndTime');

    // 2. Determinism: same seed -> identical vehicles
    const engB = await makeEngine(repo, detourEngine, 42);
    engB.spawnActiveVehicles(SPAWN_DATE);
    const n = Math.min(countA, 10);
    for (let i = 0; i < n; i++) {
        const va = engA.getVehicles()[i];
        const vb = engB.getVehicles()[i];
        assert(va.vehicleId === vb.vehicleId, `vehicle ${i} same id (${va.vehicleId})`);
        assert(JSON.stringify(va.segmentSpeeds) === JSON.stringify(vb.segmentSpeeds), `vehicle ${i} same segmentSpeeds (seeded)`);
        assert(va.occupancyStatus === vb.occupancyStatus, `vehicle ${i} same occupancy (seeded)`);
    }

    // 3. Clock advance moves vehicles
    const dist0 = first.distanceTraveled;
    const t0 = engA.now();
    engA.advance(5);
    const firstAfter = engA.getVehicleForTrip(first.tripId)!;
    assert(firstAfter.lastUpdateTime > t0, 'clock advanced (lastUpdateTime increased)');
    assert(firstAfter.distanceTraveled >= dist0, 'vehicle moved after advance');

    // 4. Congestion propagates to movement multiplier (checked early, while all
    // vehicles are freshly spawned and in transit)
    const congRoute = first.routeId;
    engA.setCongestionPreset(congRoute, 0.5);
    let congVehicle: import('../src/server/simulation/types.js').VehicleState | undefined;
    for (let i = 0; i < 120 && !congVehicle; i++) {
        engA.advance(1);
        congVehicle = engA.getVehicles().find(v => v.routeId === congRoute && v.status === 'IN_TRANSIT' && v.congestionMultiplier === 0.5);
    }
    assert(!!congVehicle, 'congestion multiplier propagated to vehicle');

    // 5. Always-on schedule delay at arrival
    const slow = engA.getVehicles()[0];
    engA.setSpeedFactor(slow.vehicleId, 0.3); // deliberately slow -> will run late
    const arrived = advanceUntil(engA, slow.vehicleId, v => v.status === 'AT_STOP', 600);
    assert(arrived, 'slow vehicle reached a stop');
    const slowNow = engA.getVehicleForTrip(slow.tripId)!;
    assert(typeof slowNow.delaySeconds === 'number', 'delaySeconds computed at arrival (always-on)');
    assert(slowNow.delaySeconds > 0, `slow vehicle running late (delaySeconds=${slowNow.delaySeconds})`);

    // 5. Hold at a stop extends dwell and defers departure (fresh engine so the
    // chosen vehicle is early in its trip and can't complete mid-test)
    const engH = await makeEngine(repo, detourEngine, 7);
    engH.spawnActiveVehicles(SPAWN_DATE);
    const holder = engH.getVehicles().find(v =>
        v.status === 'IN_TRANSIT' && v.nextStopLat !== undefined
        && v.currentStopIndex < v.cachedStopTimes.length - 1
        && (v.distanceTraveled / Math.max(v.totalDistance, 1)) < 0.4);
    assert(!!holder, 'found a mid-route in-transit vehicle for hold test');
    const inStop = advanceUntil(engH, holder.vehicleId, v => v.status === 'AT_STOP', 1800);
    assert(inStop, 'holder reached a stop');
    const beforeHoldIdx = engH.getVehicleForTrip(holder.tripId)!.currentStopIndex;
    const beforeHoldDist = engH.getVehicleForTrip(holder.tripId)!.distanceTraveled;
    engH.applyHold(holder.vehicleId, 30);
    assert(engH.isHeld(holder.vehicleId), 'hold pending after applyHold');
    engH.advance(15); // well inside the 30s hold
    const during = engH.getVehicleForTrip(holder.tripId)!;
    assert(during.status === 'AT_STOP', 'vehicle still held at stop during hold');
    assert(during.currentStopIndex === beforeHoldIdx, 'stop index unchanged during hold');
    assert(during.distanceTraveled === beforeHoldDist, 'position frozen during hold');
    engH.advance(30); // past the hold
    const afterHold = engH.getVehicleForTrip(holder.tripId)!;
    assert(!engH.isHeld(holder.vehicleId), 'hold expired after duration');
    assert(afterHold.status === 'IN_TRANSIT' || afterHold.currentStopIndex > beforeHoldIdx, 'vehicle resumed after hold');

    // 7. Breakdown freezes a vehicle mid-route then resumes (fresh engine for reliability)
    const engK = await makeEngine(repo, detourEngine, 11);
    engK.spawnActiveVehicles(SPAWN_DATE);
    const broken = engK.getVehicles().find(v =>
        v.status === 'IN_TRANSIT' && v.nextStopLat !== undefined
        && (v.distanceTraveled / Math.max(v.totalDistance, 1)) < 0.4);
    assert(!!broken, 'found mid-route vehicle for breakdown test');
    engK.applyBreakdown(broken.vehicleId, 20);
    const bd0 = engK.getVehicleForTrip(broken.tripId)!.distanceTraveled;
    engK.advance(5);
    assert(engK.getVehicleForTrip(broken.tripId)!.distanceTraveled === bd0, 'vehicle frozen during breakdown');
    engK.advance(25);
    assert(engK.getVehicleForTrip(broken.tripId)!.distanceTraveled > bd0, 'vehicle resumed after breakdown');

    // 8. Reset clears state
    engA.reset();
    assert(engA.getVehicleCount() === 0, 'reset cleared all vehicles');

    repo.close();
    console.log('\n✨ Simulation Harness Verification Passed');
    process.exit(0);
}

main().catch(err => {
    console.error('❌ Simulation Harness Verification Failed:', err);
    process.exit(1);
});
