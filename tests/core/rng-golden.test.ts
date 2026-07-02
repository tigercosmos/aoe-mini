import { describe, it, expect } from 'vitest';
import { createRng, rngNext, rngInt, rngRange } from '../../src/shared/rng';

// PRNG lives in the FROZEN shared contract (review requiredChanges #1: rng moved to
// src/shared/rng.ts). T1 keeps the golden / reproducibility oracle here in tests/core,
// importing from shared, since the whole determinism story depends on this sequence.

// Precomputed from the exact frozen mulberry32 body (seed = 1, first 5 draws).
const GOLDEN_SEED1 = [
  0.62707394058816135,
  0.0027357211802154779,
  0.52744703995995224,
  0.98105096747167408,
  0.96837789821438491,
];

describe('mulberry32 (src/shared/rng)', () => {
  it('matches precomputed golden values for seed 1', () => {
    const r = createRng(1);
    for (const expected of GOLDEN_SEED1) {
      expect(rngNext(r)).toBeCloseTo(expected, 15);
    }
  });

  it('produces an identical 1000-value sequence for the same seed', () => {
    const a = createRng(777);
    const b = createRng(777);
    for (let i = 0; i < 1000; i++) {
      expect(rngNext(a)).toBe(rngNext(b)); // exact bit-for-bit reproducibility
    }
  });

  it('diverges for different seeds', () => {
    const a = createRng(1);
    const b = createRng(2);
    // First draws already differ; over a window the sequences are not identical.
    let anyDifferent = false;
    for (let i = 0; i < 50; i++) {
      if (rngNext(a) !== rngNext(b)) anyDifferent = true;
    }
    expect(anyDifferent).toBe(true);
  });

  it('coerces the seed with >>> 0 (negative / float seeds normalise)', () => {
    const a = createRng(-1);          // -1 >>> 0 === 0xffffffff
    const b = createRng(0xffffffff);
    for (let i = 0; i < 20; i++) expect(rngNext(a)).toBe(rngNext(b));
  });

  it('rngNext stays within [0, 1)', () => {
    const r = createRng(42);
    for (let i = 0; i < 5000; i++) {
      const v = rngNext(r);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('rngInt returns integers in [0, maxExclusive) and is reproducible', () => {
    const r1 = createRng(9);
    const r2 = createRng(9);
    for (let i = 0; i < 2000; i++) {
      const v = rngInt(r1, 6);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(6);
      expect(rngInt(r2, 6)).toBe(v);
    }
  });

  it('rngRange returns values in [min, max) and is reproducible', () => {
    const r1 = createRng(123);
    const r2 = createRng(123);
    for (let i = 0; i < 2000; i++) {
      const v = rngRange(r1, -3, 7);
      expect(v).toBeGreaterThanOrEqual(-3);
      expect(v).toBeLessThan(7);
      expect(rngRange(r2, -3, 7)).toBe(v);
    }
  });
});
