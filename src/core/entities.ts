import { MAX_ENTITIES } from '../shared/constants';
import { makeHandle } from '../shared/world';
import type { EntityManager } from '../shared/world';

/**
 * Deterministic entity manager (T1).
 *
 * Slots are addressed by INDEX (0..capacity-1). Every live reference stored elsewhere is a
 * HANDLE = makeHandle(index, generation[index]); `generation` is bumped on every destroy so a
 * handle to a recycled slot resolves to -1 (see resolveHandle in src/shared/world.ts).
 *
 * Determinism: create() ALWAYS reuses the lowest free index. We keep a binary min-heap of freed
 * indices plus a high-water mark for indices never handed out; the overall lowest free index is
 * the heap minimum when the heap is non-empty (all freed indices are < highWater), otherwise the
 * high-water mark itself. No Math.random / Date / DOM — pure integer bookkeeping.
 */
export function createEntityManager(capacity: number = MAX_ENTITIES): EntityManager {
  const alive = new Uint8Array(capacity);
  const generation = new Uint16Array(capacity);

  // Min-heap of freed indices (each < highWater and currently dead).
  const freeHeap: number[] = [];
  // Indices in [0, highWater) have been allocated at least once.
  let highWater = 0;

  function heapPush(v: number): void {
    freeHeap.push(v);
    let i = freeHeap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (freeHeap[parent] <= freeHeap[i]) break;
      const tmp = freeHeap[parent];
      freeHeap[parent] = freeHeap[i];
      freeHeap[i] = tmp;
      i = parent;
    }
  }

  function heapPopMin(): number {
    const top = freeHeap[0];
    const last = freeHeap.pop() as number;
    if (freeHeap.length > 0) {
      freeHeap[0] = last;
      const n = freeHeap.length;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < n && freeHeap[l] < freeHeap[smallest]) smallest = l;
        if (r < n && freeHeap[r] < freeHeap[smallest]) smallest = r;
        if (smallest === i) break;
        const tmp = freeHeap[i];
        freeHeap[i] = freeHeap[smallest];
        freeHeap[smallest] = tmp;
        i = smallest;
      }
    }
    return top;
  }

  const em: EntityManager = {
    capacity,
    aliveCount: 0,
    alive,
    generation,
    create(): number {
      if (em.aliveCount >= capacity) throw new Error('entity capacity exceeded');
      let index: number;
      if (freeHeap.length > 0) {
        index = heapPopMin();
      } else {
        index = highWater;
        highWater++;
      }
      alive[index] = 1;
      em.aliveCount++;
      return index;
    },
    destroy(index: number): void {
      if (index < 0 || index >= capacity || alive[index] !== 1) return;
      alive[index] = 0;
      // Uint16Array assignment wraps mod 65536; mask kept explicit for clarity.
      generation[index] = (generation[index] + 1) & 0xffff;
      em.aliveCount--;
      heapPush(index);
    },
    isAlive(index: number): boolean {
      return index >= 0 && index < capacity && alive[index] === 1;
    },
    handleFor(index: number): number {
      return makeHandle(index, generation[index]);
    },
  };
  return em;
}
