import { describe, it, expect } from 'vitest';
import { createEntityManager } from '../../src/core/entities';
import { resolveHandle } from '../../src/shared/world';

describe('createEntityManager', () => {
  it('hands out ascending indices 0,1,2,... from empty', () => {
    const em = createEntityManager(8);
    expect(em.create()).toBe(0);
    expect(em.create()).toBe(1);
    expect(em.create()).toBe(2);
    expect(em.aliveCount).toBe(3);
  });

  it('tracks aliveCount across create/destroy', () => {
    const em = createEntityManager(16);
    em.create();
    em.create();
    em.create();
    expect(em.aliveCount).toBe(3);
    em.destroy(1);
    expect(em.aliveCount).toBe(2);
    em.destroy(0);
    expect(em.aliveCount).toBe(1);
  });

  it('reuses the lowest free index and bumps its generation', () => {
    const em = createEntityManager(16);
    em.create(); // 0
    em.create(); // 1
    em.create(); // 2
    const gen1Before = em.generation[1];
    em.destroy(1);
    // Lowest free index is 1 -> reused before extending the high-water mark.
    expect(em.create()).toBe(1);
    expect(em.generation[1]).toBe(gen1Before + 1);
    expect(em.isAlive(1)).toBe(true);
  });

  it('always reuses the LOWEST free index (not most-recently freed)', () => {
    const em = createEntityManager(16);
    for (let i = 0; i < 6; i++) em.create(); // 0..5
    // Free in a scrambled order; lowest free must come back first regardless.
    em.destroy(4);
    em.destroy(1);
    em.destroy(3);
    expect(em.create()).toBe(1);
    expect(em.create()).toBe(3);
    expect(em.create()).toBe(4);
    expect(em.create()).toBe(6); // heap empty -> extend high-water mark
  });

  it('resolveHandle rejects stale handles after recycle', () => {
    const em = createEntityManager(16);
    const a = em.create(); // 0
    em.create();           // 1
    const staleHandle = em.handleFor(a);
    expect(resolveHandle(em, staleHandle)).toBe(a);
    em.destroy(a);
    // Handle now stale (dead + generation bumped).
    expect(resolveHandle(em, staleHandle)).toBe(-1);
    const reused = em.create(); // recycles index 0 with a new generation
    expect(reused).toBe(a);
    expect(resolveHandle(em, staleHandle)).toBe(-1); // still stale
    expect(resolveHandle(em, em.handleFor(reused))).toBe(reused); // fresh handle resolves
  });

  it('resolveHandle returns -1 for the -1 sentinel', () => {
    const em = createEntityManager(16);
    expect(resolveHandle(em, -1)).toBe(-1);
  });

  it('throws "entity capacity exceeded" when full', () => {
    const em = createEntityManager(3);
    em.create();
    em.create();
    em.create();
    expect(() => em.create()).toThrowError('entity capacity exceeded');
    // Freeing a slot lets creation resume.
    em.destroy(0);
    expect(em.create()).toBe(0);
    expect(() => em.create()).toThrowError('entity capacity exceeded');
  });

  it('destroy is a no-op on dead / out-of-range indices', () => {
    const em = createEntityManager(4);
    em.create(); // 0
    const genBefore = em.generation[0];
    em.destroy(2);   // never alive
    em.destroy(-1);  // out of range
    em.destroy(99);  // out of range
    expect(em.aliveCount).toBe(1);
    em.destroy(0);
    em.destroy(0);   // double destroy must not bump generation twice or corrupt count
    expect(em.aliveCount).toBe(0);
    expect(em.generation[0]).toBe(genBefore + 1);
  });

  it('handleFor round-trips through makeHandle semantics', () => {
    const em = createEntityManager(16);
    const i = em.create();
    const h = em.handleFor(i);
    expect(resolveHandle(em, h)).toBe(i);
  });
});
