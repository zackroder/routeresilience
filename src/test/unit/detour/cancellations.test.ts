import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { CancellationStore } from '../../../server/detour/cancellations.js'
import { createTempDir } from '../../helpers/database.js'

// CancellationStore persists to `PERSISTENT_DATA_DIR`/cancellations.json.
// Each test gets its own temp dir so stores never touch dev data or each other.
describe('CancellationStore', () => {
  let tmp: { dir: string; cleanup: () => void }
  let store: CancellationStore

  beforeEach(() => {
    tmp = createTempDir()
    process.env.PERSISTENT_DATA_DIR = tmp.dir
    store = new CancellationStore()
  })

  afterEach(() => {
    delete process.env.PERSISTENT_DATA_DIR
    tmp.cleanup()
  })

  it('starts empty', () => {
    expect(store.getAllCancelled()).toEqual([])
  })

  it('cancels a trip for a single day', () => {
    store.cancelTrip('trip-1', '20990101', '20990101')
    expect(store.isCancelled('trip-1', '20990101')).toBe(true)
    expect(store.isCancelled('trip-1', '20990102')).toBe(false)
  })

  it('cancels a trip across a date range', () => {
    store.cancelTrip('trip-1', '20990101', '20990103')
    for (const d of ['20990101', '20990102', '20990103']) {
      expect(store.isCancelled('trip-1', d)).toBe(true)
    }
    expect(store.isCancelled('trip-1', '20990104')).toBe(false)
    expect(store.getAllCancelled()).toHaveLength(3)
  })

  it('restores a single day', () => {
    store.cancelTrip('trip-1', '20990101', '20990103')
    store.restoreTrip('trip-1', '20990102')
    expect(store.isCancelled('trip-1', '20990102')).toBe(false)
    expect(store.isCancelled('trip-1', '20990101')).toBe(true)
    expect(store.isCancelled('trip-1', '20990103')).toBe(true)
  })

  it('ignores invalid dates', () => {
    store.cancelTrip('trip-1', 'not-a-date', 'also-bad')
    expect(store.getAllCancelled()).toEqual([])
  })

  it('bulk cancels multiple trips', () => {
    store.bulkCancelTrips([
      { tripId: 'trip-1', startDate: '20990101', endDate: '20990102' },
      { tripId: 'trip-2', startDate: '20990105', endDate: '20990105' },
    ])
    expect(store.isCancelled('trip-1', '20990101')).toBe(true)
    expect(store.isCancelled('trip-1', '20990102')).toBe(true)
    expect(store.isCancelled('trip-2', '20990105')).toBe(true)
    expect(store.isCancelled('trip-2', '20990106')).toBe(false)
  })

  it('bulk restores keys', () => {
    store.cancelTrip('trip-1', '20990101', '20990103')
    store.bulkRestoreTrips(['trip-1_20990101', 'trip-1_20990102'])
    expect(store.isCancelled('trip-1', '20990101')).toBe(false)
    expect(store.isCancelled('trip-1', '20990102')).toBe(false)
    expect(store.isCancelled('trip-1', '20990103')).toBe(true)
  })

  it('persists cancellations across instances', async () => {
    store.cancelTrip('trip-1', '20990101', '20990102')
    const reloaded = new CancellationStore()
    expect(reloaded.isCancelled('trip-1', '20990101')).toBe(true)
    expect(reloaded.isCancelled('trip-1', '20990102')).toBe(true)
  })

  it('restored trips persist across instances', async () => {
    store.cancelTrip('trip-1', '20990101', '20990102')
    store.restoreTrip('trip-1', '20990101')
    const reloaded = new CancellationStore()
    expect(reloaded.isCancelled('trip-1', '20990101')).toBe(false)
    expect(reloaded.isCancelled('trip-1', '20990102')).toBe(true)
  })
})
