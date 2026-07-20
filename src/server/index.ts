import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { loadGTFS } from './gtfs/loader.js';
import { createApiRouter } from './api/routes.js';
import { DetourEngine } from './detour/engine.js';
import { CancellationStore } from './detour/cancellations.js';
import { DetourStore } from './detour/store.js';
import { SimulationEngine } from './simulation/engine.js';
import { FeedGenerator } from './realtime/feed.js';
import { PredictionEngine } from './realtime/predictions.js';
import { apiKeyMiddleware, rateLimitMiddleware } from './api/middleware.js';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000;

async function main() {
    console.log('// ─── RouteResilience Server ───\n');

    // ─── 1. Load GTFS Data (to SQLite) ───
    console.log('\n[1/4] Loading GTFS static data...');
    const repo = await loadGTFS();

    // ─── 2. Initialize engines ───
    console.log('\n[2/4] Initializing engines...');
    const detourStore = new DetourStore();
    const cancellationStore = new CancellationStore();
    const detourEngine = new DetourEngine(repo, detourStore);
    const simulation = new SimulationEngine(repo, detourEngine, detourStore);
    const predictions = new PredictionEngine(repo, simulation);
    const feedGenerator = new FeedGenerator(repo, detourEngine, detourStore, simulation, predictions, cancellationStore);

    // ─── 3. Start Simulation ───
    console.log('\n[3/4] Starting simulation...');
    // Initialize simulation with active vehicles for *now*
    simulation.spawnActiveVehicles();
    simulation.start();

    // ─── 4. Start API Server ───
    console.log('\n[4/4] Starting API server...');
    const app = express();
    app.use(cors());
    app.use(express.json());

    // # Rate limiting & Auth for all /api routes
    app.use('/api', apiKeyMiddleware);
    app.use('/api', rateLimitMiddleware);

    const apiRouter = createApiRouter(repo, detourEngine, detourStore, simulation, feedGenerator, cancellationStore);
    app.use('/api', apiRouter);

    const httpServer = createServer(app);
    httpServer.listen(PORT, '0.0.0.0', () => {
        console.log(`\n✅ Server ready at http://localhost:${PORT}`);
        console.log(`   - API: http://localhost:${PORT}/api`);
        console.log(`   - GTFS-RT: http://localhost:${PORT}/api/gtfs-rt`);
    });

    // Graceful shutdown
    process.on('SIGINT', () => {
        console.log('\nShutting down...');
        simulation.stop();
        repo.close();
        process.exit(0);
    });
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
