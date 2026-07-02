// T4 sim engine — death sweep. Keys ONLY on hp <= 0 (review requiredChanges #7).
import { tileIndex } from '../shared/constants';
import { EntityKind } from '../shared/enums';
import type { PlayerId, UnitType } from '../shared/enums';
import type { World } from '../shared/world';
import { resolveHandle } from '../shared/world';
import { resetEntityComponents } from '../core/components';
import { resolveUnitStats } from '../content/stats';
import { emit, recomputePopCap } from './actions';

/** Remove all entities whose hp has dropped to <= 0. Emits `died` for units/buildings (not
 *  projectiles), clears building occupancy + invalidates the path cache, and keeps
 *  population/popCap in sync. Iterates ascending index for determinism. */
export function deathSystem(world: World): void {
  const { comp, em, map, players } = world;
  const size = map.size;
  const cap = comp.capacity;

  for (let i = 0; i < cap; i++) {
    if (em.alive[i] !== 1) continue;
    if (comp.hp[i] > 0) continue;

    const kind = comp.kind[i] as EntityKind;

    // Projectiles are swept silently (no `died` event, no population effects).
    if (kind === EntityKind.Projectile) {
      resetEntityComponents(comp, i);
      em.destroy(i);
      continue;
    }

    const owner = comp.owner[i] as PlayerId;
    const subtype = comp.subtype[i];

    // Kill credit: last attacker recorded in projSource (or -1 / stale => -1).
    let killer: PlayerId = -1;
    const srcH = comp.projSource[i];
    if (srcH >= 0) {
      const srcIdx = resolveHandle(em, srcH);
      killer = srcIdx >= 0 ? (comp.owner[srcIdx] as PlayerId) : -1;
    }

    const handle = em.handleFor(i);
    emit(world, {
      type: 'died',
      entity: handle,
      owner,
      kind,
      subtype,
      x: comp.posX[i],
      y: comp.posY[i],
      killer,
    });

    if (kind === EntityKind.Building) {
      const sx = comp.sizeX[i];
      const sy = comp.sizeY[i];
      const tileX0 = Math.round(comp.posX[i] - sx / 2);
      const tileY0 = Math.round(comp.posY[i] - sy / 2);
      for (let dy = 0; dy < sy; dy++) {
        for (let dx = 0; dx < sx; dx++) {
          const tx = tileX0 + dx;
          const ty = tileY0 + dy;
          if (tx < 0 || ty < 0 || tx >= size || ty >= size) continue;
          const t = tileIndex(size, tx, ty);
          if (map.occupant[t] === handle) map.occupant[t] = -1;
        }
      }
      world.pathCache.version++;
      world.pathCache.entries.clear();
      recomputePopCap(world, owner);
    } else {
      // Unit: subtract its (invariant) population cost.
      const s = resolveUnitStats(world, owner, subtype as UnitType);
      players[owner].population -= s.popCost;
    }

    resetEntityComponents(comp, i);
    em.destroy(i);
  }
}
