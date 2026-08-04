// Test database helpers.
// Each test suite gets a fresh, isolated SQLite database — either fully
// in-memory (`:memory:`) or a temp file — so tests never touch the development
// database at `data/gtfs.db`.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { GTFSRepository } from '../../server/gtfs/database.js'

/**
 * Create an isolated, in-memory GTFSRepository with the schema applied.
 * Use this for fast unit tests that seed data directly via SQL.
 */
export function createInMemoryRepository(): GTFSRepository {
  return new GTFSRepository({ memory: true })
}

/**
 * Create an isolated GTFSRepository backed by a temp-file SQLite database.
 * Returns the repo plus a cleanup function that removes the temp dir.
 * Useful when the database must persist across repo instances (e.g. to test
 * read-only re-opening), or when SQLite WAL would complicate in-memory use.
 */
export function createTempFileRepository(): {
  repo: GTFSRepository
  dbPath: string
  cleanup: () => void
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-'))
  const dbPath = path.join(dir, 'gtfs.db')
  const repo = new GTFSRepository({ dbPath })
  const cleanup = () => {
    try {
      repo.close()
    } catch {
      // already closed
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return { repo, dbPath, cleanup }
}

/**
 * Create a throwaway temp directory. Use it to hold extracted GTFS fixtures
 * without polluting the repo. Returns the dir path plus a cleanup function.
 */
export function createTempDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-gtfs-'))
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true })
  return { dir, cleanup }
}
