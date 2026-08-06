import express from 'express'
import cors from 'cors'
import path from 'path'
import { createServer } from 'http'
import { loadGTFS } from './gtfs/loader.js'
import { createApiRouter } from './api/routes.js'
import { DetourEngine } from './detour/engine.js'
import { CancellationStore } from './detour/cancellations.js'
import { DetourStore } from './detour/store.js'
import { SimulationEngine } from './simulation/engine.js'
import { FeedGenerator } from './realtime/feed.js'
import { PredictionEngine } from './realtime/predictions.js'
import { HeadwayService } from './headway/service.js'
import { InstructionStore } from './instructions/store.js'
import { apiKeyMiddleware, rateLimitMiddleware } from './api/middleware.js'
import { getServerConfig } from './config.js'
import { GtfsRtClient } from './realtime/ingest/gtfsrt-client.js'
import { GtfsRtVehicleSource } from './realtime/ingest/gtfsrt-vehicle-source.js'

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000

async function main() {
  console.log('// ─── RouteResilience Server ───\n')

  // ─── 1. Load GTFS Data (to SQLite) ───
  console.log('\n[1/4] Loading GTFS static data...')
  const repo = await loadGTFS()

  // ─── 2. Initialize engines ───
  console.log('\n[2/4] Initializing engines...')
  const config = getServerConfig()
  const detourStore = new DetourStore()
  const cancellationStore = new CancellationStore()
  const instructionStore = new InstructionStore()
  const detourEngine = new DetourEngine(repo, detourStore)
  const simulation = new SimulationEngine(repo, detourEngine, detourStore)

  const useRealFeed = config.vehicleSource === 'gtfs-rt'
  const vehicleSource = useRealFeed
    ? new GtfsRtVehicleSource(
        repo,
        new GtfsRtClient({ url: config.gtfsRtUrl, apiKey: config.gtfsRtApiKey }),
        config.gtfsRtPollIntervalMs
      )
    : simulation

  const predictions = new PredictionEngine(repo, vehicleSource)
  const headwayService = new HeadwayService(repo, vehicleSource, predictions)
  const feedGenerator = new FeedGenerator(
    repo,
    detourEngine,
    detourStore,
    vehicleSource,
    predictions,
    cancellationStore
  )

  // ─── 3. Start Vehicle Source ───
  console.log(`\n[3/4] Starting vehicle source: ${vehicleSource.sourceName}...`)
  if (useRealFeed) {
    // Active vehicles for *now* are whatever the live feed reports.
    await vehicleSource.start()
  } else {
    simulation.spawnActiveVehicles()
    simulation.start()
  }

  // ─── 4. Start API Server ───
  console.log('\n[4/4] Starting API server...')
  const app = express()
  app.use(cors())
  app.use(express.json())

  // # Rate limiting & Auth for all /api routes
  app.use('/api', apiKeyMiddleware)
  app.use('/api', rateLimitMiddleware)

  const apiRouter = createApiRouter(
    repo,
    detourEngine,
    detourStore,
    simulation,
    feedGenerator,
    cancellationStore,
    headwayService,
    instructionStore,
    vehicleSource
  )
  app.use('/api', apiRouter)

  // Serve static frontend files in production
  const clientPath = path.resolve(process.cwd(), 'dist', 'client')
  app.use(express.static(clientPath))

  app.get('/gtfs.zip', (_req, res) => {
    const zipPath = path.resolve(process.cwd(), 'data', 'google_transit.zip')
    res.sendFile(zipPath)
  })

  app.get('*', (req, res) => {
    res.sendFile(path.join(clientPath, 'index.html'))
  })

  const httpServer = createServer(app)
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`\n✅ Server ready at http://localhost:${PORT}`)
    console.log(`   - API: http://localhost:${PORT}/api`)
    console.log(`   - GTFS Static: http://localhost:${PORT}/api/gtfs/zip (or /gtfs.zip)`)
    console.log(`   - GTFS-RT Feed: http://localhost:${PORT}/api/gtfs-rt`)
    console.log(`   - Vehicle source: ${vehicleSource.sourceName}`)
  })

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...')
    if (useRealFeed) vehicleSource.stop()
    simulation.stop()
    repo.close()
    process.exit(0)
  })
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
