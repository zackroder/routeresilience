import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InstructionStore } from '../../../server/instructions/store.js'
import type { CreateInstructionInput } from '../../../server/instructions/types.js'
import { createTempDir } from '../../helpers/database.js'

// InstructionStore persists to `PERSISTENT_DATA_DIR`/instructions.json.
describe('InstructionStore', () => {
  let tmp: { dir: string; cleanup: () => void }
  let store: InstructionStore

  const input: CreateInstructionInput = {
    vehicleId: 'v1',
    tripId: 't1',
    routeId: '1',
    action: 'HOLD',
    controlPointStopId: 'S2',
    controlPointStopName: 'Central',
    holdSeconds: 60,
    message: 'Hold 60s at Central',
    source: 'dispatcher',
  }

  beforeEach(() => {
    tmp = createTempDir()
    process.env.PERSISTENT_DATA_DIR = tmp.dir
    store = new InstructionStore()
  })

  afterEach(() => {
    delete process.env.PERSISTENT_DATA_DIR
    tmp.cleanup()
  })

  it('creates an instruction in SENT state', () => {
    const inst = store.create(input)
    expect(inst.status).toBe('SENT')
    expect(inst.id).toMatch(/^inst_/)
    expect(inst.acknowledgedAt).toBeNull()
    expect(inst.completedAt).toBeNull()
  })

  it('creates an expiry 15 min in the future', () => {
    const before = Date.now()
    const inst = store.create(input)
    const after = Date.now()
    expect(inst.expiresAt).toBeGreaterThanOrEqual(before + 15 * 60 * 1000)
    expect(inst.expiresAt).toBeLessThanOrEqual(after + 15 * 60 * 1000)
  })

  it('gets and lists instructions newest-first', () => {
    const a = store.create(input)
    const b = store.create({ ...input, vehicleId: 'v2' })
    const all = store.listAll()
    expect(all[0].id).toBe(b.id)
    expect(all[1].id).toBe(a.id)
    expect(store.get(a.id)?.id).toBe(a.id)
  })

  it('acknowledges an instruction', () => {
    const inst = store.create(input)
    const acked = store.acknowledge(inst.id)
    expect(acked?.status).toBe('ACKNOWLEDGED')
    expect(acked?.acknowledgedAt).not.toBeNull()
    expect(store.listActive().some((i) => i.id === inst.id)).toBe(true)
  })

  it('completes and cancels instructions', () => {
    const inst = store.create(input)
    expect(store.complete(inst.id)?.status).toBe('COMPLETED')
    expect(store.listActive().some((i) => i.id === inst.id)).toBe(false)

    const other = store.create(input)
    expect(store.cancel(other.id)?.status).toBe('CANCELLED')
    expect(store.listActive().some((i) => i.id === other.id)).toBe(false)
  })

  it('returns undefined for missing ids', () => {
    expect(store.acknowledge('missing')).toBeUndefined()
    expect(store.complete('missing')).toBeUndefined()
    expect(store.cancel('missing')).toBeUndefined()
  })

  it('expires SENT instructions older than the TTL', () => {
    const inst = store.create(input)
    const future = inst.expiresAt + 1000
    const active = store.listActive(future)
    expect(active.some((i) => i.id === inst.id)).toBe(false)
  })

  it('keeps SENT instructions active before expiry', () => {
    const inst = store.create(input)
    const before = inst.expiresAt - 1000
    expect(store.listActive(before).some((i) => i.id === inst.id)).toBe(true)
  })

  it('persists instructions across instances', () => {
    const inst = store.create(input)
    const reloaded = new InstructionStore()
    expect(reloaded.get(inst.id)?.status).toBe('SENT')
  })

  it('persists state changes across instances', () => {
    const inst = store.create(input)
    store.acknowledge(inst.id)
    const reloaded = new InstructionStore()
    expect(reloaded.get(inst.id)?.status).toBe('ACKNOWLEDGED')
  })
})
