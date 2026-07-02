// T5 — production / research queue advancement (pipeline step 4).
//
// Per building that is completed (not under construction) and has a non-empty
// queue: advance queue[0].ticksLeft. On completion:
//   - unit: if pop-blocked hold at ticksLeft 0; else spawn at a deterministic
//     adjacent tile (T2 adjacentSpawnTile), shift queue, apply rally as a Move.
//   - tech: mark researched, applyTechEffects (T3), emit researchComplete and
//     ageAdvanced (when the tech advanced the age), shift queue.
//
// Determinism: iterate buildings by ascending index; spawn tile from the pinned
// adjacentSpawnTile scan; no RNG/clock/DOM access.

import type { World } from '../shared/world';
import { resolveHandle } from '../shared/world';
import { EntityKind, OrderType, FLAG_UNDER_CONSTRUCTION } from '../shared/enums';
import { tileXOf, tileYOf } from '../shared/constants';

// Allowed cross-task imports.
import { emit, spawnUnit } from '../sim/actions';
import { clearPath } from '../sim/movement';
import { adjacentSpawnTile } from '../map/tilemap';
import { resolveUnitStats, applyTechEffects } from '../content/stats';
import { TECHS } from '../content/techs';

export function productionSystem(world: World): void {
  const { comp, em, map, players } = world;
  const cap = comp.capacity;
  const size = map.size;

  for (let i = 0; i < cap; i++) {
    if (em.alive[i] !== 1) continue;
    if (comp.kind[i] !== EntityKind.Building) continue;
    if ((comp.flags[i] & FLAG_UNDER_CONSTRUCTION) !== 0) continue;

    const queue = comp.queue[i];
    if (!queue || queue.length === 0) continue;

    const item = queue[0];
    item.ticksLeft -= 1;
    if (item.ticksLeft > 0) continue;

    const owner = comp.owner[i];

    if (item.kind === 'unit') {
      const rs = resolveUnitStats(world, owner, item.unit);
      const popCost = rs.popCost;
      const player = players[owner];
      if (player.population + popCost > player.populationCap) {
        // Housed: hold completed unit at the threshold until pop frees up.
        item.ticksLeft = 0;
        continue;
      }

      // Footprint anchor (top-left) from center: posX = tileX + sizeX/2.
      const bx = Math.round(comp.posX[i] - comp.sizeX[i] / 2);
      const by = Math.round(comp.posY[i] - comp.sizeY[i] / 2);
      const spawnTile = adjacentSpawnTile(map, bx, by, comp.sizeX[i], comp.sizeY[i]);
      if (spawnTile < 0) {
        // No room adjacent: hold and retry next tick.
        item.ticksLeft = 0;
        continue;
      }

      const sx = tileXOf(size, spawnTile) + 0.5;
      const sy = tileYOf(size, spawnTile) + 0.5;
      const handle = spawnUnit(world, owner, item.unit, sx, sy);
      queue.shift();

      // Apply rally point as a Move order on the fresh unit.
      if (comp.rallyX[i] >= 0) {
        const uIdx = resolveHandle(em, handle);
        if (uIdx >= 0) {
          comp.orderType[uIdx] = OrderType.Move;
          comp.orderX[uIdx] = comp.rallyX[i];
          comp.orderY[uIdx] = comp.rallyY[i];
          comp.orderTarget[uIdx] = -1;
          clearPath(world, uIdx);
        }
      }
    } else {
      // tech
      const tech = item.tech;
      const player = players[owner];
      const ageBefore = player.age;
      player.researched[tech] = 1;
      applyTechEffects(world, owner, tech);
      emit(world, { type: 'researchComplete', player: owner, tech });
      if (player.age !== ageBefore) {
        emit(world, { type: 'ageAdvanced', player: owner, age: player.age });
      }
      // review #17a: an upgradeLine tech also converts this player's PENDING queued
      // 'from' units to 'to' (ticksLeft unchanged). applyTechEffects already handled
      // the LIVE units; queues are sim-owned so we convert them here.
      for (const eff of TECHS[tech].effects) {
        if (eff.type === 'upgradeLine') convertQueuedUnits(world, owner, eff.from, eff.to);
      }
      queue.shift();
    }
  }
}

/** Convert every pending queued 'from' unit item (this player's buildings) to 'to', ticksLeft unchanged. */
function convertQueuedUnits(world: World, player: number, from: number, to: number): void {
  const { comp, em } = world;
  const cap = comp.capacity;
  for (let i = 0; i < cap; i++) {
    if (em.alive[i] !== 1) continue;
    if (comp.kind[i] !== EntityKind.Building) continue;
    if (comp.owner[i] !== player) continue;
    const q = comp.queue[i];
    if (!q) continue;
    for (let k = 0; k < q.length; k++) {
      const it = q[k];
      if (it.kind === 'unit' && it.unit === from) it.unit = to as typeof it.unit;
    }
  }
}
