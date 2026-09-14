import { describe, it, expect } from 'vitest'
import { SeededRng, nextGaussianFrom } from '../../../server/simulation/rng.js'

describe('SeededRng', () => {
  it('is deterministic for a given seed', () => {
    const a = new SeededRng(42)
    const b = new SeededRng(42)
    for (let i = 0; i < 100; i++) {
      expect(a.next()).toBe(b.next())
    }
  })

  it('produces different sequences for different seeds', () => {
    const a = new SeededRng(1)
    const b = new SeededRng(2)
    const firstA = a.next()
    const firstB = b.next()
    expect(firstA).not.toBe(firstB)
  })

  it('next() stays within [0, 1)', () => {
    const rng = new SeededRng(12345)
    for (let i = 0; i < 1000; i++) {
      const v = rng.next()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('nextInt() stays within [min, max] inclusive', () => {
    const rng = new SeededRng(7)
    for (let i = 0; i < 1000; i++) {
      const v = rng.nextInt(3, 8)
      expect(v).toBeGreaterThanOrEqual(3)
      expect(v).toBeLessThanOrEqual(8)
      expect(Number.isInteger(v)).toBe(true)
    }
  })

  it('nextGaussian() returns values with the configured mean', () => {
    const rng = new SeededRng(99)
    const samples: number[] = []
    for (let i = 0; i < 5000; i++) samples.push(rng.nextGaussian(5, 1))
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length
    expect(mean).toBeGreaterThan(4.7)
    expect(mean).toBeLessThan(5.3)
  })

  it('nextGaussianFrom() works with an arbitrary uniform source', () => {
    let n = 0
    const source = () => {
      n = (n + 1) % 100
      return n / 100
    }
    const values: number[] = []
    for (let i = 0; i < 200; i++) values.push(nextGaussianFrom(source, 0, 1))
    const finite = values.filter((v) => Number.isFinite(v))
    expect(finite.length).toBe(200)
  })
})
