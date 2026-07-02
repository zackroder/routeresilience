import express from 'express';
import cors from 'cors';
import { loadGTFS } from './gtfs/loader.js';
import { DetourEngine } from './detour/engine.js';
import { DetourStore } from './detour/store.js';
import { SimulationEngine } from './simulation/engine.js';
import { PredictionEngine } from './realtime/predictions.js';
import { FeedGenerator } from './realtime/feed.js';
import { createApiRouter } from './api/routes.js';

const PORT = 3001;

async function main() {
    console.log('═══════════════════════════════════════════════');
    console.log('  Transit Detour Manager — Starting Up');
    console.log('═══════════════════════════════════════════════');

    // ─── 1. Load GTFS static data ───
    console.log('\n[1/4] Loading GTFS static data...');
    const gtfs = await loadGTFS();

    // ─── 2. Initialize engines ───
    console.log('\n[2/4] Initializing engines...');
    const detourStore = new DetourStore();
    const detourEngine = new DetourEngine(gtfs, detourStore);
    const simulation = new SimulationEngine(gtfs, detourEngine);
    const predictions = new PredictionEngine(gtfs, simulation);
    const feedGenerator = new FeedGenerator(gtfs, detourEngine, detourStore, simulation, predictions);

    // ─── 3. Initialize simulation (DEBUG ONLY) ───
    const isSimulationEnabled = process.env.SIMULATION_DEBUG_MODE === 'true';
    if (isSimulationEnabled) {
        console.log('\n[3/4] Initializing vehicle simulation (DEBUG MODE ENABLED)...');
        simulation.initializeShapes();
        simulation.spawnActiveVehicles();
        simulation.start();
    } else {
        console.log('\n[3/4] Vehicle simulation skipped (SIMULATION_DEBUG_MODE not set)');
    }

    // ─── 4. Start HTTP server ───
    console.log('\n[4/4] Starting HTTP server...');
    const app = express();
    app.use(cors());
    app.use(express.json({ limit: '10mb' }));

    // API routes
    app.use('/api', createApiRouter(gtfs, detourEngine, detourStore, simulation, feedGenerator));

    // Health check
    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', uptime: process.uptime() });
    });

    app.listen(PORT, () => {
        console.log('\n═══════════════════════════════════════════════');
        console.log(`  Server running at http://localhost:${PORT}`);
        console.log(`  GTFS-RT feed: http://localhost:${PORT}/api/gtfs-rt`);
        console.log(`  GTFS-RT JSON: http://localhost:${PORT}/api/gtfs-rt/json`);
        if (isSimulationEnabled) {
            console.log(`  Vehicles: ${simulation.getVehicleCount()} active`);
        }
        console.log(`  Routes: ${gtfs.routes.size} bus routes loaded`);
        console.log('═══════════════════════════════════════════════');
    });

    // Periodic stats
    setInterval(() => {
        const simStats = isSimulationEnabled ? `Vehicles: ${simulation.getVehicleCount()}, ` : '';
        console.log(`[stats] ${simStats}Active Detours: ${detourStore.getActive().length}`);
    }, 60_000);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
