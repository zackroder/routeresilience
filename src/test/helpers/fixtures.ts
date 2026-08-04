// GTFS fixture loading helpers.
//
// Strategy: the CTA feed is large (~750MB SQLite DB), so we do NOT re-import it
// per test file. Instead a shared test database is built once from the extracted
// CTA CSV files (`data/gtfs/`, produced by `ensureCTAFeedExtracted()`) and cached
// on disk at `data/test/gtfs.db`. Tests open it **read-only**, exactly like
// production opens the dev DB. Rebuild when missing or when
// `REBUILD_TEST_DB=1` is set.
//
// The registry below maps stable feed keys to sources so additional datasets can
// be added later (see `src/test/fixtures/README.md`).
import fs from 'fs'
import path from 'path'
import { GTFSRepository } from '../../server/gtfs/database.js'
import { ensureCTAFeedExtracted, importGTFSIntoRepo } from '../../server/gtfs/loader.js'

const TEST_DB_DIR = path.resolve(process.cwd(), 'data', 'test')
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'gtfs.db')

export interface FeedDescriptor {
  key: string
  description: string
  /** Function returning the GTFS CSV directory for this feed. */
  sourceDir: () => Promise<string>
}

/**
 * Registry of feeds available to tests. The CTA feed is built from the same
 * local download/extract used by production. Additional datasets can be
 * registered here when sourced.
 */
export const FEEDS: FeedDescriptor[] = [
  {
    key: 'cta',
    description: 'CTA GTFS feed (production data, downloaded/extracted locally)',
    sourceDir: ensureCTAFeedExtracted,
  },
]

/** Resolve a feed descriptor by key, throwing if it is not registered. */
export function getFeed(key: string): FeedDescriptor {
  const feed = FEEDS.find((f) => f.key === key)
  if (!feed) {
    throw new Error(
      `Unknown feed "${key}". Registered feeds: ${FEEDS.map((f) => f.key).join(', ')}`
    )
  }
  return feed
}

/** True if the shared test DB exists on disk. */
export function ctaTestDbExists(): boolean {
  return fs.existsSync(TEST_DB_PATH)
}

/**
 * Build (or return) the shared CTA test database, opening it read-only.
 * On first call the DB is imported from the extracted CTA feed; subsequent
 * calls reuse the cached file. Set REBUILD_TEST_DB=1 to force a rebuild.
 */
export async function loadCTATestDatabase(): Promise<GTFSRepository> {
  const rebuild = process.env.REBUILD_TEST_DB === '1'
  if (!ctaTestDbExists() || rebuild) {
    if (rebuild) {
      console.log('  [test] Rebuilding CTA test database...')
    } else {
      console.log('  [test] CTA test database not found, building from feed...')
    }
    const sourceDir = await ensureCTAFeedExtracted()
    fs.mkdirSync(TEST_DB_DIR, { recursive: true })
    if (fs.existsSync(TEST_DB_PATH)) {
      // Remove stale file + WAL sidecars before rebuilding.
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.unlinkSync(TEST_DB_PATH + suffix)
        } catch {
          // ignore missing
        }
      }
    }
    const repo = new GTFSRepository({ dbPath: TEST_DB_PATH, clear: true })
    try {
      await importGTFSIntoRepo(repo, sourceDir)
    } finally {
      repo.close()
    }
  }

  // Open read-only for tests — mirrors production's dev DB behavior.
  return new GTFSRepository({ dbPath: TEST_DB_PATH, readonly: true })
}

/** Convenience wrapper for the default CTA feed used by most tests. */
export const CTA_FEED = 'cta'
