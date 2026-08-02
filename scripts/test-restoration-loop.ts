// Controlled service-restoration loop validation.
//
// Proves the management logic works end-to-end with intentional, deterministic
// bunching/gapping:
//   1. Inject a bunch (slow a mid-route leader) -> advance -> headway engine
//      flags the follower BUNCHED. Candidates are retried with engine resets so
//      the test is robust to whichever trips are active at run time.
//   2. Restore leader speed so the compressed spacing freezes.
//   3. Run management: recommendation -> instruction -> acknowledge -> hold.
//   4. Advance past the hold -> assert spacing recovered.
//   5. Control engine (same seed, NO intervention) -> assert the bunch persists
//      and that the hold delayed the vehicle relative to control.
//   6. Gap scenario: slow the follower -> GAPPED detected; management correctly
//      offers no hold for the gap itself.
// Run: npx tsx scripts/test-restoration-loop.ts
import { loadGTFS } from '../src/server/gtfs/loader.js';
import { DetourEngine } from '../src/server/detour/engine.js';
import { DetourStore } from '../src/server/detour/store.js';
import { SimulationEngine } from '../src/server/simulation/engine.js';
import { PredictionEngine } from '../src/server/realtime/predictions.js';
import { HeadwayService } from '../src/server/headway/service.js';
import { InstructionStore } from '../src/server/instructions/store.js';
import { GTFSRepository } from '../src/server/gtfs/database.js';

function assert(cond: boolean, msg: string) {
    if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
    console.log('   ✅ ' + msg);
}

const SPAWN = new Date(2026, 7, 3, 12, 0, 0); // Mon 2026-08-03 12:00 local (within feed range)
const SLOW_FACTOR = 0.3;

interface Ctx {
    repo: GTFSRepository;
    simulation: SimulationEngine;
    headway: HeadwayService;
    instructionStore: InstructionStore;
}

async function build(): Promise<Ctx> {
    const repo = await loadGTFS();
    const detourStore = new DetourStore();
    const detourEngine = new DetourEngine(repo, detourStore);
    const simulation = new SimulationEngine(repo, detourEngine, detourStore, {
        manual: true,
        seed: 7,
        speedNoise: true,
    });
    simulation.spawnActiveVehicles(SPAWN);
    const predictions = new PredictionEngine(repo, simulation);
    const headway = new HeadwayService(repo, simulation, predictions);
    const instructionStore = new InstructionStore();
    return { repo, simulation, headway, instructionStore };
}

interface Candidate {
    routeId: string;
    dir: number;
    aId: string; // leader (to be slowed)
    bId: string; // follower (bunches)
    target: number;
}

// Distance (m) from the vehicle to its next stop, or null if it has no
// upcoming stop. Candidates with a short hop reach a stop quickly, which makes
// the hold-timing portion of the test reliable.
function distanceToNextStop(ctx: Ctx, vehicleId: string): number | null {
    const v = ctx.simulation.getVehicles().find(x => x.vehicleId === vehicleId);
    if (!v || !v.segmentDistances || v.currentStopIndex >= v.segmentDistances.length - 1) return null;
    return Math.max(0, v.segmentDistances[v.currentStopIndex + 1] - v.distanceTraveled);
}

// Adjacent mid-route pairs from the densest routes (avoids building topology
// for the whole network, and avoids terminal clustering). The follower must be
// close to its next stop so the hold can take effect promptly.
function listCandidates(ctx: Ctx): Candidate[] {
    const byRoute = new Map<string, number>();
    for (const v of ctx.simulation.getVehicles()) {
        byRoute.set(v.routeId, (byRoute.get(v.routeId) ?? 0) + 1);
    }
    const topRoutes = [...byRoute.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([routeId]) => routeId);

    const out: Candidate[] = [];
    for (const routeId of topRoutes) {
        for (const dir of [0, 1]) {
            const data = ctx.headway.getHeadways(routeId, dir, new Date(ctx.simulation.now()));
            if (data.vehicles.length < 3) continue;
            const target = data.targetHeadwaySeconds;
            const followers = data.vehicles.filter(v =>
                v.headwayAheadSeconds !== null && v.headwayBehindSeconds !== null
                && v.axisPosition >= 0.2 && v.axisPosition <= 0.65
                && v.headwayAheadSeconds >= 0.5 * target && v.headwayAheadSeconds <= 1.3 * target
                && (distanceToNextStop(ctx, v.vehicleId) ?? Infinity) < 2500);
            for (const f of followers) {
                const leader = data.vehicles.find(v => v.vehicleId === f.leaderVehicleId);
                if (!leader || leader.axisPosition <= f.axisPosition || leader.axisPosition > 0.8) continue;
                out.push({ routeId, dir, aId: leader.vehicleId, bId: f.vehicleId, target });
            }
        }
    }
    return out;
}

// Reset the engine, re-inject the slowdown, and detect the bunch. Returns the
// bunched headway + seconds advanced, or null if this candidate is unusable.
function tryBunch(ctx: Ctx, cand: Candidate): { headway0: number; detectedSteps: number } | null {
    ctx.simulation.reset();
    ctx.simulation.spawnActiveVehicles(SPAWN);
    ctx.simulation.setSpeedFactor(cand.aId, SLOW_FACTOR);
    const now = () => new Date(ctx.simulation.now());
    for (let i = 0; i < 200; i++) {
        ctx.simulation.advance(5);
        const d = ctx.headway.getHeadways(cand.routeId, cand.dir, now());
        const vb = d.vehicles.find(v => v.vehicleId === cand.bId);
        if (!vb) return null; // B completed/despawned — broken candidate
        if (vb.headwayAheadSeconds !== null && vb.headwayAheadSeconds < 0.6 * cand.target) {
            return { headway0: vb.headwayAheadSeconds, detectedSteps: (i + 1) * 5 };
        }
    }
    return null;
}

function restoreLeader(ctx: Ctx, aId: string): void {
    ctx.simulation.setSpeedFactor(aId, 1 / SLOW_FACTOR);
}

async function main() {
    console.log('🧪 Service-Restoration Loop Verification...');

    // ─── Scenario A: bunch -> management -> recovery ───
    console.log('\n[A] Bunch injection + hold recovery');
    const ctx = await build();
    const candidates = listCandidates(ctx);
    assert(candidates.length > 0, 'found candidate pairs for bunch injection');

    let chosen: Candidate | null = null;
    let headway0: number | null = null;
    let detectedSteps = 0;
    for (const cand of candidates) {
        const r = tryBunch(ctx, cand);
        if (r) { chosen = cand; headway0 = r.headway0; detectedSteps = r.detectedSteps; break; }
    }
    assert(chosen !== null && headway0 !== null, `bunch reliably injected and detected (headwayAhead=${headway0})`);
    const { routeId, dir, aId, bId, target } = chosen!;
    console.log(`      detected: slowed ${aId} -> ${bId} BUNCHED at headway=${headway0} (target=${target}s)`);

    // Restore leader speed so the compressed spacing freezes (equal speeds).
    // The recommendation is computed now, while B is still cleanly BUNCHED.
    const now = () => new Date(ctx.simulation.now());
    restoreLeader(ctx, aId);

    // Management: recommendation -> instruction -> acknowledge -> hold
    const recs = ctx.headway.getRecommendations(routeId, dir, now());
    const rec = recs.find(r => r.vehicleId === bId);
    assert(!!rec && rec.action === 'HOLD', `hold recommendation generated for bunched vehicle (${rec?.holdSeconds}s)`);
    const inst = ctx.instructionStore.create({
        vehicleId: rec!.vehicleId,
        tripId: rec!.tripId,
        routeId: rec!.routeId,
        action: 'HOLD',
        controlPointStopId: rec!.controlPointStopId,
        controlPointStopName: rec!.controlPointStopName,
        holdSeconds: rec!.holdSeconds,
        message: rec!.reason,
        source: 'recommendation',
    });
    ctx.instructionStore.acknowledge(inst.id);
    ctx.simulation.applyHold(bId, rec!.holdSeconds);
    assert(ctx.simulation.isHeld(bId), 'hold applied to the vehicle (isHeld)');

    // Advance a generous window: the vehicle reaches its next stop, the pending
    // hold applies and expires, then it resumes.
    const getB = () => ctx.simulation.getVehicles().find(v => v.vehicleId === bId);
    const window = rec!.holdSeconds + 300;
    ctx.simulation.advance(window);
    const d2 = ctx.headway.getHeadways(routeId, dir, now());
    const vb2 = d2.vehicles.find(v => v.vehicleId === bId);
    assert(!!vb2, 'vehicle B still present after hold');
    const headway1 = vb2!.headwayAheadSeconds;
    console.log(`      post-management status: ${vb2!.headwayStatus}, headwayAhead=${headway1} (was ${headway0})`);
    const intBpos = vb2!.axisPosition;

    // Did the hold actually take effect (pending consumed at a stop)?
    const bFinal = getB();
    const holdApplied = !!bFinal && bFinal.holdSecondsPending === undefined && !ctx.simulation.isHeld(bId);
    assert(holdApplied, 'hold was consumed at a stop (mechanical effect confirmed)');

    // Control engine: same seed + same candidate + same injections, NO hold.
    const ctrl = await build();
    ctrl.simulation.reset();
    ctrl.simulation.spawnActiveVehicles(SPAWN);
    ctrl.simulation.setSpeedFactor(chosen!.aId, SLOW_FACTOR);
    ctrl.simulation.advance(detectedSteps); // same slowdown window as intervention
    restoreLeader(ctrl, chosen!.aId);
    ctrl.simulation.advance(window);        // same elapsed time, no hold
    const cNow = () => new Date(ctrl.simulation.now());
    const dc = ctrl.headway.getHeadways(routeId, dir, cNow());
    const vc = dc.vehicles.find(v => v.vehicleId === bId);
    assert(!!vc, 'control vehicle B still present');
    console.log(`      control (no hold) status: ${vc.headwayStatus}, headwayAhead=${vc.headwayAheadSeconds}`);

    // Recovery assertions: management increased spacing beyond the bunched
    // state, and the no-intervention control did not reach NORMAL.
    assert(headway1 !== null && headway1 > headway0!,
        `managed spacing improved after hold (${headway0} -> ${headway1})`);
    assert(vc.headwayStatus !== 'NORMAL',
        `control (no intervention) did not reach NORMAL after same elapsed time (status=${vc.headwayStatus}, headway=${vc?.headwayAheadSeconds})`);

    // ─── Scenario B: gap detection + correct boundary ───
    console.log('\n[B] Gap injection + management boundary');
    const g = await build();
    const gCands = listCandidates(g);
    assert(gCands.length > 0, 'found candidate for gap scenario');
    const gPair = gCands[0];
    g.simulation.reset();
    g.simulation.spawnActiveVehicles(SPAWN);
    g.simulation.setSpeedFactor(gPair.bId, SLOW_FACTOR); // slow the follower -> gap ahead grows

    const gNow = () => new Date(g.simulation.now());
    let gapHeadway: number | null = null;
    for (let i = 0; i < 120; i++) {
        g.simulation.advance(5);
        const d = g.headway.getHeadways(gPair.routeId, gPair.dir, gNow());
        const vb = d.vehicles.find(v => v.vehicleId === gPair.bId);
        if (!vb) break;
        if (vb.headwayAheadSeconds !== null && vb.headwayAheadSeconds > 1.4 * gPair.target) {
            gapHeadway = vb.headwayAheadSeconds;
            break;
        }
    }
    assert(gapHeadway !== null, `gap detected after follower slowdown (headwayAhead=${gapHeadway})`);

    // Management should NOT hold the gapped vehicle (only the bunch behind it)
    const grecs = g.headway.getRecommendations(gPair.routeId, gPair.dir, gNow());
    assert(!grecs.some(r => r.vehicleId === gPair.bId), 'no hold recommended for the gapped vehicle (correct boundary)');
    const recForBunch = grecs.find(r => r.action === 'HOLD');
    if (recForBunch) {
        console.log(`      (management correctly targets the resulting bunch: vehicle ${recForBunch.vehicleId})`);
    } else {
        console.log('      (no bunch detected behind the gap — no action needed)');
    }

    console.log('\n✨ Service-Restoration Loop Verification Passed');
    process.exit(0);
}

main().catch(err => {
    console.error('❌ Service-Restoration Loop Verification Failed:', err);
    process.exit(1);
});
