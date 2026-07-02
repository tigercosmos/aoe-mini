import { EntityKind } from '../shared/enums';
import type { World } from '../shared/world';

// Precomputed line-of-sight disc offsets, memoized per integer radius. Each
// entry is a flat Int16Array of interleaved (dx,dy) pairs covering every tile
// whose Euclidean distance from the centre is <= r (dx*dx + dy*dy <= r*r),
// including the centre itself. Discs are radius-only (never map-specific), so a
// single module-level cache is shared across all worlds and is deterministic.
const discCache = new Map<number, Int16Array>();

function discOffsets(r: number): Int16Array {
  const cached = discCache.get(r);
  if (cached !== undefined) return cached;
  const rr = r * r;
  // First pass: count.
  let count = 0;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= rr) count++;
    }
  }
  const offs = new Int16Array(count * 2);
  let i = 0;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= rr) {
        offs[i++] = dx;
        offs[i++] = dy;
      }
    }
  }
  discCache.set(r, offs);
  return offs;
}

/**
 * Recompute fog-of-war for every player from current world state.
 * Clears all `visible` bits, then for each alive non-projectile entity ORs
 * (1 << owner) into both `visible` and `explored` for every tile within its
 * integer LOS radius (using the precomputed disc offsets). Iterates entities
 * in ascending index order for determinism. Reads only world state — no RNG,
 * no clocks.
 */
export function updateVisibility(world: World): void {
  const { em, comp, map } = world;
  const size = map.size;
  const visible = map.visible;
  const explored = map.explored;

  visible.fill(0);

  const capacity = em.capacity;
  const alive = em.alive;
  for (let i = 0; i < capacity; i++) {
    if (alive[i] !== 1) continue;
    if (comp.kind[i] === EntityKind.Projectile) continue;

    const bit = 1 << comp.owner[i];
    const cx = Math.floor(comp.posX[i]);
    const cy = Math.floor(comp.posY[i]);
    let r = Math.round(comp.los[i]);
    if (r < 0) r = 0;

    const offs = discOffsets(r);
    for (let o = 0; o < offs.length; o += 2) {
      const tx = cx + offs[o];
      const ty = cy + offs[o + 1];
      if (tx < 0 || ty < 0 || tx >= size || ty >= size) continue;
      const idx = ty * size + tx;
      visible[idx] |= bit;
      explored[idx] |= bit;
    }
  }
}
