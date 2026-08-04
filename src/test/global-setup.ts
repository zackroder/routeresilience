// Vitest global setup: runs once before any test file.
//
// Ensures the shared CTA test database exists before suites start. The CTA
// feed is large (~750MB SQLite), so it is imported once and cached on disk;
// building it lazily inside test files would race when files run in parallel.
import { loadCTATestDatabase, ctaTestDbExists } from './helpers/fixtures.js'

export default async function globalSetup(): Promise<void> {
  if (!ctaTestDbExists()) {
    console.log('  [test] Building shared CTA test database (one-time)...')
    const repo = await loadCTATestDatabase()
    repo.close()
    console.log('  [test] Shared CTA test database ready.')
  }
}
