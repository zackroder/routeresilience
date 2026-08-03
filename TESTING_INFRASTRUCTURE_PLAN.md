# Testing Infrastructure Implementation Plan

## Overview
Add comprehensive testing infrastructure to the RouteResilience project, including test framework, linting, formatting, and pre-commit hooks. This plan prioritizes high-value, low-risk changes that can be implemented incrementally.

## Current State
- **37 TypeScript files** across server, client, and test directories
- **No automated testing framework** - only manual test scripts in `scripts/` and one basic unit test
- **No linting or formatting tools** - code style enforced manually
- **No pre-commit hooks** - quality checks not automated
- **Complex business logic** in detour engine, headway service, simulation engine, and GTFS processing
- **Existing one-off test files** scattered in root directory need cleanup:
  - `test-api.ts`, `test-blocks-details.ts`, `test-persistence.ts`, `test-stitching.ts`
  - `debug-db.ts`
  - `rewrite.sh`, `scratch/` directory

## Test Data Strategy
- **Use Google sample GTFS feed** for testing: https://github.com/google/transit/blob/master/gtfs/spec/en/examples/sample-feed-1.zip
  - Smaller, cleaner dataset than CTA feed
  - Better for unit/integration tests
  - Commit to `test/fixtures/gtfs-sample.zip`
- **Keep CTA feed** for development/demo purposes
- **Test database**: Use in-memory SQLite or temp directory for tests
  - Avoid conflicts with development database
  - Each test suite gets fresh database
  - Cleanup after tests complete

## Phase 1: Foundation Setup (Low Risk, High Impact)

### 1.1 Install Vitest (Test Framework)
**Why Vitest**: Native Vite integration, TypeScript-first, fast, minimal config

**Dependencies to install**:
```bash
npm install -D vitest @vitest/coverage-v8 jsdom happy-dom
```

**Configuration** (`vitest.config.ts`):
```typescript
import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'src/test/',
        '**/*.test.ts',
        '**/*.d.ts'
      ]
    },
    testTimeout: 30000, // GTFS loading can be slow
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  }
})
```

**Package.json scripts**:
```json
{
  "scripts": {
    "test": "vitest",
    "test:run": "vitest run",
    "test:coverage": "vitest run --coverage",
    "test:ui": "vitest --ui"
  }
}
```

### 1.2 Install ESLint (Code Quality)
**Dependencies**:
```bash
npm install -D eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin eslint-plugin-import eslint-plugin-node
```

**Configuration** (`.eslintrc.json`):
```json
{
  "root": true,
  "parser": "@typescript-eslint/parser",
  "parserOptions": {
    "ecmaVersion": 2022,
    "sourceType": "module",
    "project": "./tsconfig.json"
  },
  "plugins": ["@typescript-eslint", "import"],
  "extends": [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:@typescript-eslint/recommended-requiring-type-checking"
  ],
  "env": {
    "node": true,
    "es2022": true
  },
  "rules": {
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
    "@typescript-eslint/explicit-function-return-type": "off",
    "@typescript-eslint/no-floating-promises": "error",
    "@typescript-eslint/no-misused-promises": "error",
    "no-console": ["warn", { "allow": ["warn", "error"] }],
    "import/order": ["error", {
      "groups": ["builtin", "external", "internal"],
      "newlines-between": "always"
    }],
    "no-var": "error",
    "prefer-const": "error"
  },
  "ignorePatterns": ["dist/", "node_modules/", "*.js", "data/"]
}
```

**Package.json scripts**:
```json
{
  "scripts": {
    "lint": "eslint src --ext .ts",
    "lint:fix": "eslint src --ext .ts --fix"
  }
}
```

### 1.3 Install Prettier (Code Formatting)
**Dependencies**:
```bash
npm install -D prettier eslint-config-prettier eslint-plugin-prettier
```

**Configuration** (`.prettierrc.json`):
```json
{
  "semi": false,
  "singleQuote": true,
  "tabWidth": 2,
  "trailingComma": "es5",
  "printWidth": 100,
  "bracketSpacing": true,
  "arrowParens": "always",
  "endOfLine": "lf"
}
```

**Configuration** (`.prettierignore`):
```
node_modules/
dist/
data/
*.log
.DS_Store
```

**Update ESLint config** to integrate Prettier:
```json
{
  "extends": [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:@typescript-eslint/recommended-requiring-type-checking",
    "prettier"
  ],
  "plugins": ["prettier"],
  "rules": {
    "prettier/prettier": "error"
  }
}
```

**Package.json scripts**:
```json
{
  "scripts": {
    "format": "prettier --write \"src/**/*.ts\"",
    "format:check": "prettier --check \"src/**/*.ts\""
  }
}
```

### 1.4 Install Husky + lint-staged (Pre-commit Hooks)
**Dependencies**:
```bash
npm install -D husky lint-staged
```

**Setup**:
```bash
npx husky install
npx husky add .husky/pre-commit "npx lint-staged"
```

**Package.json**:
```json
{
  "lint-staged": {
    "*.ts": [
      "prettier --write",
      "eslint --fix"
    ]
  }
}
```

**Commit the hooks**:
```bash
git add .husky/
git commit -m "chore: add husky pre-commit hooks"
```

## Phase 2: Initial Test Coverage (Priority Order)

### Test Directory Structure
Use separate test directories organized by type:
```
src/test/
  unit/           # Fast, isolated tests with mocks
    gtfs/
    detour/
    simulation/
    headway/
  integration/    # Full stack tests with real database
    api/
    workflows/
  fixtures/       # Test data
    gtfs-sample.zip
    mock-responses/
  helpers/        # Test utilities
    database.ts   # Test database setup
    fixtures.ts   # Load test data
```

### Test Environment Isolation
**What this means**: Tests should not interfere with each other or with development data.

**Implementation**:
- Each test suite creates its own temporary SQLite database
- Use `beforeAll()` to set up fresh database
- Use `afterAll()` to clean up
- Never use the development `data/gtfs.db`
- Mock external services (OSRM) at the HTTP level or use dependency injection

**Example**:
```typescript
import { setupTestDatabase, cleanupTestDatabase } from '../helpers/database'

describe('GTFSRepository', () => {
  let db: Database
  
  beforeAll(async () => {
    db = await setupTestDatabase()
    await loadTestGTFS(db, 'test/fixtures/gtfs-sample.zip')
  })
  
  afterAll(() => {
    cleanupTestDatabase(db)
  })
  
  // tests...
})
```

### 2.1 GTFSRepository Tests (`src/test/unit/gtfs/database.test.ts`)
**Why first**: Pure data access layer, easy to test, critical dependency

**Test cases**:
- Database initialization and schema creation
- Route/stop/trip CRUD operations
- Query methods (getActiveTrips, getStopTimes, etc.)
- Edge cases (empty database, missing records)

**Mocking strategy**: Use in-memory SQLite database for tests

**Estimated effort**: 2-3 hours

### 2.2 CancellationStore Tests (`src/test/unit/detour/cancellations.test.ts`)
**Why second**: Simple state management, good learning example

**Test cases**:
- Cancel/restore trip operations
- Date range handling
- Bulk operations
- Persistence (save/load)
- Cleanup of past dates

**Mocking strategy**: Mock filesystem operations or use temp directory

**Estimated effort**: 1-2 hours

### 2.3 DetourEngine Tests (`src/test/unit/detour/engine.test.ts`)
**Why third**: Core business logic, complex calculations

**Test cases**:
- Affected trip identification
- Modified stop sequence calculation
- Timing calculations
- Detour path computation
- Edge cases (no affected trips, multiple routes)

**Mocking strategy**: Mock GTFSRepository with test data

**Estimated effort**: 3-4 hours

### 2.4 HeadwayService Tests (`src/test/unit/headway/service.test.ts`)
**Why fourth**: Complex algorithm, important for dispatch features

**Test cases**:
- Headway calculation
- Control point identification
- Branch detection
- Recommendation generation
- Vehicle position tracking

**Mocking strategy**: Mock dependencies (GTFSRepository, VehicleDataSource, PredictionEngine)

**Estimated effort**: 3-4 hours

### 2.5 SimulationEngine Tests (`src/test/unit/simulation/engine.test.ts`)
**Why fifth**: Large, complex, but testable with seeded RNG

**Test cases**:
- Vehicle spawning and movement
- Detour handling
- Speed calculations
- Deterministic behavior with seeded RNG
- Service holds

**Mocking strategy**: Use manual clock and seeded RNG for deterministic tests

**Estimated effort**: 4-5 hours

### 2.6 API Route Tests (`src/test/integration/api/routes.test.ts`)
**Why sixth**: Integration tests validate request/response contracts

**Test cases**:
- GET /api/routes
- GET /api/detours
- POST /api/detours
- GET /api/blocks
- GET /api/headways
- Error handling (404, 400, 500)

**Mocking strategy**: Use supertest with Express app, mock dependencies

**Estimated effort**: 3-4 hours

### 2.7 OSRM Integration Challenges

**Problem**: Detour path calculation requires OSRM routing service.

**Options**:
1. **Mock at HTTP level** (recommended for unit tests)
   - Use `nock` or `msw` to intercept OSRM API calls
   - Return pre-recorded responses
   - Fast, deterministic, no external dependencies

2. **Dependency injection** (better long-term)
   - Create `RoutingService` interface
   - Implement `OSRMRoutingService` for production
   - Implement `MockRoutingService` for tests
   - Allows testing detour logic without OSRM

3. **Integration tests with real OSRM** (for full stack)
   - Use test OSRM instance or staging environment
   - Slower but validates real integration
   - Run only in CI or specific test suites

**Recommendation**: Start with HTTP mocking (option 1), refactor to dependency injection later.

### 2.8 Full Stack Testing Strategy

**What to test**:
- API endpoints with real database
- Detour creation workflow (API → database → response)
- GTFS loading from sample feed
- End-to-end workflows (create detour, get affected trips)

**How to test**:
- Use test database with sample GTFS data
- Mock external services (OSRM) at HTTP level
- Test complete workflows, not just individual functions
- Verify database state after operations

**Example**:
```typescript
describe('POST /api/detours', () => {
  it('creates detour and stores in database', async () => {
    // Mock OSRM response
    nock('http://osrm-server')
      .post('/route/v1/driving/...')
      .reply(200, { routes: [...] })
    
    // Make API request
    const response = await request(app)
      .post('/api/detours')
      .send({ routeId: '1', divergeStopId: 'A', rejoinStopId: 'B' })
    
    // Verify response
    expect(response.status).toBe(201)
    expect(response.body.id).toBeDefined()
    
    // Verify database state
    const detours = await db.prepare('SELECT * FROM detours').all()
    expect(detours).toHaveLength(1)
  })
})
```

## Phase 3: CI/CD Integration

### 3.1 GitHub Actions Workflow (`.github/workflows/test.yml`)
```yaml
name: Test and Lint

on:
  push:
    branches: [dev, main]
  pull_request:
    branches: [dev, main]

jobs:
  test:
    runs-on: ubuntu-latest
    
    strategy:
      matrix:
        node-version: [18.x, 20.x]
    
    steps:
      - uses: actions/checkout@v3
      
      - name: Use Node.js ${{ matrix.node-version }}
        uses: actions/setup-node@v3
        with:
          node-version: ${{ matrix.node-version }}
          cache: 'npm'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Check formatting
        run: npm run format:check
      
      - name: Lint
        run: npm run lint
      
      - name: Build
        run: npm run build
      
      - name: Run tests
        run: npm run test:run
      
      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage/coverage-final.json
          fail_ci_if_error: false
```

### 3.2 Coverage Thresholds
**Pragmatic approach**: Start small, improve gradually.

**Initial** (first month):
- No coverage thresholds enforced
- Focus on getting tests written
- Track coverage for visibility only

**After 1 month**: Set baseline
```typescript
coverage: {
  thresholds: {
    lines: 30,
    functions: 30,
    branches: 30,
    statements: 30
  }
}
```

**After 3 months**: Increase to 50%  
**After 6 months**: Increase to 70% (if feasible)

**Key principle**: Coverage is a guide, not a goal. Better to have meaningful tests at 40% coverage than meaningless tests at 80%.

## Phase 4: Cleanup Existing Tests

### 4.1 Remove One-Off Test Files
Delete these files from the root directory:
- `test-api.ts`
- `test-blocks-details.ts`
- `test-persistence.ts`
- `test-stitching.ts`
- `debug-db.ts`

### 4.2 Clean Up Scratch Files
- Remove `rewrite.sh` (if no longer needed)
- Remove `scratch/` directory (if no longer needed)
- Or move useful scripts to `scripts/` with proper naming

### 4.3 Migrate Useful Test Logic
Review existing test files and migrate useful test cases to the new structure:
- Extract test cases from `test-api.ts` → `src/test/integration/api/routes.test.ts`
- Extract test cases from `test-persistence.ts` → `src/test/unit/detour/cancellations.test.ts`
- Keep `scripts/` for manual verification scripts that aren't automated tests

### 4.4 Update Documentation
- Update `README.md` with new test commands
- Document test data sources (Google sample GTFS)
- Explain how to run different test types

## Phase 5: Migration Strategy (Incremental Adoption)

### 4.1 Initial Rollout (Week 1)
1. Install all tools (Phase 1.1-1.4)
2. Download Google sample GTFS feed to `test/fixtures/`
3. Run `npm run format` on entire codebase
4. Run `npm run lint:fix` to auto-fix issues
5. Manually fix remaining lint errors
6. Commit as single "chore: apply formatting and fix lint errors"
7. Clean up one-off test files (Phase 4.1-4.2)
8. Add tests for **new code only**

### 4.2 Gradual Test Backfill (Weeks 2-8)
1. Write tests for Phase 2 priority modules
2. Aim for 1-2 hours of testing work per day
3. Review test coverage weekly
4. Add tests for bug fixes (regression tests)

### 4.3 Enforcement (Week 9+)
1. Enable coverage thresholds
2. Require tests for new features
3. Block PRs that decrease coverage
4. Regular coverage reviews

## Risk Mitigation

### Risk 1: Breaking existing code with formatting
**Mitigation**: 
- Run formatting on entire codebase in single commit
- Review changes carefully
- Test thoroughly after formatting

### Risk 2: Lint errors in existing code
**Mitigation**:
- Start with "warn" level, not "error"
- Use `eslint:recommended` as baseline
- Gradually enable stricter rules

### Risk 3: Tests are slow or flaky
**Mitigation**:
- Use in-memory databases for tests
- Mock external dependencies
- Set reasonable timeouts
- Run tests in parallel where possible

### Risk 4: Team resistance to new tools
**Mitigation**:
- Start with non-blocking tools (formatting, linting as warnings)
- Show value through bug prevention
- Provide training/documentation
- Make it easy (pre-commit hooks, CI automation)

## Success Metrics

1. **Test coverage**: 30% → 50% → 70% over 6 months
2. **Lint errors**: 0 in CI
3. **Format compliance**: 100% (enforced by pre-commit)
4. **Bug detection**: Track bugs caught by tests vs manual testing
5. **Developer velocity**: Measure time from PR to merge

## Handoff Checklist for Worker Agent

- [ ] Install all dependencies (Phase 1.1-1.4)
- [ ] Create configuration files (vitest, eslint, prettier, husky)
- [ ] Update package.json with new scripts
- [ ] Download Google sample GTFS feed to `test/fixtures/gtfs-sample.zip`
- [ ] Create test directory structure (`src/test/unit/`, `src/test/integration/`, `src/test/helpers/`)
- [ ] Create test helper utilities (database setup, fixture loading)
- [ ] Run formatting on entire codebase
- [ ] Fix lint errors (or document exceptions)
- [ ] Set up pre-commit hooks
- [ ] Clean up one-off test files (Phase 4.1-4.2)
- [ ] Migrate useful test logic from old files (Phase 4.3)
- [ ] Write initial tests for GTFSRepository
- [ ] Write initial tests for CancellationStore
- [ ] Verify all tests pass: `npm run test:run`
- [ ] Verify lint passes: `npm run lint`
- [ ] Verify format passes: `npm run format:check`
- [ ] Verify build passes: `npm run build`
- [ ] Update README.md with test commands and documentation
- [ ] Commit all changes with clear commit messages
- [ ] Update AGENTS.md with new commands and conventions

## Additional Notes

- **Test data**: Use Google sample GTFS feed for testing (commit to `test/fixtures/`)
- **Test structure**: Separate test directories (unit/integration), not co-located
- **OSRM mocking**: Start with HTTP mocking (nock/msw), refactor to dependency injection later
- **Full stack testing**: Yes, test complete workflows with real database and mocked external services
- **Coverage**: Start small (30%), increase gradually over 6 months to 70%
- **Cleanup**: Remove one-off test files from root, migrate useful logic to new structure
- **Keep manual test scripts** in `scripts/` for now - they serve a different purpose
- **Focus on server-side tests first** - client tests can come later
- **Use existing code patterns** - match the project's style
- **Document exceptions** - if certain rules don't apply, document why

## References

- Vitest docs: https://vitest.dev/
- ESLint docs: https://eslint.org/
- Prettier docs: https://prettier.io/
- Husky docs: https://typicode.github.io/husky/
- TypeScript ESLint: https://typescript-eslint.io/
