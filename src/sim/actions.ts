// T4 sim engine — low-level world mutation actions.
// Imports: src/shared/* and the T3 content resolvers/tables only.
import { POP_CAP_MAX, SHEEP_FOOD, tileIndex } from '../shared/constants';
import {
  EntityKind,
  FLAG_UNDER_CONSTRUCTION,
  OrderType,
  UnitType as UnitTypeEnum,
} from '../shared/enums';
import type { BuildingType, PlayerId, Resource, UnitType } from '../shared/enums';
import type { Cost } from '../shared/content-types';
import type { GameEvent } from '../shared/events';
import type { World } from '../shared/world';
import { resolveBuildingStats, resolveUnitStats } from '../content/stats';

/** Push a game event onto the current-tick event stream. */
export function emit(world: World, ev: GameEvent): void {
  world.events.push(ev);
}

/** Spawn a unit at (x,y) world coords. Returns its handle. Fills comp from resolved stats,
 *  bumps the owner's population, and emits a `spawned` event. */
export function spawnUnit(
  world: World,
  owner: PlayerId,
  unit: UnitType,
  x: number,
  y: number,
): number {
  const { comp, em } = world;
  const i = em.create();
  const s = resolveUnitStats(world, owner, unit);

  comp.kind[i] = EntityKind.Unit;
  comp.subtype[i] = unit;
  comp.owner[i] = owner;
  comp.flags[i] = 0;
  comp.posX[i] = x;
  comp.posY[i] = y;
  comp.prevX[i] = x;
  comp.prevY[i] = y;
  comp.radius[i] = s.radius;
  comp.sizeX[i] = 0;
  comp.sizeY[i] = 0;
  comp.speed[i] = s.speedPerTick;
  comp.hp[i] = s.hp;
  comp.maxHp[i] = s.hp;
  comp.attack[i] = s.attack;
  comp.attackRange[i] = s.attackRange;
  comp.attackRateTicks[i] = s.attackRateTicks;
  comp.attackCooldown[i] = 0;
  comp.meleeArmor[i] = s.meleeArmor;
  comp.pierceArmor[i] = s.pierceArmor;
  comp.los[i] = s.los;
  comp.orderType[i] = OrderType.Idle;
  comp.orderTarget[i] = -1;
  comp.orderTile[i] = -1;
  comp.orderX[i] = x;
  comp.orderY[i] = y;
  comp.resumeTarget[i] = -1;
  comp.resumeTile[i] = -1;
  comp.carryType[i] = 0;
  comp.carryAmount[i] = 0;
  comp.workTimer[i] = 0;
  comp.storedResource[i] = unit === UnitTypeEnum.Sheep ? SHEEP_FOOD : 0;
  comp.buildProgress[i] = 0;
  comp.rallyX[i] = -1;
  comp.rallyY[i] = -1;
  comp.projDamage[i] = 0;
  comp.projSource[i] = -1;
  comp.path[i] = null;
  comp.pathStep[i] = -1;
  comp.pathVersion[i] = world.pathCache.version;
  comp.queue[i] = null;

  world.players[owner].population += s.popCost;

  const handle = em.handleFor(i);
  emit(world, {
    type: 'spawned',
    entity: handle,
    owner,
    kind: EntityKind.Unit,
    subtype: unit,
    x,
    y,
  });
  return handle;
}

/** Spawn a building anchored at footprint top-left (tileX,tileY). Returns its handle.
 *  posX/posY are the footprint CENTER. Occupies footprint tiles and invalidates the path
 *  cache. `completed` buildings get full hp + popCap/storedResource; incomplete ones get
 *  FLAG_UNDER_CONSTRUCTION, hp=1, buildProgress=0. Emits `spawned`. */
export function spawnBuilding(
  world: World,
  owner: PlayerId,
  building: BuildingType,
  tileX: number,
  tileY: number,
  completed: boolean,
): number {
  const { comp, em, map } = world;
  const i = em.create();
  const s = resolveBuildingStats(world, owner, building);
  const cx = tileX + s.sizeX / 2;
  const cy = tileY + s.sizeY / 2;

  comp.kind[i] = EntityKind.Building;
  comp.subtype[i] = building;
  comp.owner[i] = owner;
  comp.flags[i] = completed ? 0 : FLAG_UNDER_CONSTRUCTION;
  comp.posX[i] = cx;
  comp.posY[i] = cy;
  comp.prevX[i] = cx;
  comp.prevY[i] = cy;
  comp.radius[i] = s.sizeX / 2;
  comp.sizeX[i] = s.sizeX;
  comp.sizeY[i] = s.sizeY;
  comp.speed[i] = 0;
  comp.maxHp[i] = s.hp;
  comp.hp[i] = completed ? s.hp : 1;
  comp.attack[i] = s.attack;
  comp.attackRange[i] = s.attackRange;
  comp.attackRateTicks[i] = s.attackRateTicks;
  comp.attackCooldown[i] = 0;
  comp.meleeArmor[i] = s.meleeArmor;
  comp.pierceArmor[i] = s.pierceArmor;
  comp.los[i] = s.los;
  comp.orderType[i] = OrderType.Idle;
  comp.orderTarget[i] = -1;
  comp.orderTile[i] = -1;
  comp.orderX[i] = cx;
  comp.orderY[i] = cy;
  comp.resumeTarget[i] = -1;
  comp.resumeTile[i] = -1;
  comp.carryType[i] = 0;
  comp.carryAmount[i] = 0;
  comp.workTimer[i] = 0;
  comp.storedResource[i] = completed ? s.storesFood : 0;
  comp.buildProgress[i] = completed ? s.buildTicks : 0;
  comp.rallyX[i] = -1;
  comp.rallyY[i] = -1;
  comp.projDamage[i] = 0;
  comp.projSource[i] = -1;
  comp.path[i] = null;
  comp.pathStep[i] = -1;
  comp.pathVersion[i] = world.pathCache.version;
  comp.queue[i] = completed ? [] : null;

  const handle = em.handleFor(i);

  // Occupy footprint tiles.
  const size = map.size;
  for (let dy = 0; dy < s.sizeY; dy++) {
    for (let dx = 0; dx < s.sizeX; dx++) {
      const tx = tileX + dx;
      const ty = tileY + dy;
      if (tx >= 0 && ty >= 0 && tx < size && ty < size) {
        map.occupant[tileIndex(size, tx, ty)] = handle;
      }
    }
  }
  // Walkability changed — invalidate the path cache (bump + clear per contract).
  world.pathCache.version++;
  world.pathCache.entries.clear();

  if (completed) {
    recomputePopCap(world, owner);
  }

  emit(world, {
    type: 'spawned',
    entity: handle,
    owner,
    kind: EntityKind.Building,
    subtype: building,
    x: cx,
    y: cy,
  });
  return handle;
}

/** Finish an under-construction building: clear the flag, restore hp, apply popCap and
 *  stored food, ready its production queue, and emit `constructionComplete`. */
export function completeConstruction(world: World, index: number): void {
  const { comp } = world;
  const owner = comp.owner[index] as PlayerId;
  const building = comp.subtype[index] as BuildingType;
  const s = resolveBuildingStats(world, owner, building);

  comp.flags[index] &= ~FLAG_UNDER_CONSTRUCTION;
  comp.hp[index] = comp.maxHp[index];
  comp.storedResource[index] = s.storesFood;
  comp.buildProgress[index] = s.buildTicks;
  if (comp.queue[index] === null) comp.queue[index] = [];

  recomputePopCap(world, owner);

  emit(world, {
    type: 'constructionComplete',
    entity: world.em.handleFor(index),
    owner,
    building,
  });
}

/** Apply damage using the contentDesign formula. Records the attacker for kill credit (via
 *  the otherwise-idle projSource slot). Never removes the entity — deathSystem sweeps hp<=0. */
export function damageEntity(
  world: World,
  targetIdx: number,
  attackerHandle: number,
  amount: number,
  isPierce: boolean,
  bonus: number,
): void {
  const { comp } = world;
  const armor = isPierce ? comp.pierceArmor[targetIdx] : comp.meleeArmor[targetIdx];
  const dmg = Math.max(1, Math.max(0, amount - armor) + bonus);
  comp.hp[targetIdx] -= dmg;
  comp.projSource[targetIdx] = attackerHandle;
}

/** All-or-nothing resource deduction. Returns false (and deducts nothing) if short. */
export function payCost(world: World, player: PlayerId, cost: Cost): boolean {
  const r = world.players[player].resources;
  if (
    r[0] >= cost.food &&
    r[1] >= cost.wood &&
    r[2] >= cost.gold &&
    r[3] >= cost.stone
  ) {
    r[0] -= cost.food;
    r[1] -= cost.wood;
    r[2] -= cost.gold;
    r[3] -= cost.stone;
    return true;
  }
  return false;
}

/** Add a cost back to a player's stockpile (production cancel / refund). */
export function refundCost(world: World, player: PlayerId, cost: Cost): void {
  const r = world.players[player].resources;
  r[0] += cost.food;
  r[1] += cost.wood;
  r[2] += cost.gold;
  r[3] += cost.stone;
}

/** Recompute a player's population cap from COMPLETED buildings only, clamped to POP_CAP_MAX. */
export function recomputePopCap(world: World, player: PlayerId): void {
  const { comp, em } = world;
  const cap = comp.capacity;
  let total = 0;
  for (let i = 0; i < cap; i++) {
    if (em.alive[i] !== 1) continue;
    if (comp.kind[i] !== EntityKind.Building) continue;
    if (comp.owner[i] !== player) continue;
    if ((comp.flags[i] & FLAG_UNDER_CONSTRUCTION) !== 0) continue;
    const s = resolveBuildingStats(world, player, comp.subtype[i] as BuildingType);
    total += s.popProvided;
  }
  world.players[player].populationCap = Math.min(total, POP_CAP_MAX);
}

/** Nearest completed own building whose dropOff mask includes `resource`. Returns a handle,
 *  or -1. Euclidean distance to building center; ties broken by lowest entity index. */
export function findDropOff(
  world: World,
  villagerIdx: number,
  resource: Resource,
): number {
  const { comp, em } = world;
  const player = comp.owner[villagerIdx] as PlayerId;
  const mask = 1 << resource;
  const vx = comp.posX[villagerIdx];
  const vy = comp.posY[villagerIdx];
  const cap = comp.capacity;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < cap; i++) {
    if (em.alive[i] !== 1) continue;
    if (comp.kind[i] !== EntityKind.Building) continue;
    if (comp.owner[i] !== player) continue;
    if ((comp.flags[i] & FLAG_UNDER_CONSTRUCTION) !== 0) continue;
    const s = resolveBuildingStats(world, player, comp.subtype[i] as BuildingType);
    if ((s.dropOff & mask) === 0) continue;
    const dx = comp.posX[i] - vx;
    const dy = comp.posY[i] - vy;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best === -1 ? -1 : em.handleFor(best);
}

/** True if the player owns at least one COMPLETED building of the given type. */
export function hasCompletedBuilding(
  world: World,
  player: PlayerId,
  building: BuildingType,
): boolean {
  const { comp, em } = world;
  const cap = comp.capacity;
  for (let i = 0; i < cap; i++) {
    if (em.alive[i] !== 1) continue;
    if (comp.kind[i] !== EntityKind.Building) continue;
    if (comp.owner[i] !== player) continue;
    if (comp.subtype[i] !== building) continue;
    if ((comp.flags[i] & FLAG_UNDER_CONSTRUCTION) !== 0) continue;
    return true;
  }
  return false;
}
