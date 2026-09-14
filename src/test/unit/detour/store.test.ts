import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DetourStore } from '../../../server/detour/store.js'
import type { Detour } from '../../../server/detour/types.js'
import { createTempDir } from '../../helpers/database.js'

// DetourStore persists to `PERSISTENT_DATA_DIR`/detours.json. Each test gets
// its own temp dir so stores never touch dev data or each other.
describe('DetourStore', () => {
  let tmp: { dir: string; cleanup: () => void }
  let store: DetourStore

  beforeEach(() => {
    tmp = createTempDir()
    process.env.PERSISTENT_DATA_DIR = tmp.dir
    store = new DetourStore()
  })

  afterEach(() => {
    delete process.env.PERSISTENT_DATA_DIR
    tmp.cleanup()
  })

  function makeDetour(overrides: Partial<Detour> = {}): Detour {
    const now = Date.now()
    return {
      id: overrides.id ?? 'detour-1',
      routeId: '1',
      directionId: 0,
      startStopId: 'S1',
      endStopId: 'S3',
      replacementStops: [],
      detourShape: [
        [41.8, -87.6],
        [41.9, -87.6],
      ],
      startTime: overrides.startTime ?? new Date(now - 3600_000).toISOString(),
      endTime: overrides.endTime ?? new Date(now + 3600_000).toISOString(),
      description: 'Test detour',
      createdAt: new Date().toISOString(),
      ...overrides,
    }
  }

  it('starts empty', () => {
    expect(store.getAll()).toEqual([])
  })

  it('adds and retrieves a detour by id', () => {
    const d = makeDetour()
    store.add(d)
    expect(store.get('detour-1')?.routeId).toBe('1')
    expect(store.getAll()).toHaveLength(1)
  })

  it('returns undefined for a missing detour', () => {
    expect(store.get('nope')).toBeUndefined()
  })

  it('removes a detour', () => {
    store.add(makeDetour())
    expect(store.remove('detour-1')).toBe(true)
    expect(store.remove('detour-1')).toBe(false)
    expect(store.getAll()).toEqual([])
  })

  it('getActive only returns detours whose window contains now', () => {
    const past = makeDetour({
      id: 'past',
      startTime: new Date(Date.now() - 7200_000).toISOString(),
      endTime: new Date(Date.now() - 3600_000).toISOString(),
    })
    const active = makeDetour({ id: 'active' })
    const future = makeDetour({
      id: 'future',
      startTime: new Date(Date.now() + 3600_000).toISOString(),
      endTime: new Date(Date.now() + 7200_000).toISOString(),
    })
    for (const d of [past, active, future]) store.add(d)

    const activeNow = store.getActive(new Date())
    const ids = activeNow.map((d) => d.id).sort()
    expect(ids).toEqual(['active'])
  })

  it('filters by route + direction', () => {
    store.add(makeDetour({ id: 'd0', routeId: '1', directionId: 0 }))
    store.add(makeDetour({ id: 'd1', routeId: '1', directionId: 1 }))
    store.add(makeDetour({ id: 'd2', routeId: '2', directionId: 0 }))
    const forRoute1 = store.getForRoute('1', 1).map((d) => d.id)
    expect(forRoute1).toEqual(['d1'])
    const activeForRoute1 = store.getActiveForRoute('1', 0, new Date()).map((d) => d.id)
    expect(activeForRoute1).toEqual(['d0'])
  })

  it('persists detours across instances', () => {
    store.add(makeDetour())
    const reloaded = new DetourStore()
    expect(reloaded.get('detour-1')).toBeDefined()
    expect(reloaded.get('detour-1')?.routeId).toBe('1')
  })

  it('persists removals across instances', () => {
    store.add(makeDetour())
    store.remove('detour-1')
    const reloaded = new DetourStore()
    expect(reloaded.getAll()).toEqual([])
  })
})
