// src/render/canvas2d.ts
// T7 — the Canvas2D isometric Renderer implementation. `createCanvas2DRenderer` is the
// ONLY export other tasks (T8) touch; everything else it needs lives in the sibling
// render modules (sprites / terrain / minimap), and it reads world/geometry through
// src/shared ONLY (no content-table imports — building footprints come from
// comp.sizeX / comp.sizeY, per review requiredChanges #3).
//
// Draw order per frame:
//   terrain chunks -> ghost tile highlight -> y-sorted entities+projectiles
//   (selection ring beneath each) -> HP / construction bars -> fog overlay.
// Entities are interpolated prev + (pos - prev) * alpha and projected with the shared
// iso.ts functions so the renderer agrees pixel-for-pixel with T8 picking.

import { EntityKind, FLAG_UNDER_CONSTRUCTION, OrderType, BuildingType, UnitType } from '../shared/enums';
import { TILE_W, TILE_H } from '../shared/constants';
import { makeHandle, resolveHandle } from '../shared/world';
import type { World } from '../shared/world';
import { worldToScreen, type Vec2 } from '../shared/iso';
import type { Renderer, ViewState } from '../shared/interfaces';
import {
  spriteKey, getSprite, clearSpriteCache, createOffscreenCanvas, get2d,
  SPRITE_KIND_FX, FxSprite, type OffCanvas,
} from './sprites';
import { createTerrainLayer, type TerrainLayer } from './terrain';
import { drawMinimap } from './minimap';

export function createCanvas2DRenderer(): Renderer {
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let terrain: TerrainLayer | null = null;
  let terrainMapSize = -1;

  // Reusable sort/scratch buffers (reallocated only when capacity / map size changes).
  let capacity = -1;
  let numBuckets = -1;
  let sortKeys = new Int32Array(0);
  let sortedIdx = new Int32Array(0);
  let drawStatus = new Uint8Array(0);
  let interpX = new Float32Array(0);
  let interpY = new Float32Array(0);
  let bucketCounts = new Int32Array(0);
  let bucketOffsets = new Int32Array(0);

  // Per-entity animation / combat-feedback state (allocated once, cap-sized). See §4.
  let prevGen = new Uint16Array(0);   // detect slot reuse (avoid false flashes/puffs)
  let prevHp = new Float32Array(0);
  let wasDrawn = new Uint8Array(0);   // was drawn last frame (for death puffs)
  let lastSX = new Float32Array(0);   // last drawn interp world x/y (puffs, trails)
  let lastSY = new Float32Array(0);
  let lastSize = new Float32Array(0); // puff size by former kind
  let facing = new Int8Array(0);      // 1 = east, -1 = west; sticky while idle
  let flashTtl = new Float32Array(0); // ms of hit flash remaining
  let stridePhase = new Float32Array(0); // distance-driven walk phase (accumulates while moving)
  let strideStep = new Int32Array(0);    // last floor(stridePhase/PI) — footfall rising edge
  let workStep = new Int32Array(0);      // last floor(chopPhase/PI) — gather/build apex edge
  let shownRatio = new Float32Array(0);  // lerped HP ratio for the drain/damage-trail band
  let lastKey = new Uint32Array(0);      // packed sprite key last drawn per slot (corpse reuse)
  let lastWasUnit = new Uint8Array(0);   // 1 iff the slot last drew a Unit (corpse-push guard)

  // Death-puff ring buffer: [x, y, bornMs, size] * 64.
  const deathFx = new Float32Array(64 * 4);
  let deathFxHead = 0;
  // Corpse ring: [wx, wy, spriteKey, bornMs, sizeFlag] * 32. Float64 keeps the wall-clock
  // birth ms AND the packed sprite key exact (Float32 would round both — see deathFx note).
  const corpseFx = new Float64Array(32 * 5);
  let corpseFxHead = 0;
  // Wood-fleck ring (chop chips): [wx, wy, bornMs, seed] * 32.
  const fleckFx = new Float64Array(32 * 4);
  let fleckFxHead = 0;
  // Footstep-dust ring: [wx, wy, bornMs] * 16.
  const footFx = new Float64Array(16 * 3);
  let footFxHead = 0;

  // Frame-time (cosmetic FX decay uses wall-clock; sim-paced anim uses world.tick+alpha).
  let lastNowMs = 0;
  let curNowMs = 0;
  let curDtMs = 0;

  let fxWarmed = false;
  let vignetteCanvas: OffCanvas | null = null;
  let vignetteW = -1;
  let vignetteH = -1;

  const p: Vec2 = { x: 0, y: 0 };
  const q: Vec2 = { x: 0, y: 0 };
  const selSet = new Set<number>();

  // Pre-rasterize the fixed FX sprite set once so per-frame frame selection only ever
  // hits the memo cache (keeps the sprite-cache size stable — allocation-free contract).
  function warmFx(): void {
    if (fxWarmed) return;
    fxWarmed = true;
    for (let f = 0; f < 3; f++) getSprite(spriteKey(SPRITE_KIND_FX, FxSprite.DustPuff, 0, f));
    for (let f = 0; f < 2; f++) getSprite(spriteKey(SPRITE_KIND_FX, FxSprite.HitSpark, 0, f));
    for (let f = 0; f < 3; f++) getSprite(spriteKey(SPRITE_KIND_FX, FxSprite.SmokePuff, 0, f));
    for (let f = 0; f < 3; f++) getSprite(spriteKey(SPRITE_KIND_FX, FxSprite.WaterShimmer, 0, f));
    for (let o = 0; o < 4; o++) getSprite(spriteKey(SPRITE_KIND_FX, FxSprite.RallyFlag, o, 0));
  }

  // Radial-gradient vignette baked into an offscreen canvas, rebuilt only on resize.
  function ensureVignette(w: number, h: number): void {
    if (w <= 0 || h <= 0) { vignetteCanvas = null; return; }
    if (vignetteCanvas && w === vignetteW && h === vignetteH) return;
    const cv = createOffscreenCanvas(w, h);
    const vc = get2d(cv);
    const cx = w / 2, cy = h / 2;
    const R = Math.hypot(cx, cy);
    const grad = vc.createRadialGradient(cx, cy, 0.55 * R, cx, cy, R);
    grad.addColorStop(0, 'rgba(10,14,10,0)');
    grad.addColorStop(1, 'rgba(10,14,10,0.28)');
    vc.fillStyle = grad;
    vc.fillRect(0, 0, w, h);
    vignetteCanvas = cv;
    vignetteW = w;
    vignetteH = h;
  }

  function pushDeathPuff(x: number, y: number, size: number, nowMs: number): void {
    const b = deathFxHead * 4;
    deathFx[b] = x; deathFx[b + 1] = y; deathFx[b + 2] = nowMs; deathFx[b + 3] = size;
    deathFxHead = (deathFxHead + 1) & 63;
  }

  // A slain unit crumples in place then fades, reusing the exact sprite key it last drew
  // with (so no new (kind,subtype,owner,variant) key is ever minted — cache stays stable).
  function pushCorpse(x: number, y: number, key: number, nowMs: number): void {
    const b = corpseFxHead * 5;
    corpseFx[b] = x; corpseFx[b + 1] = y; corpseFx[b + 2] = key; corpseFx[b + 3] = nowMs; corpseFx[b + 4] = 1;
    corpseFxHead = (corpseFxHead + 1) % 32;
  }

  function pushFleck(x: number, y: number, nowMs: number, seed: number): void {
    const b = fleckFxHead * 4;
    fleckFx[b] = x; fleckFx[b + 1] = y; fleckFx[b + 2] = nowMs; fleckFx[b + 3] = seed;
    fleckFxHead = (fleckFxHead + 1) % 32;
  }

  function pushFoot(x: number, y: number, nowMs: number): void {
    const b = footFxHead * 3;
    footFx[b] = x; footFx[b + 1] = y; footFx[b + 2] = nowMs;
    footFxHead = (footFxHead + 1) % 16;
  }

  function ensureTerrain(world: World): void {
    if (!terrain || terrainMapSize !== world.mapSize) {
      terrain = createTerrainLayer(world.mapSize);
      terrainMapSize = world.mapSize;
    }
  }

  function ensureBuffers(cap: number, mapSize: number): void {
    if (cap !== capacity) {
      capacity = cap;
      sortKeys = new Int32Array(cap);
      sortedIdx = new Int32Array(cap);
      drawStatus = new Uint8Array(cap);
      interpX = new Float32Array(cap);
      interpY = new Float32Array(cap);
      prevGen = new Uint16Array(cap);
      prevHp = new Float32Array(cap);
      wasDrawn = new Uint8Array(cap);
      lastSX = new Float32Array(cap);
      lastSY = new Float32Array(cap);
      lastSize = new Float32Array(cap);
      facing = new Int8Array(cap);
      flashTtl = new Float32Array(cap);
      stridePhase = new Float32Array(cap);
      strideStep = new Int32Array(cap);
      workStep = new Int32Array(cap);
      shownRatio = new Float32Array(cap).fill(1); // start "full" so no spurious first-frame band
      lastKey = new Uint32Array(cap);
      lastWasUnit = new Uint8Array(cap);
    }
    const nb = Math.max(1, 8 * mapSize + 1);
    if (nb !== numBuckets) {
      numBuckets = nb;
      bucketCounts = new Int32Array(nb);
      bucketOffsets = new Int32Array(nb);
    }
  }

  // Counting sort of drawable entities by (posX+posY) diagonal, ascending; ties by lowest
  // index (stable, since we place ascending). Returns the count written to sortedIdx.
  function sortEntities(world: World, view: ViewState, alpha: number, nowMs: number): number {
    const comp = world.comp;
    const em = world.em;
    const map = world.map;
    const size = world.mapSize;
    const lp = view.localPlayer;
    const cap = comp.capacity;
    bucketCounts.fill(0);
    for (let i = 0; i < cap; i++) {
      sortKeys[i] = -1;
      drawStatus[i] = 0;

      // --- Combat-feedback diff (one pass, allocation-free). Guard on generation so a
      // reused slot never emits a false death puff / hit flash. ---
      const dead = em.alive[i] !== 1;
      const genChanged = em.generation[i] !== prevGen[i];
      if (dead || genChanged) {
        if (wasDrawn[i]) {
          pushDeathPuff(lastSX[i], lastSY[i], lastSize[i], nowMs);
          // Only units leave a body; buildings raze (smoke, in drawDeathPuffs) and
          // projectiles just wink out. lastWasUnit filters both of those out.
          if (lastWasUnit[i] === 1) pushCorpse(lastSX[i], lastSY[i], lastKey[i], nowMs);
        }
        wasDrawn[i] = 0;
        flashTtl[i] = 0;
        facing[i] = 0;
        stridePhase[i] = 0;
        strideStep[i] = 0;
        workStep[i] = 0;
        prevGen[i] = em.generation[i];
        prevHp[i] = dead ? 0 : comp.hp[i];
        shownRatio[i] = dead ? 1 : (comp.maxHp[i] > 0 ? clamp01(comp.hp[i] / comp.maxHp[i]) : 1);
        if (dead) continue;
        // fresh live entity in a reused slot: fall through, but skip the hp diff below.
      } else {
        if (comp.hp[i] < prevHp[i] - 0.25) flashTtl[i] = 140; // took damage -> hit spark
        prevHp[i] = comp.hp[i];
      }

      const kind = comp.kind[i];
      const ix = comp.prevX[i] + (comp.posX[i] - comp.prevX[i]) * alpha;
      const iy = comp.prevY[i] + (comp.posY[i] - comp.prevY[i]) * alpha;
      interpX[i] = ix;
      interpY[i] = iy;

      // Facing: sign of screen-x velocity (fdx - fdy). Sticky when not moving, except a
      // stationary unit acting on a target turns to face it (no more archers firing backwards).
      if (kind === EntityKind.Unit) {
        const fdx = comp.posX[i] - comp.prevX[i];
        const fdy = comp.posY[i] - comp.prevY[i];
        const sxv = fdx - fdy;
        if (sxv > 1e-4) facing[i] = 1;
        else if (sxv < -1e-4) facing[i] = -1;
        else {
          const ot = comp.orderType[i];
          if (ot === OrderType.AttackTarget || ot === OrderType.GatherEntity || ot === OrderType.Build) {
            const oti = resolveHandle(em, comp.orderTarget[i]);
            if (oti >= 0) {
              const svx = (comp.posX[oti] - ix) - (comp.posY[oti] - iy);
              if (svx > 1e-4) facing[i] = 1;
              else if (svx < -1e-4) facing[i] = -1;
            }
          }
        }
      }

      let tx = ix | 0; if (tx < 0) tx = 0; else if (tx >= size) tx = size - 1;
      let ty = iy | 0; if (ty < 0) ty = 0; else if (ty >= size) ty = size - 1;
      const ti = ty * size + tx;
      if (((map.explored[ti] >> lp) & 1) === 0) continue; // never seen -> hidden
      const visible = (map.visible[ti] >> lp) & 1;
      let status: number;
      if (kind === EntityKind.Building) status = visible ? 1 : 2; // fogged buildings dimmed
      else status = visible ? 1 : 0;                              // fogged units/projectiles hidden
      if (status === 0) continue;
      drawStatus[i] = status;
      let key = Math.round((ix + iy) * 4);
      if (key < 0) key = 0; else if (key >= numBuckets) key = numBuckets - 1;
      sortKeys[i] = key;
      bucketCounts[key]++;
    }
    let acc = 0;
    for (let b = 0; b < numBuckets; b++) { const c = bucketCounts[b]; bucketOffsets[b] = acc; acc += c; }
    const total = acc;
    for (let i = 0; i < cap; i++) {
      const k = sortKeys[i];
      if (k < 0) continue;
      sortedIdx[bucketOffsets[k]++] = i;
    }
    return total;
  }

  function buildingVariant(comp: World['comp'], i: number): number {
    return ((comp.sizeX[i] & 0xf) << 4) | (comp.sizeY[i] & 0xf);
  }

  function drawEntity(c: CanvasRenderingContext2D, world: World, view: ViewState, i: number, status: number,
    alpha: number, nowMs: number): void {
    const comp = world.comp;
    const em = world.em;
    const kind = comp.kind[i];
    const sub = comp.subtype[i];
    const owner = comp.owner[i];
    const z = view.zoom;
    worldToScreen(view, interpX[i], interpY[i], p);

    if (kind === EntityKind.Projectile) {
      drawProjectile(c, world, view, i);
      lastSX[i] = interpX[i]; lastSY[i] = interpY[i]; lastSize[i] = 1; lastWasUnit[i] = 0; wasDrawn[i] = 1;
      return;
    }

    const handle = makeHandle(i, em.generation[i]);
    const selected = selSet.has(handle);
    const relColor = relationColor(view, owner);

    if (selected) {
      if (kind === EntityKind.Building) drawFootprintOutline(c, world, view, i, relColor);
      else drawSelectionRing(c, p.x, p.y, z, comp.radius[i], relColor);
    }

    // --- Sim-paced animation offsets (allocation-free; phase desynced per index).
    // Attack timing is the mirror of src/audio/dispatcher.ts's attackCooldown rising-edge:
    // the sim decrements attackCooldown toward 0 each tick and, on a swing, adds
    // attackRateTicks back (src/systems/combat.ts) — so cd≈rate reads as "just swung"
    // (strike/recoil) and cd≈0 as "about to swing" (windup). Keep these windows aligned
    // with the audio swing/impact cues if either side changes. ---
    let ox = 0, oy = 0;
    const ph = (world.tick + alpha) * 0.9 + i * 2.399;
    if (kind === EntityKind.Unit) {
      const fdx = comp.posX[i] - comp.prevX[i];
      const fdy = comp.posY[i] - comp.prevY[i];
      const moving = fdx !== 0 || fdy !== 0;
      const ot = comp.orderType[i];
      const dir = facing[i] < 0 ? -1 : 1;
      const isCav = sub === UnitType.ScoutCavalry || sub === UnitType.Knight || sub === UnitType.Mangudai;
      if (moving) {
        // Distance-driven stride: gait tracks real movement (correct at 1x .. 5x sim speed).
        // Read lastSX/lastSY BEFORE they're overwritten at the end of this function.
        const d = Math.hypot(interpX[i] - lastSX[i], interpY[i] - lastSY[i]);
        stridePhase[i] += d * 7.0 * (isCav ? 1.25 : 1.0);
        oy -= Math.abs(Math.sin(stridePhase[i])) * (isCav ? 1.2 : 1.5) * z; // bob <= 1.5px @ z1
        const step = Math.floor(stridePhase[i] / Math.PI);
        if (step > strideStep[i]) {
          strideStep[i] = step;
          const onScreen = p.x > -48 && p.x < view.viewportW + 48 && p.y > -48 && p.y < view.viewportH + 48;
          // cavalry kicks up dust every footfall; infantry every other one.
          if (z >= 0.9 && onScreen && (isCav || (step & 1) === 0)) pushFoot(interpX[i], interpY[i], nowMs);
        }
      } else if (ot === OrderType.GatherTile || ot === OrderType.GatherEntity || ot === OrderType.Build) {
        const wp = ph * 1.6;
        oy -= Math.abs(Math.sin(wp)) * 1.2 * z;                 // chop / build rhythm
        if (ot === OrderType.Build) ox = Math.sin(ph * 1.3) * 1.0 * z; // hammer sway (stationary — safe)
        const wstep = Math.floor(wp / Math.PI);
        if (wstep > workStep[i]) {                              // one apex per half-cycle
          workStep[i] = wstep;
          if (ot === OrderType.Build) {
            if ((wstep & 1) === 0 && z >= 0.6) {                // hammer glint that rhymes with buildTap
              const hs = getSprite(spriteKey(SPRITE_KIND_FX, FxSprite.HitSpark, 0, 1));
              const hz = 0.4 * z;
              c.globalAlpha = 0.8;
              c.drawImage(hs.canvas, p.x + dir * 8 * z - hs.anchorX * hz, p.y - 16 * z - hs.anchorY * hz,
                hs.canvas.width * hz, hs.canvas.height * hz);
              c.globalAlpha = 1;
            }
          } else {
            // Two wood chips fly off at each chop apex (deterministic per-entity/fleck offsets).
            pushFleck(interpX[i], interpY[i], nowMs, i * 2);
            pushFleck(interpX[i], interpY[i], nowMs, i * 2 + 1);
          }
        }
      } else if (sub === UnitType.Sheep) {
        oy -= Math.abs(Math.sin(ph * 0.2)) * 0.8 * z;           // graze bob
      } else {
        oy -= Math.sin(ph * 0.35) * 0.5 * z;                    // idle breathing
      }
      // Three-phase attack: windup (pull-back) -> strike (melee lunge / ranged recoil) -> recover.
      if (ot === OrderType.AttackTarget || ot === OrderType.AttackMove) {
        const rate = comp.attackRateTicks[i];
        const cd = comp.attackCooldown[i];
        const melee = comp.attackRange[i] <= 1;
        if (rate > 8) {
          const cdf = cd > alpha ? cd - alpha : 0;              // smooth toward the next tick
          const since = rate - cdf;                            // ticks since the last swing fired
          const until = cdf;                                   // ticks until the next swing
          if (since >= 0 && since < 3) {                       // STRIKE
            let s = 1 - since / 3; s = s < 0 ? 0 : s > 1 ? 1 : s; s = easeOut(s);
            if (melee) {
              ox += 4.5 * z * dir * s; oy -= 1.2 * z * s;
              // One readable white slash arc per swing — the AoE combat-legibility trick.
              c.globalAlpha = 0.35 * s;
              c.strokeStyle = 'rgba(244,242,232,0.8)';
              c.lineWidth = 2 * z;
              c.beginPath();
              const scx = p.x + dir * 10 * z, scy = p.y - 14 * z, sr = 9 * z;
              if (dir > 0) c.arc(scx, scy, sr, -0.7, 0.5);
              else c.arc(scx, scy, sr, Math.PI - 0.5, Math.PI + 0.7);
              c.stroke();
              c.globalAlpha = 1;
              if (since < 0.9) pushFoot(interpX[i], interpY[i], nowMs); // dust kicked up on the lunge
            } else {
              ox -= 2.2 * z * dir * s; oy -= 0.6 * z * s;       // bow recoil
              if (since < 1.0) {                               // bow-release flash at the bow centre
                const bx = p.x + dir * 11 * z, by = p.y - 19 * z;
                c.strokeStyle = 'rgba(255,250,230,0.9)';
                for (let k = 0; k < 3; k++) {
                  c.globalAlpha = 0.3 * (1 - k / 3);
                  c.lineWidth = Math.max(1, z);
                  c.beginPath(); c.arc(bx, by, (2 + k * 1.5) * z, 0, Math.PI * 2); c.stroke();
                }
                c.globalAlpha = 1;
              }
            }
          } else if (since >= 3 && since < 5) {                 // RECOVER (eased decay to rest)
            let r = 1 - (since - 3) / 2; r = r < 0 ? 0 : r; r = r * r;
            if (melee) { ox += 1.6 * z * dir * r; oy -= 0.4 * z * r; }
            else ox -= 0.8 * z * dir * r;
          } else if (until > 0 && until <= 4) {                // WINDUP anticipation
            let t = 1 - until / 4; t = t < 0 ? 0 : t > 1 ? 1 : t; t = t * t;
            ox -= 2.0 * z * dir * t; oy -= 0.3 * z * t;
          }
        } else if (rate > 5 && cd > rate - 5) {
          // Fast attackers (rate <= 8): keep the simple single-window lunge / recoil.
          const s = (cd - (rate - 5)) / 5;
          const recoil = comp.attackRange[i] > 1 ? -1 : 1;
          ox += 3 * z * s * dir * recoil;
          oy -= 1 * z * s;
        }
      }
    }

    const variant = kind === EntityKind.Building ? buildingVariant(comp, i) : (facing[i] < 0 ? 1 : 0);
    const sKey = spriteKey(kind, sub, owner, variant);
    const spr = getSprite(sKey);
    const img = spr.canvas as OffCanvas;
    const dx = p.x - spr.anchorX * z + ox;
    const dy = p.y - spr.anchorY * z + oy;
    c.globalAlpha = status === 2 ? 0.5 : 1;

    const underConstruction = kind === EntityKind.Building && (comp.flags[i] & FLAG_UNDER_CONSTRUCTION) !== 0;
    if (underConstruction) {
      drawConstruction(c, world, view, i, img, dx, dy, z);
    } else {
      c.drawImage(img, dx, dy, img.width * z, img.height * z);
    }
    c.globalAlpha = 1;

    // Hit-spark flash (decayed once per frame here, only while flashing).
    if (flashTtl[i] > 0) {
      const frame = flashTtl[i] > 70 ? 0 : 1;
      const fs = getSprite(spriteKey(SPRITE_KIND_FX, FxSprite.HitSpark, 0, frame));
      c.globalAlpha = Math.min(1, flashTtl[i] / 140);
      c.drawImage(fs.canvas, p.x - fs.anchorX * z, p.y - spr.anchorY * 0.55 * z - fs.anchorY * z,
        fs.canvas.width * z, fs.canvas.height * z);
      c.globalAlpha = 1;
      flashTtl[i] -= curDtMs;
      if (flashTtl[i] < 0) flashTtl[i] = 0;
    }

    // Chimney smoke for completed Blacksmith / TownCenter (cosmetic; wall-clock paced).
    if (kind === EntityKind.Building && !underConstruction && z >= 0.75 &&
        (sub === BuildingType.Blacksmith || sub === BuildingType.TownCenter)) {
      drawSmoke(c, sub, i, spr, p.x, p.y, z, nowMs);
    }

    lastSX[i] = interpX[i];
    lastSY[i] = interpY[i];
    lastSize[i] = kind === EntityKind.Building ? 2.5 : 1;
    lastKey[i] = sKey;                                // both facing variants are already cached
    lastWasUnit[i] = kind === EntityKind.Unit ? 1 : 0;
    wasDrawn[i] = 1;
  }

  // Bottom-slice construction rise from hp/maxHp (a faithful build ratio) + live scaffold.
  function drawConstruction(c: CanvasRenderingContext2D, world: World, view: ViewState, i: number,
    img: OffCanvas, dx: number, dy: number, z: number): void {
    const comp = world.comp;
    const t = clamp01(comp.hp[i] / comp.maxHp[i]);
    const groundH = ((comp.sizeX[i] + comp.sizeY[i]) * TILE_H) / 4 + 8; // keep ground diamond visible
    const cut = Math.max(0, ((1 - t) * (img.height - groundH)) | 0);
    c.globalAlpha = 0.85 + 0.15 * t;
    c.drawImage(img, 0, cut, img.width, img.height - cut, dx, dy + cut * z, img.width * z, (img.height - cut) * z);
    c.globalAlpha = 1;
    if (t < 0.92) {
      c.globalAlpha = 0.6 * (1 - t);
      c.strokeStyle = '#8a6b40';
      c.lineWidth = Math.max(1, 1.2 * z);
      const cxw = comp.posX[i], cyw = comp.posY[i];
      const sx = (comp.sizeX[i] || 1) / 2, sy = (comp.sizeY[i] || 1) / 2;
      worldToScreen(view, cxw - sx, cyw - sy, q); const tlx = q.x, tly = q.y;
      worldToScreen(view, cxw - sx, cyw + sy, q); const blx = q.x, bly = q.y;
      const h = 22 * z;
      lineScreen(c, tlx, tly, tlx, tly - h);
      lineScreen(c, blx, bly, blx, bly - h);
      lineScreen(c, tlx, tly - h, blx, bly - h);
      lineScreen(c, tlx, tly, blx, bly - h * 0.5);
      // Worksite sparkle on the scaffold posts — blinks in the buildTap cadence.
      if (z >= 0.75 && Math.sin(curNowMs * 0.008 + i) > 0.7) {
        const hs = getSprite(spriteKey(SPRITE_KIND_FX, FxSprite.HitSpark, 0, 1));
        const hz = 0.5 * z;
        c.globalAlpha = 0.5;
        c.drawImage(hs.canvas, tlx - hs.anchorX * hz, tly - h - hs.anchorY * hz,
          hs.canvas.width * hz, hs.canvas.height * hz);
        c.drawImage(hs.canvas, blx - hs.anchorX * hz, bly - h - hs.anchorY * hz,
          hs.canvas.width * hz, hs.canvas.height * hz);
      }
      c.globalAlpha = 1;
    }
  }

  function drawProjectile(c: CanvasRenderingContext2D, world: World, view: ViewState, i: number): void {
    const comp = world.comp;
    const em = world.em;
    const z = view.zoom;
    const spr = getSprite(spriteKey(EntityKind.Projectile, comp.subtype[i], comp.owner[i], 0));
    const img = spr.canvas as OffCanvas;
    const dx = comp.posX[i] - comp.prevX[i];
    const dy = comp.posY[i] - comp.prevY[i];
    const ang = Math.atan2((dx + dy) * (TILE_H / 2), (dx - dy) * (TILE_W / 2)) + Math.PI / 4;
    // Pseudo-arc: lift by remaining distance to the homing target.
    let lift = 0;
    const ti = resolveHandle(em, comp.orderTarget[i]);
    if (ti >= 0) {
      const d = Math.hypot(comp.posX[ti] - comp.posX[i], comp.posY[ti] - comp.posY[i]);
      lift = Math.min(6, d * 2) * z;
    }
    if (wasDrawn[i]) {
      worldToScreen(view, lastSX[i], lastSY[i], q);
      c.strokeStyle = 'rgba(230,225,205,0.4)';
      c.lineWidth = Math.max(1, 1.5 * z);
      c.beginPath(); c.moveTo(q.x, q.y - lift); c.lineTo(p.x, p.y - lift); c.stroke();
    }
    c.save();
    c.translate(p.x, p.y - lift);
    c.rotate(ang);
    c.drawImage(img, -8 * z, -8 * z, 16 * z, 16 * z);
    c.restore();
  }

  function drawSmoke(c: CanvasRenderingContext2D, sub: number, i: number, spr: { anchorY: number; canvas: OffCanvas },
    px: number, py: number, z: number, nowMs: number): void {
    const baseX = px + (sub === BuildingType.Blacksmith ? 9 : 0) * z;
    const baseY = py - spr.anchorY * z + 6 * z;
    for (let k = 0; k < 2; k++) {
      const yOff = (nowMs * 0.02 + k * 13 + i * 7) % 26;
      const frame = Math.min(2, (yOff / 9) | 0);
      const sfx = getSprite(spriteKey(SPRITE_KIND_FX, FxSprite.SmokePuff, 0, frame));
      c.globalAlpha = 0.5 * (1 - yOff / 26);
      c.drawImage(sfx.canvas, baseX - sfx.anchorX * z, baseY - yOff * z - sfx.anchorY * z,
        sfx.canvas.width * z, sfx.canvas.height * z);
    }
    c.globalAlpha = 1;
  }

  function drawDeathPuffs(c: CanvasRenderingContext2D, view: ViewState, nowMs: number): void {
    const z0 = view.zoom;
    for (let s = 0; s < 64; s++) {
      const b = s * 4;
      const size = deathFx[b + 3];
      if (size <= 0) continue;
      // birth (deathFx) is a Float32 store of a Float64 wall-clock ms, so nowMs - birth can be a tiny
      // negative from rounding (and loses precision late in a long game); clamp to >= 0 so a just-born
      // puff is never skipped.
      const age = Math.max(0, nowMs - deathFx[b + 2]);
      if (age >= 450) continue;
      worldToScreen(view, deathFx[b], deathFx[b + 1], p);
      const frame = Math.min(2, (age / 150) | 0);
      const spr = getSprite(spriteKey(SPRITE_KIND_FX, FxSprite.DustPuff, 0, frame));
      const z = z0 * size;
      c.globalAlpha = 1 - age / 450;
      c.drawImage(spr.canvas, p.x - spr.anchorX * z, p.y - spr.anchorY * z,
        spr.canvas.width * z, spr.canvas.height * z);
      // Razing smoke for a felled building (size flag >= 2), rising for the first ~1.2s.
      if (size >= 2 && age < 1200) {
        const sz = z0 * 1.1;
        for (let k = 0; k < 2; k++) {
          const yOff = (age * 0.02 + k * 12) % 26;
          const sframe = Math.min(2, (yOff / 9) | 0);
          const sm = getSprite(spriteKey(SPRITE_KIND_FX, FxSprite.SmokePuff, 0, sframe));
          c.globalAlpha = 0.5 * (1 - age / 1200) * (1 - yOff / 26);
          c.drawImage(sm.canvas, p.x - sm.anchorX * sz, p.y - yOff * z0 - sm.anchorY * sz,
            sm.canvas.width * sz, sm.canvas.height * sz);
        }
      }
    }
    c.globalAlpha = 1;
  }

  // Fallen units: crumple to 38% height about the fixed ground anchor, then fade over ~3.5s.
  // Drawn beneath the live entity layer (bodies underfoot). Reuses the last-drawn sprite key
  // per slot — always already in the cache, so this adds zero sprite-cache growth.
  function drawCorpses(c: CanvasRenderingContext2D, view: ViewState, nowMs: number): void {
    const z = view.zoom;
    for (let s = 0; s < 32; s++) {
      const b = s * 5;
      if (corpseFx[b + 4] <= 0) continue;                       // empty slot
      const age = Math.max(0, nowMs - corpseFx[b + 3]);
      if (age >= 3500) { corpseFx[b + 4] = 0; continue; }
      const spr = getSprite(corpseFx[b + 2]);                   // last-drawn key (already cached)
      const img = spr.canvas as OffCanvas;
      let k: number, a: number;
      if (age < 250) { k = 1 - 0.62 * easeOut(age / 250); a = 0.8; }  // the topple
      else { k = 0.38; a = 0.8 * (1 - (age - 250) / 3250); }          // the lie-and-fade
      if (a <= 0) continue;
      worldToScreen(view, corpseFx[b], corpseFx[b + 1], p);
      c.globalAlpha = a;
      // Squash via the height ARG only (never a transform) so the ground-contact pixel
      // stays fixed: dy + anchorY*k*z === p.y.
      c.drawImage(img, p.x - spr.anchorX * z, p.y - spr.anchorY * k * z, img.width * z, img.height * k * z);
    }
    c.globalAlpha = 1;
  }

  // Footstep dust — small, faint DustPuffs from the fixed footFx ring (warmed frames 0/1).
  function drawFootFx(c: CanvasRenderingContext2D, view: ViewState, nowMs: number): void {
    const z = view.zoom;
    for (let s = 0; s < 16; s++) {
      const b = s * 3;
      const born = footFx[b + 2];
      if (born <= 0) continue;
      const age = nowMs - born;
      if (age < 0 || age >= 220) continue;
      worldToScreen(view, footFx[b], footFx[b + 1], p);
      const spr = getSprite(spriteKey(SPRITE_KIND_FX, FxSprite.DustPuff, 0, age < 110 ? 0 : 1));
      const zz = 0.5 * z;
      c.globalAlpha = 0.25 * (1 - age / 220);
      c.drawImage(spr.canvas, p.x - spr.anchorX * zz, p.y - spr.anchorY * zz,
        spr.canvas.width * zz, spr.canvas.height * zz);
    }
    c.globalAlpha = 1;
  }

  // Wood chips flung at chop apexes — 2x2 flecks that fall + fade over 200ms.
  function drawFleckFx(c: CanvasRenderingContext2D, view: ViewState, nowMs: number): void {
    const z = view.zoom;
    const sz = Math.max(1, 2 * z);
    for (let s = 0; s < 32; s++) {
      const b = s * 4;
      const born = fleckFx[b + 2];
      if (born <= 0) continue;
      const age = nowMs - born;
      if (age < 0 || age >= 200) continue;
      worldToScreen(view, fleckFx[b], fleckFx[b + 1], p);
      const seed = fleckFx[b + 3];
      const offX = ((seed * 29) % 7) - 3;
      const offY = -((seed * 13) % 5);
      const fall = 6 * (age / 200);
      c.globalAlpha = 0.8 * (1 - age / 200);
      c.fillStyle = 'rgba(200,170,110,0.8)';
      c.fillRect(p.x + offX * z, p.y - 16 * z + (offY + fall) * z, sz, sz);
    }
    c.globalAlpha = 1;
  }

  function drawRallyPoints(c: CanvasRenderingContext2D, world: World, view: ViewState, nowMs: number): void {
    const comp = world.comp;
    const em = world.em;
    const z = view.zoom;
    const sel = view.selection;
    for (let s = 0; s < sel.length; s++) {
      const i = resolveHandle(em, sel[s]);
      if (i < 0) continue;
      if (comp.kind[i] !== EntityKind.Building) continue;
      if (comp.owner[i] !== view.localPlayer) continue;
      const rx = comp.rallyX[i], ry = comp.rallyY[i];
      if (rx < 0 || ry < 0) continue;
      worldToScreen(view, comp.posX[i], comp.posY[i], p);
      worldToScreen(view, rx, ry, q);
      c.setLineDash([6, 4]);
      c.lineDashOffset = -((nowMs * 0.02) % 10);                // ants march toward the flag
      c.strokeStyle = 'rgba(132,200,255,0.85)';
      c.lineWidth = Math.max(1, 1.5 * z);
      c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(q.x, q.y); c.stroke();
      c.setLineDash([]);
      c.lineDashOffset = 0;
      const flutter = Math.sin(nowMs * 0.006) * z;
      const flag = getSprite(spriteKey(SPRITE_KIND_FX, FxSprite.RallyFlag, comp.owner[i], 0));
      c.drawImage(flag.canvas, q.x - flag.anchorX * z + flutter, q.y - flag.anchorY * z,
        flag.canvas.width * z, flag.canvas.height * z);
    }
  }

  function relationColor(view: ViewState, owner: number): string {
    if (owner === view.localPlayer) return '#f2f4f0';
    if (owner === 0) return '#f4e076';
    return '#e0564a';
  }

  function drawBars(c: CanvasRenderingContext2D, world: World, view: ViewState, i: number): void {
    const comp = world.comp;
    const kind = comp.kind[i];
    if (kind === EntityKind.Projectile) return;
    const hp = comp.hp[i];
    const mhp = comp.maxHp[i];
    if (mhp <= 0) return;
    const handle = makeHandle(i, world.em.generation[i]);
    const selected = selSet.has(handle);
    const underConstruction = kind === EntityKind.Building && (comp.flags[i] & FLAG_UNDER_CONSTRUCTION) !== 0;
    if (!(hp < mhp || selected || underConstruction)) return;

    const z = view.zoom;
    const variant = kind === EntityKind.Building ? buildingVariant(comp, i) : 0;
    const spr = getSprite(spriteKey(kind, comp.subtype[i], comp.owner[i], variant));
    const img = spr.canvas as OffCanvas;
    worldToScreen(view, interpX[i], interpY[i], p);
    const barW = Math.max(18, img.width * 0.62) * z;
    const barH = Math.max(3, 4 * z);
    const bx = p.x - barW / 2;
    const by = p.y - spr.anchorY * z - barH - 5 * z;
    const ratio = clamp01(hp / mhp);
    // Damage-trail: a shown ratio that eases toward the true ratio; the gap is painted white.
    let sr = shownRatio[i];
    sr += (ratio - sr) * 0.15;
    shownRatio[i] = sr;
    // 1px black frame + dark backing.
    c.fillStyle = 'rgba(0,0,0,0.78)';
    c.fillRect(bx - 2, by - 2, barW + 4, barH + 4);
    c.fillStyle = 'rgba(30,30,30,0.9)';
    c.fillRect(bx, by, barW, barH);
    // Fill (colours mirror the HUD DOM bars — spec §3.3).
    c.fillStyle = underConstruction ? '#e3a82f' : ratio > 0.66 ? '#57ae4e' : ratio > 0.33 ? '#d8a63c' : '#c9473c';
    c.fillRect(bx, by, barW * ratio, barH);
    // Trailing damage band draining toward the new value (classic AoE hit-flash).
    const trail = sr - ratio;
    if (trail > 0.002) {
      c.fillStyle = 'rgba(242,244,240,0.75)';
      c.fillRect(bx + barW * ratio, by, barW * trail, barH);
    }
    // Highlight along the top edge.
    c.fillStyle = 'rgba(255,255,255,0.2)';
    c.fillRect(bx, by, barW * ratio, 1);
    // 25% notch ticks — segmented AoE look.
    c.fillStyle = 'rgba(0,0,0,0.5)';
    for (let n = 1; n < 4; n++) c.fillRect(bx + (barW * n) / 4, by, 1, barH);
  }

  function drawSelectionRing(c: CanvasRenderingContext2D, x: number, y: number, z: number, radius: number, color: string): void {
    const pulse = 1 + 0.03 * Math.sin(curNowMs * 0.004); // gentle breathing ring
    const rx = (14 + radius * 14) * z * pulse;
    const ry = rx * 0.45;
    c.strokeStyle = 'rgba(0,0,0,0.55)';
    c.lineWidth = Math.max(2, 3 * z * pulse);
    c.beginPath();
    c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    c.stroke();
    c.strokeStyle = color;
    c.lineWidth = Math.max(1, 1.5 * z * pulse);
    c.beginPath();
    c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    c.stroke();
  }

  function drawFootprintOutline(c: CanvasRenderingContext2D, world: World, view: ViewState, i: number, color: string): void {
    const comp = world.comp;
    const cxw = comp.posX[i];
    const cyw = comp.posY[i];
    const sx = (comp.sizeX[i] || 1) / 2;
    const sy = (comp.sizeY[i] || 1) / 2;
    c.strokeStyle = 'rgba(0,0,0,0.55)';
    c.lineWidth = Math.max(2, 3 * view.zoom);
    c.beginPath();
    worldToScreen(view, cxw - sx, cyw - sy, q); c.moveTo(q.x, q.y);
    worldToScreen(view, cxw + sx, cyw - sy, q); c.lineTo(q.x, q.y);
    worldToScreen(view, cxw + sx, cyw + sy, q); c.lineTo(q.x, q.y);
    worldToScreen(view, cxw - sx, cyw + sy, q); c.lineTo(q.x, q.y);
    c.closePath();
    c.stroke();
    c.strokeStyle = color;
    c.lineWidth = Math.max(1, 1.5 * view.zoom);
    c.beginPath();
    worldToScreen(view, cxw - sx, cyw - sy, q); c.moveTo(q.x, q.y);
    worldToScreen(view, cxw + sx, cyw - sy, q); c.lineTo(q.x, q.y);
    worldToScreen(view, cxw + sx, cyw + sy, q); c.lineTo(q.x, q.y);
    worldToScreen(view, cxw - sx, cyw + sy, q); c.lineTo(q.x, q.y);
    c.closePath();
    c.stroke();
  }

  function ghostTile(c: CanvasRenderingContext2D, view: ViewState, tx: number, ty: number): void {
    c.beginPath();
    worldToScreen(view, tx, ty, q); c.moveTo(q.x, q.y);
    worldToScreen(view, tx + 1, ty, q); c.lineTo(q.x, q.y);
    worldToScreen(view, tx + 1, ty + 1, q); c.lineTo(q.x, q.y);
    worldToScreen(view, tx, ty + 1, q); c.lineTo(q.x, q.y);
    c.closePath();
  }

  function drawGhost(c: CanvasRenderingContext2D, view: ViewState): void {
    const g = view.ghost;
    if (!g) return;
    const z = view.zoom;
    const sizeX = g.sizeX && g.sizeX > 0 ? g.sizeX : 0;
    const sizeY = g.sizeY && g.sizeY > 0 ? g.sizeY : 0;

    if (sizeX > 0 && sizeY > 0) {
      // Footprint-true ghost: translucent building sprite preview + per-tile tint.
      const cxw = g.tileX + sizeX / 2;
      const cyw = g.tileY + sizeY / 2;
      const variant = ((sizeX & 0xf) << 4) | (sizeY & 0xf);
      const spr = getSprite(spriteKey(EntityKind.Building, g.building, view.localPlayer, variant));
      const img = spr.canvas as OffCanvas;
      worldToScreen(view, cxw, cyw, p);
      c.globalAlpha = 0.55;
      c.drawImage(img, p.x - spr.anchorX * z, p.y - spr.anchorY * z, img.width * z, img.height * z);
      c.globalAlpha = 1;

      const tv = g.tileValid;
      for (let dy = 0; dy < sizeY; dy++) {
        for (let dx = 0; dx < sizeX; dx++) {
          const ok = tv ? tv[dy * sizeX + dx] === 1 : g.valid;
          ghostTile(c, view, g.tileX + dx, g.tileY + dy);
          c.fillStyle = ok ? 'rgba(91,191,100,0.28)' : 'rgba(214,82,71,0.34)';
          c.fill();
        }
      }
      // Footprint outline.
      c.strokeStyle = 'rgba(0,0,0,0.55)';
      c.lineWidth = Math.max(2, 2 * z);
      drawWorldRectOutline(c, view, cxw, cyw, sizeX / 2, sizeY / 2, g.valid ? '#78d37b' : '#e06b5f', 1);
      return;
    }

    // Fallback: 1x1 anchor-tile highlight (no footprint fields present — spec R2).
    ghostTile(c, view, g.tileX, g.tileY);
    c.fillStyle = g.valid ? 'rgba(91,191,100,0.34)' : 'rgba(214,82,71,0.36)';
    c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.55)';
    c.lineWidth = Math.max(2, 2 * z);
    c.stroke();
    c.strokeStyle = g.valid ? '#78d37b' : '#e06b5f';
    c.lineWidth = Math.max(1, 1.25 * z);
    c.stroke();
  }

  function drawPointerFeedback(c: CanvasRenderingContext2D, world: World, view: ViewState): void {
    const pointer = view.pointer;
    if (!pointer) return;

    if (pointer.inside && pointer.intent !== 'default') {
      drawHoverTile(c, view);
      drawHoverTarget(c, world, view);
    }
    if (pointer.drag?.active && pointer.drag.moved) drawDragRect(c, pointer.drag.startX, pointer.drag.startY, pointer.drag.curX, pointer.drag.curY);

    const markers = pointer.markers;
    for (let i = 0; i < markers.length; i++) drawClickMarker(c, markers[i].kind, markers[i].x, markers[i].y, markers[i].ttlMs / markers[i].totalMs);
    c.globalAlpha = 1;
  }

  function drawHoverTile(c: CanvasRenderingContext2D, view: ViewState): void {
    const pointer = view.pointer;
    if (!pointer || pointer.hoverTileX < 0 || pointer.hoverTileY < 0) return;
    const color = intentColor(pointer.intent);
    c.beginPath();
    worldToScreen(view, pointer.hoverTileX, pointer.hoverTileY, q); c.moveTo(q.x, q.y);
    worldToScreen(view, pointer.hoverTileX + 1, pointer.hoverTileY, q); c.lineTo(q.x, q.y);
    worldToScreen(view, pointer.hoverTileX + 1, pointer.hoverTileY + 1, q); c.lineTo(q.x, q.y);
    worldToScreen(view, pointer.hoverTileX, pointer.hoverTileY + 1, q); c.lineTo(q.x, q.y);
    c.closePath();
    c.globalAlpha = 0.2;
    c.fillStyle = color;
    c.fill();
    c.globalAlpha = 1;
    c.strokeStyle = color;
    c.lineWidth = Math.max(1, 1.25 * view.zoom);
    c.stroke();
  }

  function drawHoverTarget(c: CanvasRenderingContext2D, world: World, view: ViewState): void {
    const pointer = view.pointer;
    if (!pointer || pointer.hoverHandle < 0) return;
    const i = resolveHandle(world.em, pointer.hoverHandle);
    if (i < 0) return;
    const comp = world.comp;
    const color = intentColor(pointer.intent);
    worldToScreen(view, comp.posX[i], comp.posY[i], p);
    if (comp.kind[i] === EntityKind.Building) {
      const sx = (comp.sizeX[i] || 1) / 2;
      const sy = (comp.sizeY[i] || 1) / 2;
      drawWorldRectOutline(c, view, comp.posX[i], comp.posY[i], sx, sy, color, 1.15);
      return;
    }
    c.strokeStyle = 'rgba(0,0,0,0.58)';
    c.lineWidth = Math.max(2, 3 * view.zoom);
    c.beginPath();
    c.ellipse(p.x, p.y, 15 * view.zoom, 7 * view.zoom, 0, 0, Math.PI * 2);
    c.stroke();
    c.strokeStyle = color;
    c.lineWidth = Math.max(1, 1.5 * view.zoom);
    c.beginPath();
    c.ellipse(p.x, p.y, 15 * view.zoom, 7 * view.zoom, 0, 0, Math.PI * 2);
    c.stroke();
  }

  function drawWorldRectOutline(
    c: CanvasRenderingContext2D,
    view: ViewState,
    cxw: number,
    cyw: number,
    sx: number,
    sy: number,
    color: string,
    widthScale: number,
  ): void {
    c.strokeStyle = 'rgba(0,0,0,0.58)';
    c.lineWidth = Math.max(2, 3 * view.zoom * widthScale);
    c.beginPath();
    worldToScreen(view, cxw - sx, cyw - sy, q); c.moveTo(q.x, q.y);
    worldToScreen(view, cxw + sx, cyw - sy, q); c.lineTo(q.x, q.y);
    worldToScreen(view, cxw + sx, cyw + sy, q); c.lineTo(q.x, q.y);
    worldToScreen(view, cxw - sx, cyw + sy, q); c.lineTo(q.x, q.y);
    c.closePath();
    c.stroke();
    c.strokeStyle = color;
    c.lineWidth = Math.max(1, 1.5 * view.zoom * widthScale);
    c.beginPath();
    worldToScreen(view, cxw - sx, cyw - sy, q); c.moveTo(q.x, q.y);
    worldToScreen(view, cxw + sx, cyw - sy, q); c.lineTo(q.x, q.y);
    worldToScreen(view, cxw + sx, cyw + sy, q); c.lineTo(q.x, q.y);
    worldToScreen(view, cxw - sx, cyw + sy, q); c.lineTo(q.x, q.y);
    c.closePath();
    c.stroke();
  }

  function drawDragRect(c: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
    const l = Math.min(x0, x1);
    const t = Math.min(y0, y1);
    const r = Math.max(x0, x1);
    const b = Math.max(y0, y1);
    c.fillStyle = 'rgba(244,224,118,0.16)';
    c.fillRect(l, t, r - l, b - t);
    c.strokeStyle = 'rgba(0,0,0,0.72)';
    c.lineWidth = 3;
    strokeScreenRect(c, l, t, r, b);
    c.strokeStyle = 'rgba(244,224,118,0.95)';
    c.lineWidth = 1.5;
    strokeScreenRect(c, l, t, r, b);
  }

  function drawClickMarker(c: CanvasRenderingContext2D, kind: string, x: number, y: number, t: number): void {
    const color = intentColor(kind);
    const fade = clamp01(t);
    const radius = 8 + (1 - fade) * 20;
    c.globalAlpha = fade;
    c.strokeStyle = 'rgba(0,0,0,0.62)';
    c.lineWidth = 4;
    c.beginPath();
    c.ellipse(x, y, radius, radius * 0.48, 0, 0, Math.PI * 2);
    c.stroke();
    c.strokeStyle = color;
    c.lineWidth = 2;
    c.beginPath();
    c.ellipse(x, y, radius, radius * 0.48, 0, 0, Math.PI * 2);
    c.stroke();
    drawMarkerIcon(c, kind, x, y, color, fade);
    c.globalAlpha = 1;
  }

  function drawMarkerIcon(c: CanvasRenderingContext2D, kind: string, x: number, y: number, color: string, alpha: number): void {
    c.globalAlpha = alpha;
    c.strokeStyle = color;
    c.fillStyle = color;
    c.lineWidth = 2;
    if (kind === 'attack' || kind === 'invalid') {
      lineScreen(c, x - 7, y - 7, x + 7, y + 7);
      lineScreen(c, x + 7, y - 7, x - 7, y + 7);
      return;
    }
    if (kind === 'build') {
      strokeScreenRect(c, x - 7, y - 7, x + 7, y + 7);
      lineScreen(c, x - 7, y, x + 7, y);
      return;
    }
    if (kind === 'gather') {
      c.beginPath();
      c.ellipse(x - 3, y, 5, 8, -0.55, 0, Math.PI * 2);
      c.stroke();
      c.beginPath();
      c.ellipse(x + 4, y + 1, 5, 8, 0.55, 0, Math.PI * 2);
      c.stroke();
      return;
    }
    if (kind === 'rally') {
      lineScreen(c, x - 5, y + 8, x - 5, y - 9);
      c.beginPath();
      c.moveTo(x - 4, y - 9); c.lineTo(x + 9, y - 5); c.lineTo(x - 4, y); c.closePath(); c.fill();
      return;
    }
    if (kind === 'move') {
      lineScreen(c, x - 9, y, x + 9, y);
      lineScreen(c, x + 3, y - 6, x + 9, y);
      lineScreen(c, x + 3, y + 6, x + 9, y);
      return;
    }
    c.beginPath();
    c.arc(x, y, 4, 0, Math.PI * 2);
    c.fill();
  }

  function strokeScreenRect(c: CanvasRenderingContext2D, l: number, t: number, r: number, b: number): void {
    c.beginPath();
    c.moveTo(l, t); c.lineTo(r, t); c.lineTo(r, b); c.lineTo(l, b); c.closePath();
    c.stroke();
  }

  function lineScreen(c: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
    c.stroke();
  }

  function intentColor(kind: string): string {
    switch (kind) {
      case 'attack': return '#e96557';
      case 'gather': return '#80d26e';
      case 'build': return '#e4b95f';
      case 'rally': return '#84c8ff';
      case 'invalid': return '#e65f5f';
      case 'move': return '#f0df8a';
      case 'select': return '#f4e076';
      default: return '#f4e076';
    }
  }

  return {
    init(cv: HTMLCanvasElement): void {
      canvas = cv;
      ctx = cv.getContext('2d');
    },
    resize(width: number, height: number): void {
      if (canvas) {
        canvas.width = Math.max(1, width | 0);
        canvas.height = Math.max(1, height | 0);
      }
    },
    render(world: World, view: ViewState, alpha: number): void {
      const c = ctx;
      if (!c) return;
      ensureTerrain(world);
      ensureBuffers(world.comp.capacity, world.mapSize);
      warmFx();
      ensureVignette(view.viewportW | 0, view.viewportH | 0);

      // Frame time: sim-paced anim uses world.tick+alpha; cosmetic FX use wall-clock.
      curNowMs = typeof performance !== 'undefined' ? performance.now() : 0;
      curDtMs = lastNowMs > 0 ? Math.min(100, curNowMs - lastNowMs) : 16;
      lastNowMs = curNowMs;
      const nowMs = curNowMs;

      // Background (unexplored reads as black).
      c.globalAlpha = 1;
      c.fillStyle = '#070908';
      c.fillRect(0, 0, view.viewportW, view.viewportH);

      terrain!.draw(c, world, view);
      terrain!.drawWaterOverlay(c, world, view, nowMs);
      terrain!.drawWindOverlay(c, world, view, nowMs);

      selSet.clear();
      const sel = view.selection;
      for (let s = 0; s < sel.length; s++) selSet.add(sel[s]);

      // Sort FIRST so this frame's deaths are already in the corpse ring, which draws
      // beneath the ghost and the live entity layer (bodies underfoot, dust on top).
      const total = sortEntities(world, view, alpha, nowMs);
      drawCorpses(c, view, nowMs);
      if (view.ghost) drawGhost(c, view);
      drawFootFx(c, view, nowMs);

      for (let s = 0; s < total; s++) {
        const i = sortedIdx[s];
        drawEntity(c, world, view, i, drawStatus[i], alpha, nowMs);
      }
      drawFleckFx(c, view, nowMs);
      for (let s = 0; s < total; s++) {
        drawBars(c, world, view, sortedIdx[s]);
      }

      drawDeathPuffs(c, view, nowMs);
      drawRallyPoints(c, world, view, nowMs);

      terrain!.drawFog(c, world, view);
      if (vignetteCanvas) c.drawImage(vignetteCanvas, 0, 0, view.viewportW, view.viewportH);
      drawPointerFeedback(c, world, view);
    },
    renderMinimap(world: World, view: ViewState, mmCtx: CanvasRenderingContext2D): void {
      drawMinimap(world, view, mmCtx);
    },
    dispose(): void {
      clearSpriteCache();
      terrain = null;
      terrainMapSize = -1;
      fxWarmed = false;
      vignetteCanvas = null;
      vignetteW = -1;
      vignetteH = -1;
      ctx = null;
      canvas = null;
    },
  };
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
function easeOut(v: number): number { const u = 1 - v; return 1 - u * u; }
