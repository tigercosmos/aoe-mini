// T5 — projectile homing + impact (pipeline step 8, after combat).
//
// Each projectile homes on its target's CURRENT position. On impact (within
// PROJECTILE_HIT_DIST) it applies its locked projDamage via damageEntity (damage
// type from subtype: Arrow=pierce, Axe=melee; bonus already baked into projDamage
// at fire time, so bonus=0 here) and marks itself dead (hp=0) for deathSystem to
// sweep. If the target died mid-flight it simply fizzles (hp=0).
//
// Determinism: iterate ascending index; no RNG/clock/DOM access.

import type { World } from '../shared/world';
import { resolveHandle } from '../shared/world';
import { EntityKind, ProjectileType } from '../shared/enums';
import { PROJECTILE_HIT_DIST } from '../shared/constants';

import { damageEntity } from '../sim/actions';

export function projectileSystem(world: World): void {
  const { comp, em } = world;
  const cap = comp.capacity;

  for (let i = 0; i < cap; i++) {
    if (em.alive[i] !== 1) continue;
    if (comp.kind[i] !== EntityKind.Projectile) continue;
    if (comp.hp[i] <= 0) continue; // already spent this tick; deathSystem will sweep it

    const target = resolveHandle(em, comp.orderTarget[i]);
    if (target < 0) {
      // Target gone: fizzle. deathSystem will sweep hp<=0.
      comp.hp[i] = 0;
      continue;
    }

    const dx = comp.posX[target] - comp.posX[i];
    const dy = comp.posY[target] - comp.posY[i];
    const d = Math.sqrt(dx * dx + dy * dy);

    if (d <= PROJECTILE_HIT_DIST) {
      impact(world, i, target);
      continue;
    }

    const step = Math.min(comp.speed[i], d);
    comp.posX[i] += (dx / d) * step;
    comp.posY[i] += (dy / d) * step;

    if (d - step <= PROJECTILE_HIT_DIST) {
      impact(world, i, target);
    }
  }
}

function impact(world: World, projIdx: number, targetIdx: number): void {
  const { comp } = world;
  const isPierce = comp.subtype[projIdx] === ProjectileType.Arrow; // Axe = melee-type
  damageEntity(world, targetIdx, comp.projSource[projIdx], comp.projDamage[projIdx], isPierce, 0);
  comp.hp[projIdx] = 0; // mark dead; deathSystem removes it
}
