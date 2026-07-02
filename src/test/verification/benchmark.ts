import { GTFSRepository } from '../../server/gtfs/database.js';
import { loadGTFS } from '../../server/gtfs/loader.js';
import { SimulationEngine } from '../../server/simulation/engine.js';
import { DetourEngine } from '../../server/detour/engine.js';
import { DetourStore } from '../../server/detour/store.js';

async function benchmark() {
    console.log('🚀 Starting GTFS Performance Benchmark...');

    // Load Repo (should be fast if already populated by unit test)
    const startTimeLength = Date.now();
    const repo = await loadGTFS();
    console.log(`📚 Repository loaded in ${Date.now() - startTimeLength}ms`);

    // ─── 1. Active Trips Query Performance ───
    console.log('\n⏱️  Benchmarking getActiveTrips()...');
    const iterations = 100;
    const now = new Date();
    // Use a fixed date known to have service
    const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const timeSeconds = 12 * 3600; // Noon

    let totalTime = 0;
    let maxTime = 0;

    for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        const trips = repo.getActiveTrips(dateStr, timeSeconds);
        const end = performance.now();
        const duration = end - start;
        totalTime += duration;
        if (duration > maxTime) maxTime = duration;

        if (i === 0) console.log(`   First query returned ${trips.length} active trips`);
    }

    const avgTime = totalTime / iterations;
    console.log(`   Average time: ${avgTime.toFixed(2)}ms`);
    console.log(`   Max time: ${maxTime.toFixed(2)}ms`);
    console.log(`   Total time for ${iterations} queries: ${totalTime.toFixed(2)}ms`);

    if (avgTime > 50) {
        console.warn('⚠️  Warning: Average query time > 50ms. Performance might be degraded.');
    } else {
        console.log('✅ Performance check PASSED (< 50ms)');
    }

    // ─── 2. Simulation Tick Setup ───
    console.log('\n🚌 Benchmarking Simulation Spawn...');
    const detourStore = new DetourStore();
    const detourEngine = new DetourEngine(repo, detourStore);
    const simulation = new SimulationEngine(repo, detourEngine);

    const spawnStart = performance.now();
    simulation.spawnActiveVehicles(new Date(now.setHours(12, 0, 0, 0)));
    const spawnEnd = performance.now();

    console.log(`   Spawned ${simulation.getVehicleCount()} vehicles in ${(spawnEnd - spawnStart).toFixed(2)}ms`);

    if (spawnEnd - spawnStart > 500) {
        console.warn('⚠️  Warning: Spawn time > 500ms.');
    } else {
        console.log('✅ Spawn performance PASSED');
    }

    repo.close();
}

benchmark();
