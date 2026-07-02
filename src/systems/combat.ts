// T5 — combat: target acquisition, melee swings, ranged fire, chase (pipeline
// step 7, runs AFTER movementSystem so world.grid reflects this tick's positions
// and may be queried here — see world.ts SpatialGrid doc + review #3).
//
// Rules pinned by review:
//  #10/#17h bonusSum is always summed from the BASE table UNIT_STATS[subtype].bonuses.
//  #11 chase: re-path only when there is no active path OR ((tick+index)%5===0 &&
//      the target's tile changed); steer straight (single-waypoint path) toward an
//      in-LOS target when the next tile toward it is walkable.
//  #12 attackCooldown = max(0, cooldown-1) each pass; swing when <=0 && in range;
//      on swing attackCooldown += attackRateTicks (fractional carry).
//
// Determinism: iterate ascending index; grid.queryCircle returns ascending indexes
// so nearest-target ties break to the lowest index; no RNG/clock/DOM access.

import type { World } from '../shared/world';
import { resolveHandle } from '../shared/world';
import {
  EntityKind,
  OrderType,
  UnitType,
  BuildingType,
  ProjectileType,
  GAIA,
  FLAG_UNDER_CONSTRUCTION,
} from '../shared/enums';
import { TICK_RATE, QUERY_BUFFER_SIZE, tileIndex } from '../shared/constants';

// Allowed cross-task imports.
import { emit, damageEntity } from '../sim/actions';
import { requestPath, clearPath } from '../sim/movement';
import { isWalkable } from '../map/tilemap';
import { resolveUnitStats } from '../content/stats';
import { UNIT_STATS } from '../content/units';
import { BUILDING_STATS } from '../content/buildings';

// Buildings fire arrows; the base table has no per-building projectile speed, so
// pin it to the standard arrow speed (7 tiles/s, matching archer arrows).
const BUILDING_ARROW_SPEED_PER_TICK = 7 / TICK_RATE;
const MELEE_RANGE_PAD = 0.2;

// Caller-owned scratch for grid queries (zero per-tick allocation).
const _scratch = new Int32Array(QUERY_BUFFER_SIZE);

export function combatSystem(world: World): void {
  const { comp, em } = world;
  const cap = comp.capacity;

  for (let i = 0; i < cap; i++) {
    if (em.alive[i] !== 1) continue;
    const kind = comp.kind[i];
    if (kind === EntityKind.Projectile) continue;
    if (comp.attack[i] <= 0) continue; // sheep / non-defensive buildings
    if (kind === EntityKind.Building && (comp.flags[i] & FLAG_UNDER_CONSTRUCTION) !== 0) continue;

    // Cooldown decays for every attack-capable entity each pass (review #12).
    comp.attackCooldown[i] = Math.max(0, comp.attackCooldown[i] - 1);

    if (kind === EntityKind.Building) {
      // Buildings re-acquire the nearest enemy in LOS every tick; never move.
      const bt = acquireTarget(world, i);
      comp.orderTarget[i] = bt >= 0 ? em.handleFor(bt) : -1;
      if (bt >= 0) engage(world, i, bt, false);
      continue;
    }

    // Units.
    const subtype = comp.subtype[i];
    const isMilitary = subtype !== UnitType.Villager && subtype !== UnitType.Sheep;
    const order = comp.orderType[i];

    let tIdx = -1;
    if (order === OrderType.AttackTarget || order === OrderType.AttackMove) {
      tIdx = resolveHandle(em, comp.orderTarget[i]);
    }

    if (tIdx < 0 && isMilitary && (order === OrderType.Idle || order === OrderType.AttackMove)) {
      tIdx = acquireTarget(world, i);
      if (tIdx >= 0) {
        comp.orderTarget[i] = em.handleFor(tIdx);
        if (order === OrderType.Idle) comp.orderType[i] = OrderType.AttackTarget;
      }
    }

    if (tIdx >= 0) {
      engage(world, i, tIdx, true);
    } else if (order === OrderType.AttackTarget) {
      // Commanded target is gone.
      comp.orderTarget[i] = -1;
      if (isMilitary) {
        // Move to its last-known position (orderX/Y tracked) and re-scan there.
        comp.orderType[i] = OrderType.AttackMove;
      } else {
        comp.orderType[i] = OrderType.Idle;
        clearPath(world, i);
      }
    }
    // AttackMove with no target: keep moving toward orderX/Y (movement handles).
  }
}

function engage(world: World, i: number, tIdx: number, isUnit: boolean): void {
  const { comp, em } = world;
  const tx = comp.posX[tIdx];
  const ty = comp.posY[tIdx];
  const dx = tx - comp.posX[i];
  const dy = ty - comp.posY[i];
  const dist = Math.sqrt(dx * dx + dy * dy);
  const range = comp.attackRange[i];
  const rT = comp.radius[tIdx];

  // Track last-known target position for AttackTarget -> AttackMove fallback.
  if (comp.orderType[i] === OrderType.AttackTarget) {
    comp.orderX[i] = tx;
    comp.orderY[i] = ty;
  }

  const inRange =
    range === 0 ? dist <= comp.radius[i] + rT + MELEE_RANGE_PAD : dist <= range + rT;

  if (inRange) {
    if (isUnit) clearPath(world, i); // stop moving while attacking
    if (comp.attackCooldown[i] <= 0) {
      if (range === 0) {
        const bonus = bonusSum(world, i, tIdx);
        damageEntity(world, tIdx, em.handleFor(i), comp.attack[i], false, bonus);
      } else {
        spawnProjectile(world, i, em.handleFor(tIdx));
      }
      comp.attackCooldown[i] += comp.attackRateTicks[i];
    }
  } else if (isUnit && comp.speed[i] > 0) {
    chase(world, i, tx, ty, dist);
  }
}

/** Chase throttle + straight-steer per review #11. */
function chase(world: World, i: number, tx: number, ty: number, dist: number): void {
  const { comp, map } = world;
  const size = map.size;
  const targetTile = tileIndex(size, Math.floor(tx), Math.floor(ty));

  const path = comp.path[i];
  const hasPath = comp.pathStep[i] >= 0 && path != null && path.length > 0;
  const goalTile = hasPath ? path![path!.length - 1] : -1;
  const throttled = (world.tick + i) % 5 === 0;
  const needRepath = !hasPath || (throttled && targetTile !== goalTile);
  if (!needRepath) return;

  if (dist <= comp.los[i] && nextTileWalkable(world, i, tx, ty)) {
    // Steer straight: a single waypoint at the target tile, no A*.
    comp.path[i] = Uint16Array.of(targetTile);
    comp.pathStep[i] = 0;
    comp.pathVersion[i] = world.pathCache.version;
  } else {
    requestPath(world, i, tx, ty);
  }
}

function nextTileWalkable(world: World, i: number, tx: number, ty: number): boolean {
  const { comp, map } = world;
  const cx = Math.floor(comp.posX[i]);
  const cy = Math.floor(comp.posY[i]);
  const gx = Math.floor(tx);
  const gy = Math.floor(ty);
  const sx = Math.sign(gx - cx);
  const sy = Math.sign(gy - cy);
  const nx = cx + sx;
  const ny = cy + sy;
  if (nx === cx && ny === cy) return true;
  return isWalkable(map, nx, ny);
}

/** Nearest enemy (not self, not Gaia, not projectile) within LOS; tie -> lowest index. */
function acquireTarget(world: World, i: number): number {
  const { comp, grid } = world;
  const r = comp.los[i];
  if (r <= 0) return -1;
  const n = grid.queryCircle(comp.posX[i], comp.posY[i], r, _scratch);
  const myOwner = comp.owner[i];
  const r2 = r * r;
  let best = -1;
  let bestD2 = Infinity;
  for (let k = 0; k < n; k++) {
    const j = _scratch[k];
    if (j === i) continue;
    if (comp.kind[j] === EntityKind.Projectile) continue;
    const oj = comp.owner[j];
    if (oj === myOwner || oj === GAIA) continue;
    const dx = comp.posX[j] - comp.posX[i];
    const dy = comp.posY[j] - comp.posY[i];
    const d2 = dx * dx + dy * dy;
    if (d2 > r2) continue;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = j; // ascending j from queryCircle => ties favour lowest index
    }
  }
  return best;
}

function armorClassesOf(world: World, idx: number): number {
  const { comp } = world;
  if (comp.kind[idx] === EntityKind.Building) {
    return BUILDING_STATS[comp.subtype[idx] as BuildingType].armorClasses;
  }
  return UNIT_STATS[comp.subtype[idx] as UnitType].armorClasses;
}

/** Sum of the attacker's base AttackBonus amounts whose classMask hits the target. */
function bonusSum(world: World, attackerIdx: number, targetIdx: number): number {
  const { comp } = world;
  if (comp.kind[attackerIdx] !== EntityKind.Unit) return 0; // buildings have no bonuses
  const bonuses = UNIT_STATS[comp.subtype[attackerIdx] as UnitType].bonuses;
  if (!bonuses || bonuses.length === 0) return 0;
  const tArmor = armorClassesOf(world, targetIdx);
  let sum = 0;
  for (let b = 0; b < bonuses.length; b++) {
    if ((bonuses[b].classMask & tArmor) !== 0) sum += bonuses[b].amount;
  }
  return sum;
}

/**
 * Create a projectile from `fromIdx` homing on `targetHandle`. projDamage locks
 * (effective attack + bonusSum vs current target) at fire time; damage type is
 * derived from subtype at impact (Arrow=pierce, Axe=melee). Returns its handle.
 */
export function spawnProjectile(world: World, fromIdx: number, targetHandle: number): number {
  const { comp, em } = world;
  const owner = comp.owner[fromIdx];

  let projType: ProjectileType;
  let projSpeed: number;
  if (comp.kind[fromIdx] === EntityKind.Unit) {
    const rs = resolveUnitStats(world, owner, comp.subtype[fromIdx] as UnitType);
    projType = rs.projectile === -1 ? ProjectileType.Arrow : rs.projectile;
    projSpeed = rs.projectileSpeedPerTick > 0 ? rs.projectileSpeedPerTick : BUILDING_ARROW_SPEED_PER_TICK;
  } else {
    projType = ProjectileType.Arrow;
    projSpeed = BUILDING_ARROW_SPEED_PER_TICK;
  }

  const targetIdx = resolveHandle(em, targetHandle);
  const bonus = targetIdx >= 0 ? bonusSum(world, fromIdx, targetIdx) : 0;
  const fromHandle = em.handleFor(fromIdx);

  const p = em.create();
  comp.kind[p] = EntityKind.Projectile;
  comp.subtype[p] = projType;
  comp.owner[p] = owner;
  comp.posX[p] = comp.posX[fromIdx];
  comp.posY[p] = comp.posY[fromIdx];
  comp.prevX[p] = comp.posX[fromIdx];
  comp.prevY[p] = comp.posY[fromIdx];
  comp.speed[p] = projSpeed;
  comp.radius[p] = 0;
  comp.hp[p] = 1;
  comp.maxHp[p] = 1;
  comp.orderTarget[p] = targetHandle;
  comp.projDamage[p] = comp.attack[fromIdx] + bonus;
  comp.projSource[p] = fromHandle;

  emit(world, { type: 'projectileFired', from: fromHandle, to: targetHandle, projectile: projType });
  return em.handleFor(p);
}
