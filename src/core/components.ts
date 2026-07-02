import { MAX_ENTITIES } from '../shared/constants';
import type { ComponentStores, ProductionItem } from '../shared/world';

/**
 * Structure-of-Arrays component storage (T1).
 *
 * Every typed array has length == capacity so a slot is identified purely by its entity index.
 * Numeric arrays default to 0; the handle/tile Int32 fields and the rally floats are seeded to
 * -1 (the "no target / unset" sentinel). pathVersion, sizeX and sizeY start at 0 (review
 * requiredChanges #3). Side stores (path, queue) start as per-slot nulls.
 *
 * resetEntityComponents restores a slot to this exact pristine state on destroy so typed-array
 * bit patterns are stable across runs (a prerequisite for the FNV world checksum).
 */
export function createComponentStores(capacity: number = MAX_ENTITIES): ComponentStores {
  const comp: ComponentStores = {
    capacity,
    kind: new Uint8Array(capacity),
    subtype: new Uint16Array(capacity),
    owner: new Uint8Array(capacity),
    flags: new Uint8Array(capacity),
    posX: new Float32Array(capacity),
    posY: new Float32Array(capacity),
    prevX: new Float32Array(capacity),
    prevY: new Float32Array(capacity),
    radius: new Float32Array(capacity),
    sizeX: new Uint8Array(capacity),
    sizeY: new Uint8Array(capacity),
    speed: new Float32Array(capacity),
    hp: new Float32Array(capacity),
    maxHp: new Float32Array(capacity),
    attack: new Float32Array(capacity),
    attackRange: new Float32Array(capacity),
    attackRateTicks: new Float32Array(capacity),
    attackCooldown: new Float32Array(capacity),
    meleeArmor: new Float32Array(capacity),
    pierceArmor: new Float32Array(capacity),
    los: new Float32Array(capacity),
    orderType: new Uint8Array(capacity),
    orderTarget: new Int32Array(capacity),
    orderTile: new Int32Array(capacity),
    orderX: new Float32Array(capacity),
    orderY: new Float32Array(capacity),
    resumeTarget: new Int32Array(capacity),
    resumeTile: new Int32Array(capacity),
    carryType: new Uint8Array(capacity),
    carryAmount: new Float32Array(capacity),
    workTimer: new Float32Array(capacity),
    storedResource: new Float32Array(capacity),
    buildProgress: new Float32Array(capacity),
    rallyX: new Float32Array(capacity),
    rallyY: new Float32Array(capacity),
    projDamage: new Float32Array(capacity),
    projSource: new Int32Array(capacity),
    path: new Array<Uint16Array | null>(capacity).fill(null),
    pathStep: new Int32Array(capacity),
    pathVersion: new Int32Array(capacity),
    queue: new Array<ProductionItem[] | null>(capacity).fill(null),
  };

  // Handle/tile fields and rally coords initialise to -1 (see world.ts + T1 publicApi).
  comp.orderTarget.fill(-1);
  comp.orderTile.fill(-1);
  comp.resumeTarget.fill(-1);
  comp.resumeTile.fill(-1);
  comp.projSource.fill(-1);
  comp.pathStep.fill(-1);
  comp.rallyX.fill(-1);
  comp.rallyY.fill(-1);
  // pathVersion / sizeX / sizeY stay 0 (already zeroed by the typed-array constructors).

  return comp;
}

/** Zero every slot, -1 the handle/tile fields (and rally), null the side stores. */
export function resetEntityComponents(comp: ComponentStores, index: number): void {
  comp.kind[index] = 0;
  comp.subtype[index] = 0;
  comp.owner[index] = 0;
  comp.flags[index] = 0;
  comp.posX[index] = 0;
  comp.posY[index] = 0;
  comp.prevX[index] = 0;
  comp.prevY[index] = 0;
  comp.radius[index] = 0;
  comp.sizeX[index] = 0;
  comp.sizeY[index] = 0;
  comp.speed[index] = 0;
  comp.hp[index] = 0;
  comp.maxHp[index] = 0;
  comp.attack[index] = 0;
  comp.attackRange[index] = 0;
  comp.attackRateTicks[index] = 0;
  comp.attackCooldown[index] = 0;
  comp.meleeArmor[index] = 0;
  comp.pierceArmor[index] = 0;
  comp.los[index] = 0;
  comp.orderType[index] = 0;
  comp.orderTarget[index] = -1;
  comp.orderTile[index] = -1;
  comp.orderX[index] = 0;
  comp.orderY[index] = 0;
  comp.resumeTarget[index] = -1;
  comp.resumeTile[index] = -1;
  comp.carryType[index] = 0;
  comp.carryAmount[index] = 0;
  comp.workTimer[index] = 0;
  comp.storedResource[index] = 0;
  comp.buildProgress[index] = 0;
  comp.rallyX[index] = -1;
  comp.rallyY[index] = -1;
  comp.projDamage[index] = 0;
  comp.projSource[index] = -1;
  comp.path[index] = null;
  comp.pathStep[index] = -1;
  comp.pathVersion[index] = 0;
  comp.queue[index] = null;
}
