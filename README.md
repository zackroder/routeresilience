# RouteResilience

**Service Management & GTFS-RT Engine**

A specialized dashboard and visualization tool built for transit agencies to manage, plan, and visualize bus detours and disruptions.  

Ingests GTFS schedule and geographic data in conjunction with vehicle location feed to provide a real-time, map-based interface for dynamically creating and distributing an enhanced GTFS-rt feed including TripModification for detours.


Experiment in creating intuitive software for documenting and distributing detours using [TripModifications](https://gtfs.org/documentation/realtime/feed-entities/trip-modifications/). 
## Features

- **Interactive Map Visualization**: Powered by Leaflet, displaying full route shapes, stops, and active vehicle positions.
- **Detour Creation Workflow**: Intuitive point-and-click interface to define diverge/rejoin stops, featuring an automatic **snap-to-street** routing workflow that calculates temporary paths using OSRM.
- **Block Viewer (Run Management)**: Visualize bus blocks/runs on a Gantt-style timeline to understand vehicle assignments, with the ability to dynamically **cancel specific trips, entire blocks, or runs**.
- **Cancelled Trip Tracking**: Manage and visualize cancelled trips with impact analysis against the schedule.
- **Advanced GTFS Processing**: Automatically detects, groups, and maps all unique trip patterns and route variants within the schedule data.
- **GTFS-RT Middleware Proxy**: Automatically generates a live, valid protobuf GTFS-RT feed (`/api/gtfs-rt`) containing `VehiclePositions`, `TripUpdates` (predictions), and experimental `TripModifications` to broadcast detours downstream to riders.
- **Dynamic Routing**: Automatic map route updates utilizing OSRM to find the most logical temporary path between two transit stops.
- **Dark/Light Mode**: Fully responsive, accessible interface with theming support for day/night operations.

## Screenshots

### Map View
![Map View & Detour Planning](docs/map-view.png)
*Visualizing a detour with temporary replacement stops and the OSRM-calculated path.*

#### Intuitive Detour Planning ####
![Detour Creation 1](docs/detour-creation-1.png)
*Use snap-to-street tracing and auto-detect pre-existing stops along detour path*

![Detour Creation 2](docs/detour-creation-2.png)
*Configurable start and end date-times for detours, with RouteResilience automatically detecting route patterns and trips affected by detour.*

### Block Viewer (Gantt Chart)
![Block Viewer](docs/block-viewer.png)
*Analyzing runs throughout the day alongside cancelled/detoured trips.*

### Cancelled Trip View
![Cancelled Trip Viewer](docs/view-cancelled.png)
*View and restore cancelled trips.*

## Technology Stack

- **Frontend**: Vite, TypeScript, Leaflet (Mapping), Vanilla CSS (Custom Design System)
- **Backend**: Node.js, Express, TypeScript
- **Database**: SQLite3 (for fast, local GTFS querying)
- **Routing**: OSRM (Open Source Routing Machine) API
- **Data Ingestion**: node-gtfs (Parses CTA static GTFS feeds)

## Future Enhancements

### 2. Service Management & Headway Adherence
As a GTFS-RT middleware proxy with real-time knowledge of bus locations and the static schedule, RouteResilience is perfectly positioned to monitor **schedule adherence and headways**. 

Future updates will include an automated engine that continuously scans the live network to identify "bunched" or "gapped" buses. Following a set of configurable agency rules, the system will actively recommend service restoration interventions (such as holding a bus at a control point or expressing a bus to fill a gap) to improve headway reliability and keep the network flowing.

## Vehicle Data Sources

RouteResilience reads live vehicle positions through a single `VehicleDataSource`
abstraction. Two implementations exist, selected at startup:

- **`simulation`** (default) — the internal high-performance simulation engine.
  Used for demos and offline development. No credentials required.
- **`gtfs-rt`** — polls a real agency GTFS-RT `VehiclePositions` feed (e.g.
  CTA's beta feed) and enriches each vehicle with schedule/geometry context so
  predictions, headways, and detour overlays work identically to simulation.
  Useful as a ground-truth "oracle" for validating service-management features.

### Using the real CTA feed

Create a `.env` file in the repo root (gitignored; a template lives at
`.env.example`). The API key is read from the environment at startup and is
never logged or committed:

```bash
# .env
VEHICLE_SOURCE=gtfs-rt
GTFS_RT_URL=https://transitdata.transitchicago.com/GtfsRealtime/VehiclePositions.pb
GTFS_RT_API_KEY=<your CTA developer key>
GTFS_RT_POLL_INTERVAL_MS=15000
```

Then start normally (`npm run dev`). The server polls the feed, exposes vehicle
positions via `/api/vehicles`, and serves the regenerated GTFS-RT feed
(`/api/gtfs-rt`) with detour/cancellation overlays applied. The simulator is
never started in this mode.

> Control actions (holding a real bus) are only applicable to the simulation
> source; in `gtfs-rt` mode those endpoints return a warning. This keeps the
> demo on `main` (simulation) fully functional while the real feed is used for
> development and evaluation.

## Local Development Setup

1. **Clone the repository**
2. **Install dependencies**
   ```bash
   npm install
   ```
3. **Start the development environment**
   This will concurrently start the Vite frontend and the Express backend. On the first run, it will automatically download and parse the GTFS dataset into a local SQLite database (this may take a few minutes).
   ```bash
   npm run dev
   ```
4. **Access the Application**
   Open your browser and navigate to `http://localhost:5173`.

## Testing

See [`TESTING.md`](TESTING.md) for the test-data policy, fixture design, and
testing roadmap.

Most tests are isolated unit tests or API contract tests. A smaller Google GTFS
spec fixture is available for focused loader cases. CTA's real feed is retained
as a separate scale smoke test: the first run downloads/extracts it and builds
a shared read-only database at `data/test/gtfs.db`, which can take several
minutes; subsequent runs reuse it.

```bash
npm run test          # Run tests in watch mode
npm run test:run      # Run tests once
npm run test:coverage # Run tests with a coverage report
npm run lint          # ESLint check
npm run lint:fix      # Auto-fix lint issues
npm run format        # Prettier format
npm run format:check  # Verify formatting (no changes)
```

To force a one-time rebuild of the shared CTA test database before the test
workers start:

```bash
REBUILD_TEST_DB=1 npm run test:run
```

**Test structure** (`src/test/`):
- `unit/` — Fast, isolated tests (GTFSRepository, DetourEngine, CancellationStore, DetourStore, InstructionStore, HeadwayService, SimulationEngine, RNG)
- `integration/` — Express API route tests via supertest against the shared test DB
- `helpers/` — Test utilities (in-memory/temp DB creation, CTA fixture loading)
- `fixtures/` — Small GTFS fixtures and fixture documentation; CTA is cached under `data/test/`

A pre-commit hook runs lint-staged (Prettier + ESLint on staged `.ts` files). CI (`.github/workflows/test.yml`) runs formatting, lint, build, and tests with coverage.



## API Endpoints

- `GET /api/status` - Returns database and data freshness status
- `GET /api/routes` - Returns all parsed transit routes
- `GET /api/routes/:id/shape` - Returns the geographic shape of a route
- `GET /api/routes/:id/stops` - Returns all stops for a route
- `GET /api/detours` - Returns all active and scheduled detours
- `POST /api/detours` - Create a new detour
- `GET /api/blocks` - Retrieve block/run assignments for the Gantt viewer
- `GET /api/cancelled` - Retrieve cancelled trips
