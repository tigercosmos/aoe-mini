import type { Rng } from './world';

// mulberry32 PRNG (review requiredChanges #1). Foundation-authored with EXACT bodies so
// downstream golden tests are stable across all tasks (T2 mapgen, T4 sim, T6 AI). world.rng
// is sim-owned; each AIPlayer keeps a private Rng seeded with (matchSeed ^ (playerId * 0x9E3779B9)).

export function createRng(seed: number): Rng { return { s: seed >>> 0 }; }

export function rngNext(r: Rng): number {
  r.s = (r.s + 0x6D2B79F5) >>> 0;
  let t = r.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function rngInt(r: Rng, maxExclusive: number): number { return (rngNext(r) * maxExclusive) | 0; }

export function rngRange(r: Rng, min: number, max: number): number { return min + rngNext(r) * (max - min); }
