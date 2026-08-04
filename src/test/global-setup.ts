// The CTA scale-smoke suite (`src/test/unit/gtfs/loader.test.ts`) builds the
// test DB lazily in its own beforeAll via loadCTATestDatabase(). No other suite
// depends on the CTA feed, so there is no global-setup hook in vitest.config.ts.
// This file is kept as a reference; to use it again, add back
//   globalSetup: ['src/test/global-setup.ts']
// to vitest.config.ts.
