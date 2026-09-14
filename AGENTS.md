# Project Rules for OpenCode

## Package Manager & Commands

- **Package manager**: npm (not yarn, pnpm, or bun)
- **Install dependencies**: `npm install`
- **Development**: `npm run dev` (concurrently starts Vite client + Express server)
- **Build**: `npm run build` (Vite client build + TypeScript compilation)
- **Start production**: `npm start`
- **Dev server only**: `npm run dev:server`
- **Dev client only**: `npm run dev:client`
- **Testing**: 
  - `npm test` - Run tests in watch mode
  - `npm run test:run` - Run tests once
  - `npm run test:coverage` - Run tests with coverage report
- **Linting**:
  - `npm run lint` - Check code quality
  - `npm run lint:fix` - Auto-fix lint errors
- **Formatting**:
  - `npm run format` - Format code with Prettier
  - `npm run format:check` - Check formatting without changes

## Test Conventions

- **Test framework**: Vitest (configured in `vitest.config.ts`)
- **Test directories**: 
  - `src/test/unit/` - Fast, isolated tests with mocks
  - `src/test/integration/` - Full stack tests with real database
  - `src/test/fixtures/` - Small committed GTFS fixtures
  - `src/test/helpers/` - Test utilities
- **Test file naming**: `*.test.ts` extension
- **Test imports**: Use `.js` extension (ES modules)
- **Test commands**:
  - `npm test` - Run tests in watch mode
  - `npm run test:run` - Run tests once
  - `npm run test:coverage` - Run tests with coverage report
- **Test data**: Focused tests should use small fixtures or
  `createInMemoryRepository()` from `src/test/helpers/database.ts`. A shared
  read-only CTA scale-test DB is built once at `data/test/gtfs.db` via
  `src/test/global-setup.ts`; rebuild it with `REBUILD_TEST_DB=1`.
- **Test isolation**: Each test suite uses an isolated store directory
  (`PERSISTENT_DATA_DIR` temp dir) and never touches development data
- **Mocking**: Use `nock` or `msw` for HTTP mocking (OSRM, external APIs)
- **Manual test scripts**: Exist in `scripts/` for verification, not automated tests

## Architecture Boundaries

### Server (`src/server/`)
- **Entry point**: `src/server/index.ts`
- **Modules**:
  - `api/` - Express routes and middleware
  - `detour/` - Detour engine, store, cancellations
  - `gtfs/` - GTFS data loading and database
  - `realtime/` - GTFS-RT feed generation and predictions
  - `simulation/` - Vehicle simulation engine
- **Database**: SQLite via `better-sqlite3` (synchronous API)
- **Data directory**: `data/` (gitignored, created at runtime)

### Client (`src/client/`)
- **Entry point**: `src/client/index.html` → `src/client/main.ts`
- **Styling**: Vanilla CSS in `src/client/style.css`
- **API services**: `src/client/services.ts`
- **Mapping**: Leaflet (loaded via CDN, declared as global `L`)
- **Build tool**: Vite (config in `vite.config.ts`)

### Data Flow
- Server loads GTFS data into SQLite on startup
- Client fetches data via `/api/*` endpoints
- Vite proxies `/api` requests to Express server (port 4000)
- Client runs on port 5173, server on port 4000

## Naming & Style Rules

### TypeScript
- **Strict mode enabled** - no implicit any, no unchecked types
- **ES2022 target** with ESNext modules
- **ES modules** - use `.js` extension in imports (not `.ts`)
- **Module resolution**: bundler
- **No semicolons** - follow existing style (no semicolons at line ends)
- **Single quotes** for strings
- **2-space indentation**
- **Trailing commas** in multi-line structures

### File Naming
- **kebab-case** for files: `detour-engine.ts`, `feed.ts`
- **PascalCase** for classes: `DetourEngine`, `GTFSRepository`
- **camelCase** for functions and variables: `loadGTFS`, `activeTrips`

### Code Organization
- One class per file (preferred)
- Keep related types/interfaces in same file as implementation
- Use explicit return types for public functions
- Prefer `const` over `let`, avoid `var`

## Generated Files

### Generated at Runtime (gitignored)
- `data/gtfs.db` - SQLite database (created on first run)
- `dist/` - Build output (server + client)
- `node_modules/` - Dependencies

### Do Not Commit
- Database files
- Build artifacts
- Environment-specific configs
- Logs (`*.log`)
- OS files (`.DS_Store`)

## Migration Policy

- **No database migration system** currently in place
- Database is recreated from GTFS data on each fresh deployment
- Schema changes require updating `src/server/gtfs/database.ts`
- For production migration strategy, see `ARCHITECTURE.md` (PostgreSQL + PostGIS)

## Security Constraints

- **API authentication**: `apiKeyMiddleware` protects `/api` routes
- **Rate limiting**: `rateLimitMiddleware` on API endpoints
- **CORS**: Enabled via `cors` package
- **No secrets in code**: Use environment variables
  - `PORT` - Server port (default: 4000)
  - `API_KEY` - Required for API access (if configured)
- **No logging of sensitive data**: Avoid logging API keys, user data, or tokens

## Commit & PR Expectations

### Commit Messages
- Use conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`
- Keep messages concise but descriptive
- Reference issue numbers when applicable

### Branch Strategy
- `main` - Production branch (stable, deployed)
- `dev` - Main development branch (integration branch)
- `feature/*` - Feature branches (e.g., `feature/service-management-console`)
- `fix/*` - Bug fix branches
- `chore/*` - Infrastructure/tooling branches

### Workflow
1. **Feature branches → dev**: Use PRs for all feature merges
   - Ensures CI passes (tests, lint, build)
   - Provides code review opportunity (even self-review)
   - Creates clear history and documentation
   - Easy to revert if issues arise
   
2. **dev → main**: Use PRs for production releases
   - Only merge when dev is stable and tested
   - Tag releases: `v1.0.0`, `v1.1.0`, etc.
   - Consider release notes

3. **Hotfixes**: Direct to main only for urgent production fixes
   - Cherry-pick back to dev immediately after

### Cleanup
- Delete feature branches after merge (local and remote)
- Keep dev and main branches clean

### Before Committing
- Ensure code builds: `npm run build`
- Test manually if no automated tests exist
- No `console.log` statements in production code (use proper logging or remove)
- No commented-out code blocks
- No TODO comments without issue references

### PR Requirements
- Clear description of changes
- Screenshots for UI changes
- Test instructions for manual verification
- Update `README.md` if adding new features or changing setup

## Additional Notes

### Deployment
- **Target**: Fly.io with persistent volume
- **Config**: `Dockerfile` and `fly.toml` in repo root
- **Data persistence**: Volume mounted at `/app/data`

### Future Architecture
- See `ARCHITECTURE.md` for production scaling plans
- Planned migration: SQLite → PostgreSQL + PostGIS
- Planned addition: Redis for state management
- Planned separation: GTFS-RT ingestion worker

### Dependencies
- **Core**: Express, better-sqlite3, protobufjs
- **Frontend**: Vite, Leaflet (CDN)
- **Dev**: TypeScript, tsx, concurrently
- **Data**: csv-parse, adm-zip, unzipper

### External Services
- **OSRM**: Used for route calculations (detour paths)
- **GTFS feeds**: Downloaded and parsed on startup
- **GTFS-RT**: Generated as output (protobuf format)
