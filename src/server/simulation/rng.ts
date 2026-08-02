// ─── Deterministic Random Number Generation ───
// Lets the simulation produce reproducible schedule-adherence behavior for
// scenario testing, while staying a drop-in replacement for Math.random().

/** Uniform [0, 1) random source. */
export type RandomFn = () => number;

/**
 * Seeded PRNG (mulberry32). Deterministic for a given seed, so simulation
 * scenarios can be reproduced run-to-run.
 */
export class SeededRng {
    private state: number;

    constructor(seed: number) {
        this.state = seed >>> 0;
    }

    /** Uniform [0, 1). */
    next(): number {
        this.state = (this.state + 0x6d2b79f5) >>> 0;
        let t = this.state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    /** Standard normal via Box–Muller. */
    nextGaussian(mean = 0, std = 1): number {
        const u1 = Math.max(this.next(), 1e-12);
        const u2 = this.next();
        const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
        return mean + z * std;
    }

    /** Integer in [min, max] inclusive. */
    nextInt(min: number, max: number): number {
        return min + Math.floor(this.next() * (max - min + 1));
    }
}

/** Box–Muller standard normal from an arbitrary uniform source. */
export function nextGaussianFrom(rng: RandomFn, mean = 0, std = 1): number {
    const u1 = Math.max(rng(), 1e-12);
    const u2 = rng();
    const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    return mean + z * std;
}
