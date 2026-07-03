// src/audio/dispatcher.ts
// Pure(ish) mapping layer: turns each tick's GameEvents + a per-tick world scan into engine.play()
// calls, holding ALL throttle/scan state. The engine is injected (EnginePort) so tests drive this with
// a recording fake and hand-built worlds. Every positional sound is fog-gated on
// (map.visible[ti] >> localPlayer) & 1 and spatialized with the renderer's own worldToScreen — no audio
// ever leaks from tiles the local player cannot see.

import type { World } from '../shared/world';
import type { ViewState } from '../shared/interfaces';
import type { Command } from '../shared/commands';
import type { GameEvent } from '../shared/events';
import { resolveHandle } from '../shared/world';
import { worldToScreen, type Vec2 } from '../shared/iso';
import { EntityKind, UnitType, OrderType, ProjectileType, ResourceNode } from '../shared/enums';
import type { EnginePort, PlayOpts, SoundId } from './types';
import { SOUNDS } from './synth';

export interface DispatcherOptions {
  isAutoPlay: () => boolean;
}

export interface Dispatcher {
  onTick(evs: readonly GameEvent[], world: World, view: ViewState, ticksThisFrame: number): void;
  onCommands(cmds: readonly Command[]): void;
  uiClick(): void;
}

const AGE_LOCAL: Record<number, SoundId> = { 1: 'ageFeudal', 2: 'ageCastle', 3: 'ageImperial' };
const AGE_ENEMY: Record<number, SoundId> = { 1: 'enemyAgeFeudal', 2: 'enemyAgeCastle', 3: 'enemyAgeImperial' };

interface AccEntry { gain: number; pan: number; count: number; centered: boolean }

export function createDispatcher(engine: EnginePort, opts: DispatcherOptions): Dispatcher {
  // ---- throttle + scan state (arrays sized lazily to comp.capacity) ----
  const lastPlay = new Map<SoundId, number>();
  const acc = new Map<SoundId, AccEntry>();
  const scratch: Vec2 = { x: 0, y: 0 };
  let scratchSx = 0;
  let scratchSy = 0;

  let cap = 0;
  let prevCd = new Float32Array(0);
  let gatherClock = new Uint16Array(0);
  let wasProj = new Uint8Array(0);
  let prevGen = new Uint16Array(0);
  let projX = new Float32Array(0);
  let projY = new Float32Array(0);
  let projSub = new Uint8Array(0);

  // Reusable gather-candidate buffers (nearest-to-centre selection; allocation grows at most once).
  const gcId: SoundId[] = [];
  const gcGain: number[] = [];
  const gcPan: number[] = [];
  const gcDist: number[] = [];
  let gcCount = 0;

  let prevSelSig = -1;

  function ensureArrays(capacity: number): void {
    if (capacity === cap) return;
    cap = capacity;
    prevCd = new Float32Array(capacity);
    gatherClock = new Uint16Array(capacity);
    wasProj = new Uint8Array(capacity);
    prevGen = new Uint16Array(capacity);
    projX = new Float32Array(capacity);
    projY = new Float32Array(capacity);
    projSub = new Uint8Array(capacity);
  }

  // ---- fog gate + spatialization (returns null when fogged or fully off-screen) ----
  function spatial(world: World, view: ViewState, wx: number, wy: number): { gain: number; pan: number } | null {
    const size = world.map.size;
    let tx = wx | 0; if (tx < 0) tx = 0; else if (tx >= size) tx = size - 1;
    let ty = wy | 0; if (ty < 0) ty = 0; else if (ty >= size) ty = size - 1;
    const ti = ty * size + tx;
    if (((world.map.visible[ti] >> view.localPlayer) & 1) !== 1) return null; // fogged — no leak
    worldToScreen(view, wx, wy, scratch);
    const sx = scratch.x;
    const sy = scratch.y;
    scratchSx = sx;
    scratchSy = sy;
    const vw = view.viewportW;
    const vh = view.viewportH;
    if (sx < -0.75 * vw || sx > vw + 0.75 * vw || sy < -0.75 * vh || sy > vh + 0.75 * vh) return null;
    let off = 0;
    if (sx < 0) off += -sx; else if (sx > vw) off += sx - vw;
    if (sy < 0) off += -sy; else if (sy > vh) off += sy - vh;
    const gain = 1 / (1 + off / 500);
    let pan = vw > 0 ? (sx - vw / 2) / (0.6 * vw) : 0;
    if (pan < -0.85) pan = -0.85; else if (pan > 0.85) pan = 0.85;
    return { gain, pan };
  }

  function isOffscreen(view: ViewState, wx: number, wy: number): boolean {
    worldToScreen(view, wx, wy, scratch);
    return scratch.x < 0 || scratch.x > view.viewportW || scratch.y < 0 || scratch.y > view.viewportH;
  }

  // ---- per-tick accumulator (same-tick dedupe) ----
  function emit(id: SoundId, gain: number, pan: number): void {
    const spec = SOUNDS[id];
    if (!spec) return;
    const centered = spec.centered === true;
    const e = acc.get(id);
    if (!e) {
      acc.set(id, { gain, pan: centered ? 0 : pan, count: 1, centered });
    } else {
      e.count += 1;
      if (gain > e.gain) { e.gain = gain; e.pan = centered ? 0 : pan; } // keep the loudest instance's placement
    }
  }

  // ---- retrigger gate (priority-3 sounds bypass it; catch-up frames widen the window) ----
  function gate(id: SoundId, scale: number): boolean {
    const spec = SOUNDS[id];
    const now = engine.now();
    if (spec.priority >= 3) { lastPlay.set(id, now); return true; }
    const last = lastPlay.get(id);
    const window = spec.retriggerMs * scale;
    if (last !== undefined && now - last < window) return false;
    lastPlay.set(id, now);
    return true;
  }

  function tryPlay(id: SoundId, gain: number, pan: number): void {
    if (gate(id, 1)) engine.play(id, { gain, pan });
  }

  // ---- gather-loop recipe selection ----
  function gatherId(world: World, i: number, order: number): SoundId | null {
    if (order === OrderType.Build) return 'buildTap';
    if (order === OrderType.GatherEntity) return 'forageSwish';
    // GatherTile — pick by the node under the villager's target tile.
    const tile = world.comp.orderTile[i];
    if (tile < 0) return null;
    switch (world.map.resourceType[tile]) {
      case ResourceNode.Tree: return 'woodChop';
      case ResourceNode.GoldMine:
      case ResourceNode.StoneMine: return 'mineTink';
      case ResourceNode.Forage: return 'forageSwish';
      default: return null;
    }
  }

  function scanWorld(world: World, view: ViewState, dropEcon: boolean): void {
    const em = world.em;
    const comp = world.comp;
    const capacity = comp.capacity;
    gcCount = 0;
    const cx = view.viewportW / 2;
    const cy = view.viewportH / 2;

    for (let i = 0; i < capacity; i++) {
      const alive = em.alive[i] === 1;

      // (c) Projectile impact thud: projectiles die silently in the sim, so diff the alive->dead slot.
      const isProj = alive && comp.kind[i] === EntityKind.Projectile;
      if (wasProj[i] === 1) {
        const stillSame = isProj && em.generation[i] === prevGen[i];
        if (!stillSame) {
          const sp = spatial(world, view, projX[i], projY[i]);
          if (sp) emit(projSub[i] === ProjectileType.Axe ? 'projImpactAxe' : 'projImpactArrow', sp.gain, sp.pan);
        }
      }
      if (isProj) {
        wasProj[i] = 1;
        prevGen[i] = em.generation[i];
        projX[i] = comp.posX[i];
        projY[i] = comp.posY[i];
        projSub[i] = comp.subtype[i];
      } else {
        wasProj[i] = 0;
      }

      if (alive && comp.kind[i] === EntityKind.Unit) {
        const cd = comp.attackCooldown[i];
        const ot = comp.orderType[i];

        // (a) Melee clank on the attackCooldown rising edge (a swing). This mirrors canvas2d.ts's melee
        // lunge window (cd > rate - 5): both fire the tick the cooldown resets, so the clank sound and
        // the lunge animation land within one tick and never drift. Ranged units are handled by
        // projectileFired, so gate on attackRange <= 1.
        if (comp.attackRange[i] <= 1 && (ot === OrderType.AttackTarget || ot === OrderType.AttackMove) && cd > prevCd[i] + 0.5) {
          const sp = spatial(world, view, comp.posX[i], comp.posY[i]);
          if (sp) emit('meleeClank', sp.gain, sp.pan);
        }
        prevCd[i] = cd;

        // (b) Gather / build loops (villagers only), staggered so a work crew is a texture not a buzz.
        if (!dropEcon && comp.subtype[i] === UnitType.Villager) {
          if (ot === OrderType.GatherTile || ot === OrderType.GatherEntity || ot === OrderType.Build) {
            if (gatherClock[i] % 18 === (i * 7) % 5) {
              const id = gatherId(world, i, ot);
              if (id) {
                const sp = spatial(world, view, comp.posX[i], comp.posY[i]);
                if (sp) {
                  gcId[gcCount] = id;
                  gcGain[gcCount] = sp.gain;
                  gcPan[gcCount] = sp.pan;
                  gcDist[gcCount] = Math.abs(scratchSx - cx) + Math.abs(scratchSy - cy);
                  gcCount += 1;
                }
              }
            }
            gatherClock[i] = (gatherClock[i] + 1) & 0xffff;
          } else {
            gatherClock[i] = 0;
          }
        }
      } else {
        prevCd[i] = alive ? comp.attackCooldown[i] : 0;
      }
    }

    // Cap 3 concurrent gather voices, preferring villagers nearest the screen centre.
    const take = gcCount < 3 ? gcCount : 3;
    for (let n = 0; n < take; n++) {
      let best = -1;
      let bestD = Infinity;
      for (let k = 0; k < gcCount; k++) {
        if (gcDist[k] < bestD) { bestD = gcDist[k]; best = k; }
      }
      if (best < 0) break;
      emit(gcId[best], gcGain[best], gcPan[best]);
      gcDist[best] = Infinity; // consumed
    }
  }

  function handleEvent(ev: GameEvent, world: World, view: ViewState): void {
    const local = view.localPlayer;
    switch (ev.type) {
      case 'spawned': {
        if (ev.owner !== local) return;
        if (ev.kind === EntityKind.Unit) {
          if (ev.subtype === UnitType.Sheep) return;
          const sp = spatial(world, view, ev.x, ev.y);
          if (sp) emit(ev.subtype === UnitType.Villager ? 'villagerPop' : 'militaryReady', sp.gain, sp.pan);
        } else if (ev.kind === EntityKind.Building) {
          const sp = spatial(world, view, ev.x, ev.y);
          if (sp) emit('buildPlaced', sp.gain, sp.pan);
        }
        return;
      }
      case 'died': {
        if (ev.kind === EntityKind.Building) {
          const sp = spatial(world, view, ev.x, ev.y);
          if (sp) emit('buildingCollapse', sp.gain, sp.pan);
          return;
        }
        if (ev.kind === EntityKind.Unit) {
          if (ev.subtype === UnitType.Sheep) {
            const sp = spatial(world, view, ev.x, ev.y);
            if (sp) emit('sheepBaa', sp.gain, sp.pan);
          } else {
            const sp = spatial(world, view, ev.x, ev.y);
            if (sp) emit('unitDeath', sp.gain, sp.pan);
          }
          // Under-attack horn: our own unit killed off-screen by an enemy (centered, ungated by fog —
          // it is our own unit — matches hud.ts's under-attack toast cadence; throttled 12 s).
          if (ev.owner === local && ev.killer > 0 && ev.killer !== local && isOffscreen(view, ev.x, ev.y)) {
            emit('hornAlert', 1, 0);
          }
        }
        return;
      }
      case 'projectileFired': {
        let idx = resolveHandle(world.em, ev.from);
        if (idx < 0) idx = resolveHandle(world.em, ev.to);
        if (idx < 0) return;
        const sp = spatial(world, view, world.comp.posX[idx], world.comp.posY[idx]);
        if (sp) emit(ev.projectile === ProjectileType.Axe ? 'axeThrow' : 'arrowFire', sp.gain, sp.pan);
        return;
      }
      case 'constructionComplete': {
        if (ev.owner !== local) return;
        const idx = resolveHandle(world.em, ev.entity);
        if (idx < 0) return;
        const sp = spatial(world, view, world.comp.posX[idx], world.comp.posY[idx]);
        if (sp) emit('constructionDone', sp.gain, sp.pan);
        return;
      }
      case 'researchComplete': {
        if (ev.player === local) emit('researchDing', 1, 0);
        return;
      }
      case 'ageAdvanced': {
        const id = ev.player === local ? AGE_LOCAL[ev.age] : AGE_ENEMY[ev.age];
        if (!id) return;
        emit(id, ev.player === local ? 1 : 0.3, 0);
        return;
      }
      case 'commandRejected': {
        if (ev.player === local && !opts.isAutoPlay()) emit('reject', 1, 0);
        return;
      }
      case 'resourceNodeDepleted': {
        const size = world.map.size;
        const tx = ev.tile % size;
        const ty = (ev.tile / size) | 0;
        const sp = spatial(world, view, tx + 0.5, ty + 0.5);
        if (sp) emit('resourceDepleted', sp.gain, sp.pan);
        return;
      }
      case 'playerDefeated': {
        emit('playerDefeated', 1, 0); // any player; always plays (priority 3)
        return;
      }
      case 'matchEnded': {
        emit(ev.winner === local ? 'matchWon' : 'matchLost', 1, 0); // always plays (priority 3)
        return;
      }
    }
  }

  function selectionAck(world: World, view: ViewState): void {
    const sel = view.selection;
    const sig = sel.length * 31 + (sel.length > 0 ? sel[0] : -1);
    if (sig === prevSelSig) return;
    prevSelSig = sig;
    if (sel.length === 0 || opts.isAutoPlay()) return;
    const idx = resolveHandle(world.em, sel[0]);
    if (idx < 0) return;
    if (world.comp.kind[idx] !== EntityKind.Unit) { emit('uiClick', 1, 0); return; }
    emit(world.comp.subtype[idx] === UnitType.Villager ? 'selVillager' : 'selMilitary', 1, 0);
  }

  function flush(dropEcon: boolean, scale: number): void {
    for (const [id, e] of acc) {
      const spec = SOUNDS[id];
      if (dropEcon && (spec.category === 'econ' || spec.category === 'ambient') && spec.priority <= 1) continue;
      const factor = e.count > 1 ? Math.min(2, 1 + 0.35 * Math.log2(e.count)) : 1;
      if (gate(id, scale)) engine.play(id, { gain: e.gain * factor, pan: e.centered ? 0 : e.pan } as PlayOpts);
    }
  }

  return {
    onTick(evs, world, view, ticksThisFrame): void {
      ensureArrays(world.comp.capacity);
      const scale = ticksThisFrame > 1 ? ticksThisFrame : 1;
      const dropEcon = ticksThisFrame > 1; // catch-up frame: drop low-priority econ/ambient entirely
      acc.clear();

      for (let i = 0; i < evs.length; i++) handleEvent(evs[i], world, view);
      scanWorld(world, view, dropEcon);
      selectionAck(world, view);

      flush(dropEcon, scale);
    },

    onCommands(cmds): void {
      if (opts.isAutoPlay() || !cmds || cmds.length === 0) return;
      for (let i = 0; i < cmds.length; i++) {
        const id = ackForCommand(cmds[i].type);
        if (id) { tryPlay(id, 1, 0); return; } // first relevant human command only
      }
    },

    uiClick(): void {
      tryPlay('uiClick', 1, 0);
    },
  };
}

function ackForCommand(type: Command['type']): SoundId | null {
  switch (type) {
    case 'move': return 'ackMove';
    case 'attack':
    case 'attackMove': return 'ackAttack';
    case 'gatherTile':
    case 'gatherEntity': return 'ackGather';
    case 'build': return 'ackBuild';
    case 'train':
    case 'research':
    case 'setRally': return 'ackTrain';
    default: return null; // stop / cancelProduction — no ack
  }
}
