// src/render/terrain.ts
// T7 — chunk-cached isometric terrain + resource nodes, plus the fog overlay layer.
//
// The map is split into 16x16-tile chunks, each pre-rendered into its own offscreen
// canvas and re-drawn ONLY when it changes. Two independent caches per chunk:
//   * base : terrain colour + resource-node glyphs, redrawn when explored/resource/terrain
//            bits for the local player change.
//   * fog  : 35% black over explored-but-not-currently-visible tiles, redrawn when
//            explored/visible bits change.
// Change detection folds a cheap per-chunk signature, recomputed only when world.tick
// advances (so the ~60fps render loop does at most one map scan per sim tick).
//
// Imports: shared only (+ the sibling sprites.ts for the offscreen-canvas factory).

import { TILE_W, TILE_H, TREE_WOOD, FORAGE_FOOD, GOLD_PER_MINE, STONE_PER_MINE } from '../shared/constants';
import { Terrain, ResourceNode } from '../shared/enums';
import { isoX, isoY } from '../shared/iso';
import type { World } from '../shared/world';
import type { ViewState } from '../shared/interfaces';
import {
  createOffscreenCanvas, get2d, getSprite, spriteKey, SPRITE_KIND_FX, FxSprite, type OffCanvas,
} from './sprites';

export interface TerrainLayer {
  draw(ctx: CanvasRenderingContext2D, world: World, view: ViewState): void;
  /** Animated water shimmer stamped over the (already-drawn) base terrain. */
  drawWaterOverlay(ctx: CanvasRenderingContext2D, world: World, view: ViewState, nowMs: number): void;
  drawFog(ctx: CanvasRenderingContext2D, world: World, view: ViewState): void;
  markDirty(tile: number): void;
  markAllDirty(): void;
}

const CHUNK = 16;
const CHUNK_W = CHUNK * TILE_W; // 1024
const CHUNK_H = CHUNK * TILE_H; // 512
const HW = TILE_W / 2;
const HH = TILE_H / 2;

export function createTerrainLayer(mapSize: number): TerrainLayer {
  const size = mapSize;
  const chunksX = Math.ceil(size / CHUNK);
  const chunksY = Math.ceil(size / CHUNK);
  const numChunks = chunksX * chunksY;

  const baseCanvas: (OffCanvas | null)[] = new Array(numChunks).fill(null);
  const fogCanvas: (OffCanvas | null)[] = new Array(numChunks).fill(null);
  const baseDirty = new Uint8Array(numChunks).fill(1);
  const fogDirty = new Uint8Array(numChunks).fill(1);
  const baseSig = new Int32Array(numChunks);
  const fogSig = new Int32Array(numChunks);
  const baseFold = new Int32Array(numChunks);
  const fogFold = new Int32Array(numChunks);

  // Per-chunk water-tile centre lists (local chunk-canvas pixels, [cx,cy] pairs).
  // Lazily allocated on first water tile in a chunk; rebuilt only on chunk redraw.
  const waterTiles: (Int16Array | null)[] = new Array(numChunks).fill(null);
  const waterCount = new Int32Array(numChunks);

  let lastTick = -1;
  let lastLP = -1;
  let forceAll = true;

  function chunkOf(tile: number): number {
    const tx = tile % size;
    const ty = (tile / size) | 0;
    return ((ty / CHUNK) | 0) * chunksX + ((tx / CHUNK) | 0);
  }

  // Recompute per-chunk signatures (at most once per sim tick) and flag changed chunks.
  function refresh(world: World, view: ViewState): void {
    const lp = view.localPlayer;
    if (!forceAll && world.tick === lastTick && lp === lastLP) return;
    const lpChanged = lp !== lastLP;
    const map = world.map;
    baseFold.fill(0);
    fogFold.fill(0);
    for (let ty = 0; ty < size; ty++) {
      const cyBase = ((ty / CHUNK) | 0) * chunksX;
      const row = ty * size;
      for (let tx = 0; tx < size; tx++) {
        const c = cyBase + ((tx / CHUNK) | 0);
        const ti = row + tx;
        const explored = (map.explored[ti] >> lp) & 1;
        const visible = (map.visible[ti] >> lp) & 1;
        // Include the resource-depletion stage so a node crossing a stage boundary
        // redraws its chunk (rare — a handful per minute).
        const stage = explored ? depletionStage(map.resourceType[ti], map.resourceAmount[ti]) : 0;
        const baseContrib = explored ? (map.resourceType[ti] * 4 + stage) * 4 + map.terrain[ti] + 1 : 0;
        const fogContrib = explored ? (visible ? 2 : 1) : 0;
        baseFold[c] = (Math.imul(baseFold[c], 33) + baseContrib) | 0;
        fogFold[c] = (Math.imul(fogFold[c], 33) + fogContrib) | 0;
        // Mandatory cross-chunk fold: a chunk's edge blend / shoreline / fog feather
        // reads its west & north neighbours, so a tile on a chunk's right/bottom border
        // also influences the NEXT chunk east / south. Fold its contribution there too,
        // or those neighbour chunks go stale when this tile's explored/stage flips.
        if ((tx % CHUNK) === CHUNK - 1 && tx + 1 < size) {
          const cE = cyBase + (((tx + 1) / CHUNK) | 0);
          baseFold[cE] = (Math.imul(baseFold[cE], 33) + baseContrib + 7) | 0;
          fogFold[cE] = (Math.imul(fogFold[cE], 33) + fogContrib + 7) | 0;
        }
        if ((ty % CHUNK) === CHUNK - 1 && ty + 1 < size) {
          const cS = (((ty + 1) / CHUNK) | 0) * chunksX + ((tx / CHUNK) | 0);
          baseFold[cS] = (Math.imul(baseFold[cS], 33) + baseContrib + 13) | 0;
          fogFold[cS] = (Math.imul(fogFold[cS], 33) + fogContrib + 13) | 0;
        }
      }
    }
    for (let c = 0; c < numChunks; c++) {
      if (forceAll || lpChanged || baseFold[c] !== baseSig[c]) { baseSig[c] = baseFold[c]; baseDirty[c] = 1; }
      if (forceAll || lpChanged || fogFold[c] !== fogSig[c]) { fogSig[c] = fogFold[c]; fogDirty[c] = 1; }
    }
    lastTick = world.tick;
    lastLP = lp;
    forceAll = false;
  }

  function redrawBase(c: number, world: World, view: ViewState): void {
    let canvas = baseCanvas[c];
    if (!canvas) { canvas = createOffscreenCanvas(CHUNK_W, CHUNK_H); baseCanvas[c] = canvas; }
    const ctx = get2d(canvas);
    ctx.clearRect(0, 0, CHUNK_W, CHUNK_H);
    const cx = c % chunksX;
    const cy = (c / chunksX) | 0;
    const x0 = cx * CHUNK;
    const y0 = cy * CHUNK;
    const originIsoX = (x0 - y0) * HW - CHUNK_W / 2;
    const originIsoY = (x0 + y0) * HH;
    const lp = view.localPlayer;
    const map = world.map;
    const xEnd = Math.min(x0 + CHUNK, size);
    const yEnd = Math.min(y0 + CHUNK, size);
    waterCount[c] = 0;
    let wlist = waterTiles[c];
    for (let ty = y0; ty < yEnd; ty++) {
      for (let tx = x0; tx < xEnd; tx++) {
        const ti = ty * size + tx;
        if (((map.explored[ti] >> lp) & 1) === 0) continue;
        const terrain = map.terrain[ti];
        const lx = isoX(tx, ty) - originIsoX;
        const ly = isoY(tx, ty) - originIsoY;
        const cyc = ly + HH; // tile centre y
        ctx.fillStyle = terrainColor(terrain, tx, ty);
        tileDiamond(ctx, lx, ly);
        ctx.fill();
        // Water keeps a very faint outline; land tiles rely on edge blending instead.
        if (terrain === Terrain.Water) {
          ctx.strokeStyle = terrainEdgeColor(terrain);
          ctx.lineWidth = 1;
          ctx.stroke();
          if (!wlist) { wlist = new Int16Array(CHUNK * CHUNK * 2); waterTiles[c] = wlist; }
          const wc = waterCount[c];
          wlist[wc * 2] = lx; wlist[wc * 2 + 1] = cyc; waterCount[c] = wc + 1;
        }

        drawTileDetail(ctx, terrain, lx, cyc, hash32(tx, ty));

        // Edge blending / shoreline against the WEST and NORTH neighbours (both
        // explored). West neighbour shares the top->left edge; north the top->right.
        if (tx > 0) {
          const nti = ti - 1;
          const nterr = map.terrain[nti];
          if (nterr !== terrain && ((map.explored[nti] >> lp) & 1)) {
            edgeBlend(ctx, terrain, nterr, tx - 1, ty, lx, ly, lx - HW, cyc, lx, cyc);
          }
        }
        if (ty > 0) {
          const nti = ti - size;
          const nterr = map.terrain[nti];
          if (nterr !== terrain && ((map.explored[nti] >> lp) & 1)) {
            edgeBlend(ctx, terrain, nterr, tx, ty - 1, lx, ly, lx + HW, cyc, lx, cyc);
          }
        }

        const node = map.resourceType[ti];
        if (node !== ResourceNode.None) {
          drawNode(ctx, node, lx, cyc, depletionStage(node, map.resourceAmount[ti]), hash32(tx, ty));
        }
      }
    }
    baseDirty[c] = 0;
  }

  function redrawFog(c: number, world: World, view: ViewState): void {
    let canvas = fogCanvas[c];
    if (!canvas) { canvas = createOffscreenCanvas(CHUNK_W, CHUNK_H); fogCanvas[c] = canvas; }
    const ctx = get2d(canvas);
    ctx.clearRect(0, 0, CHUNK_W, CHUNK_H);
    const cx = c % chunksX;
    const cy = (c / chunksX) | 0;
    const x0 = cx * CHUNK;
    const y0 = cy * CHUNK;
    const originIsoX = (x0 - y0) * HW - CHUNK_W / 2;
    const originIsoY = (x0 + y0) * HH;
    const lp = view.localPlayer;
    const map = world.map;
    const xEnd = Math.min(x0 + CHUNK, size);
    const yEnd = Math.min(y0 + CHUNK, size);
    for (let ty = y0; ty < yEnd; ty++) {
      for (let tx = x0; tx < xEnd; tx++) {
        const ti = ty * size + tx;
        const explored = (map.explored[ti] >> lp) & 1;
        if (!explored) continue; // unexplored: black background shows through
        const visible = (map.visible[ti] >> lp) & 1;
        const lx = isoX(tx, ty) - originIsoX;
        const ly = isoY(tx, ty) - originIsoY;
        if (!visible) {
          // Base fog + an extra feather that darkens toward the unexplored void.
          ctx.fillStyle = 'rgba(0,0,0,0.35)';
          tileDiamond(ctx, lx, ly); ctx.fill();
          if (hasUnexploredNeighbor(map, size, tx, ty, lp)) {
            ctx.fillStyle = 'rgba(0,0,0,0.30)';
            tileDiamond(ctx, lx, ly); ctx.fill();
          }
        } else if (hasFoggedNeighbor(map, size, tx, ty, lp)) {
          // Visible tile on a fog boundary: soft feather so the edge isn't a hard step.
          ctx.fillStyle = 'rgba(0,0,0,0.14)';
          tileDiamond(ctx, lx, ly); ctx.fill();
        }
      }
    }
    fogDirty[c] = 0;
  }

  function composite(ctx: CanvasRenderingContext2D, canvases: (OffCanvas | null)[], dirty: Uint8Array,
    redraw: (c: number, w: World, v: ViewState) => void, world: World, view: ViewState): void {
    const zoom = view.zoom;
    const camIX = isoX(view.camX, view.camY);
    const camIY = isoY(view.camX, view.camY);
    const halfW = view.viewportW / 2;
    const halfH = view.viewportH / 2;
    const cw = CHUNK_W * zoom;
    const ch = CHUNK_H * zoom;
    for (let cy = 0; cy < chunksY; cy++) {
      for (let cx = 0; cx < chunksX; cx++) {
        const c = cy * chunksX + cx;
        const x0 = cx * CHUNK;
        const y0 = cy * CHUNK;
        const originIsoX = (x0 - y0) * HW - CHUNK_W / 2;
        const originIsoY = (x0 + y0) * HH;
        const sx = (originIsoX - camIX) * zoom + halfW;
        const sy = (originIsoY - camIY) * zoom + halfH;
        if (sx + cw < 0 || sx > view.viewportW || sy + ch < 0 || sy > view.viewportH) continue;
        if (dirty[c]) redraw(c, world, view);
        const canvas = canvases[c];
        if (canvas) ctx.drawImage(canvas, sx, sy, cw, ch);
      }
    }
  }

  function drawWaterOverlay(ctx: CanvasRenderingContext2D, world: World, view: ViewState, nowMs: number): void {
    const zoom = view.zoom;
    if (zoom < 0.6) return; // shimmer not worth it when zoomed way out
    refresh(world, view);
    const camIX = isoX(view.camX, view.camY);
    const camIY = isoY(view.camX, view.camY);
    const halfW = view.viewportW / 2;
    const halfH = view.viewportH / 2;
    const cw = CHUNK_W * zoom;
    const ch = CHUNK_H * zoom;
    const frameBase = (nowMs / 450) | 0;
    const sw = TILE_W * zoom;
    const sh = TILE_H * zoom;
    const ax = (TILE_W / 2) * zoom;
    const ay = (TILE_H / 2) * zoom;
    ctx.globalAlpha = 0.8;
    for (let cy = 0; cy < chunksY; cy++) {
      for (let cx = 0; cx < chunksX; cx++) {
        const c = cy * chunksX + cx;
        if (baseDirty[c]) continue; // water list only valid once the chunk is drawn
        const cnt = waterCount[c];
        if (cnt <= 0) continue;
        const x0 = cx * CHUNK;
        const y0 = cy * CHUNK;
        const originIsoX = (x0 - y0) * HW - CHUNK_W / 2;
        const originIsoY = (x0 + y0) * HH;
        const sx = (originIsoX - camIX) * zoom + halfW;
        const sy = (originIsoY - camIY) * zoom + halfH;
        if (sx + cw < 0 || sx > view.viewportW || sy + ch < 0 || sy > view.viewportH) continue;
        const list = waterTiles[c]!;
        for (let k = 0; k < cnt; k++) {
          const lcx = list[k * 2];
          const lcy = list[k * 2 + 1];
          const frame = (hash32(lcx, lcy) + frameBase) % 3;
          const spr = getSprite(spriteKey(SPRITE_KIND_FX, FxSprite.WaterShimmer, 0, frame));
          const px = sx + lcx * zoom - ax;
          const py = sy + lcy * zoom - ay;
          ctx.drawImage(spr.canvas, px, py, sw, sh);
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  return {
    draw(ctx, world, view) {
      refresh(world, view);
      composite(ctx, baseCanvas, baseDirty, redrawBase, world, view);
    },
    drawWaterOverlay,
    drawFog(ctx, world, view) {
      refresh(world, view);
      composite(ctx, fogCanvas, fogDirty, redrawFog, world, view);
    },
    markDirty(tile) {
      if (tile < 0 || tile >= size * size) return;
      const c = chunkOf(tile);
      baseDirty[c] = 1;
      fogDirty[c] = 1;
    },
    markAllDirty() {
      forceAll = true;
      lastTick = -1;
      baseDirty.fill(1);
      fogDirty.fill(1);
    },
  };
}

// ---------------------------------------------------------------------------
// Tile + node drawing (local chunk-canvas coordinates; (lx,ly) = tile top corner).
// ---------------------------------------------------------------------------

function tileDiamond(ctx: CanvasRenderingContext2D, lx: number, ly: number): void {
  ctx.beginPath();
  ctx.moveTo(lx, ly);
  ctx.lineTo(lx + HW, ly + HH);
  ctx.lineTo(lx, ly + TILE_H);
  ctx.lineTo(lx - HW, ly + HH);
  ctx.closePath();
}

// 15-bit spatial hash — cheap, well-mixed, stable per tile (used for palettes, tufts,
// tree variety, and water-shimmer phase).
function hash32(tx: number, ty: number): number {
  let h = Math.imul(tx + 0x9e37, 0x85ebca6b) ^ Math.imul(ty + 0x79b9, 0xc2b2ae35);
  h ^= h >>> 15;
  return Math.imul(h, 0x27d4eb2f) >>> 17;
}

// Clustered multi-tone palettes: a 4-tile "coarse" cluster plus per-tile "fine" noise
// gives AoE-style patchiness without a grid checker.
const GRASS_PAL = ['#4e7a3a', '#557f3f', '#486f36', '#5d8746', '#52763c'];
const DIRT_PAL = ['#96814f', '#8a7245', '#a08a58', '#7f6a41', '#8f7a4c'];
const WATER_PAL = ['#2d67a8', '#2a5f9c', '#326fb2', '#285a93', '#2f6aac'];

function paletteFor(terrain: number): string[] {
  switch (terrain) {
    case Terrain.Water: return WATER_PAL;
    case Terrain.Dirt: return DIRT_PAL;
    case Terrain.Grass:
    default: return GRASS_PAL;
  }
}

// Fog-feather neighbour probes (4-connected). Out-of-bounds counts as neither fogged
// nor unexplored so the map border doesn't grow a spurious dark ring.
function hasFoggedNeighbor(map: World['map'], size: number, tx: number, ty: number, lp: number): boolean {
  return foggedAt(map, size, tx - 1, ty, lp) || foggedAt(map, size, tx + 1, ty, lp)
    || foggedAt(map, size, tx, ty - 1, lp) || foggedAt(map, size, tx, ty + 1, lp);
}
function foggedAt(map: World['map'], size: number, tx: number, ty: number, lp: number): boolean {
  if (tx < 0 || ty < 0 || tx >= size || ty >= size) return false;
  const ti = ty * size + tx;
  return ((map.explored[ti] >> lp) & 1) === 1 && ((map.visible[ti] >> lp) & 1) === 0;
}
function hasUnexploredNeighbor(map: World['map'], size: number, tx: number, ty: number, lp: number): boolean {
  return unexploredAt(map, size, tx - 1, ty, lp) || unexploredAt(map, size, tx + 1, ty, lp)
    || unexploredAt(map, size, tx, ty - 1, lp) || unexploredAt(map, size, tx, ty + 1, lp);
}
function unexploredAt(map: World['map'], size: number, tx: number, ty: number, lp: number): boolean {
  if (tx < 0 || ty < 0 || tx >= size || ty >= size) return false;
  const ti = ty * size + tx;
  return ((map.explored[ti] >> lp) & 1) === 0;
}

function terrainColor(terrain: number, tx: number, ty: number): string {
  const pal = paletteFor(terrain);
  const coarse = hash32(tx >> 2, ty >> 2) % 3;
  const fine = hash32(tx, ty) % 3;
  return pal[(coarse * 3 + fine) % 5];
}

function terrainEdgeColor(terrain: number): string {
  switch (terrain) {
    case Terrain.Water: return 'rgba(119,169,205,0.18)';
    case Terrain.Dirt: return 'rgba(62,45,25,0.18)';
    case Terrain.Grass:
    default: return 'rgba(24,45,22,0.18)';
  }
}

function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
}

// Baked micro-detail: ~1 glyph per 7 land tiles (grass tuft/flower, dirt pebbles).
function drawTileDetail(ctx: CanvasRenderingContext2D, terrain: number, lx: number, cyc: number, h: number): void {
  if (terrain === Terrain.Water || h % 7 !== 0) return;
  const gx = lx + (((h >> 3) % 7) - 3);
  const gy = cyc + (((h >> 6) % 5) - 2);
  if (terrain === Terrain.Grass) {
    if (h % 23 === 0) {
      ctx.fillStyle = '#e9e07a';
      ctx.beginPath(); ctx.arc(gx, gy, 1.5, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.strokeStyle = '#3f6b30'; ctx.lineWidth = 1;
      line(ctx, gx - 2, gy + 1, gx - 2, gy - 2);
      line(ctx, gx, gy + 1, gx, gy - 3);
      line(ctx, gx + 2, gy + 1, gx + 2, gy - 2);
    }
  } else {
    ctx.fillStyle = '#6f6656';
    ctx.beginPath(); ctx.arc(gx - 1, gy, 1.3, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(gx + 2, gy + 1, 1.1, 0, Math.PI * 2); ctx.fill();
  }
}

// Overlay a slim blend/shoreline wedge on a tile edge shared with a differing neighbour.
// (ax,ay)-(bx,by) = the shared edge; (centerX,centerY) = this tile's centre.
function edgeBlend(
  ctx: CanvasRenderingContext2D, thisTerr: number, nborTerr: number, nborTx: number, nborTy: number,
  ax: number, ay: number, bx: number, by: number, centerX: number, centerY: number,
): void {
  const mx = (ax + bx) / 2, my = (ay + by) / 2;
  let dx = centerX - mx, dy = centerY - my;
  const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
  if (thisTerr === Terrain.Water || nborTerr === Terrain.Water) {
    // Shoreline: sand wedge on the LAND side + a foam line along the edge.
    const s = thisTerr !== Terrain.Water ? 1 : -1;
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = '#c9b57c';
    ctx.beginPath();
    ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(mx + dx * 5 * s, my + dy * 5 * s); ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(235,244,248,0.7)'; ctx.lineWidth = 1.5;
    line(ctx, ax, ay, bx, by);
    return;
  }
  ctx.globalAlpha = 0.4;
  ctx.fillStyle = terrainColor(nborTerr, nborTx, nborTy);
  ctx.beginPath();
  ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(mx + dx * 4, my + dy * 4); ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
}

// Node fullness -> depletion stage. 0 = full ... 3 = nearly gone / stump.
function depletionStage(node: number, amount: number): number {
  let full: number;
  switch (node) {
    case ResourceNode.Tree: full = TREE_WOOD; break;
    case ResourceNode.Forage: full = FORAGE_FOOD; break;
    case ResourceNode.GoldMine: full = GOLD_PER_MINE; break;
    case ResourceNode.StoneMine: full = STONE_PER_MINE; break;
    default: return 0;
  }
  const r = full > 0 ? amount / full : 0;
  return r > 0.75 ? 0 : r > 0.4 ? 1 : r > 0.1 ? 2 : 3;
}

// cx = tile top-corner x; cyCenter = tile CENTRE y (caller passes ly + HH). `stage`
// shrinks the node as it depletes; `h` picks a per-tile silhouette / size variety.
function drawNode(ctx: CanvasRenderingContext2D, node: number, cx: number, cyCenter: number, stage: number, h: number): void {
  switch (node) {
    case ResourceNode.Tree: {
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.beginPath(); ctx.ellipse(cx, cyCenter + 5, 9, 3, 0, 0, Math.PI * 2); ctx.fill();
      if (stage >= 3) {
        // Stump: short trunk + cut ring.
        ctx.fillStyle = '#6b4a2a';
        ctx.beginPath(); ctx.ellipse(cx, cyCenter + 3, 4, 2.2, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#8a6236';
        ctx.beginPath(); ctx.ellipse(cx, cyCenter + 1, 3.4, 1.8, 0, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#5b3b20'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.ellipse(cx, cyCenter + 1, 2, 1, 0, 0, Math.PI * 2); ctx.stroke();
        return;
      }
      const variety = h % 3; // 0 round, 1 tall, 2 wide
      const jit = ((h >> 4) % 3) - 1;
      const trunkH = stage === 2 ? 7 : 11;
      ctx.fillStyle = '#5b3b20';
      ctx.fillRect(cx - 2, cyCenter - 3, 4, trunkH);
      if (stage === 2) {
        // Sparse: a single small blob atop the trunk.
        ctx.fillStyle = '#2c5a2d';
        ctx.beginPath(); ctx.arc(cx, cyCenter - 6, 5 + jit, 0, Math.PI * 2); ctx.fill();
        return;
      }
      const scale = stage === 1 ? 0.78 : 1;
      ctx.fillStyle = '#244f25';
      if (variety === 1) {
        // Tall pine-ish triangle canopy.
        ctx.beginPath();
        ctx.moveTo(cx, cyCenter - (17 + jit) * scale);
        ctx.lineTo(cx + 7 * scale, cyCenter - 2);
        ctx.lineTo(cx - 7 * scale, cyCenter - 2);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#32743a';
        ctx.beginPath();
        ctx.moveTo(cx, cyCenter - (12 + jit) * scale);
        ctx.lineTo(cx + 5 * scale, cyCenter - 4);
        ctx.lineTo(cx - 5 * scale, cyCenter - 4);
        ctx.closePath(); ctx.fill();
        return;
      }
      const wide = variety === 2 ? 1.25 : 1;
      ctx.beginPath(); ctx.arc(cx, cyCenter - 8, (8 + jit) * scale * wide, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#32743a';
      ctx.beginPath();
      ctx.arc(cx - 5 * wide * scale, cyCenter - 7, 5 * scale, 0, Math.PI * 2);
      ctx.arc(cx + 5 * wide * scale, cyCenter - 7, 5 * scale, 0, Math.PI * 2);
      ctx.arc(cx, cyCenter - 13 * scale, 5 * scale, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case ResourceNode.Forage: {
      ctx.fillStyle = 'rgba(0,0,0,0.16)';
      ctx.beginPath(); ctx.ellipse(cx, cyCenter + 4, 8, 3, 0, 0, Math.PI * 2); ctx.fill();
      const bushScale = stage >= 2 ? 0.72 : 1;
      ctx.fillStyle = '#2f6730';
      ctx.beginPath();
      ctx.arc(cx - 4 * bushScale, cyCenter, 5 * bushScale, 0, Math.PI * 2);
      ctx.arc(cx + 3 * bushScale, cyCenter - 1, 5 * bushScale, 0, Math.PI * 2);
      ctx.arc(cx, cyCenter + 3, 5 * bushScale, 0, Math.PI * 2);
      ctx.fill();
      // 5 - stage berries.
      const berries = Math.max(0, 5 - stage);
      const bx = [-4, 3, 0, -1, 4];
      const by = [-2, -2, 2, -4, 0];
      ctx.fillStyle = '#c84434';
      for (let k = 0; k < berries; k++) {
        ctx.beginPath(); ctx.arc(cx + bx[k] * bushScale, cyCenter + by[k], 1.4, 0, Math.PI * 2); ctx.fill();
      }
      break;
    }
    case ResourceNode.GoldMine: {
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.beginPath(); ctx.ellipse(cx, cyCenter + 6, 9, 4, 0, 0, Math.PI * 2); ctx.fill();
      if (stage >= 3) {
        ctx.fillStyle = '#7c6a44';
        ctx.beginPath(); ctx.ellipse(cx, cyCenter + 3, 7, 3, 0, 0, Math.PI * 2); ctx.fill();
        return;
      }
      const lumps = 3 - Math.min(stage, 2);
      const lx = [-4, 4, 0];
      const ly = [2, 2, -2];
      const lr = [5, 6, 5];
      ctx.fillStyle = '#6b5428';
      for (let k = 0; k < lumps; k++) {
        ctx.beginPath(); ctx.arc(cx + lx[k], cyCenter + ly[k], lr[k], 0, Math.PI * 2); ctx.fill();
      }
      if (stage <= 1) {
        ctx.fillStyle = '#f0c23c';
        ctx.beginPath();
        ctx.arc(cx - 3, cyCenter, 2, 0, Math.PI * 2);
        ctx.arc(cx + 3, cyCenter + 1, 2, 0, Math.PI * 2);
        ctx.arc(cx, cyCenter + 4, 1.7, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case ResourceNode.StoneMine: {
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.beginPath(); ctx.ellipse(cx, cyCenter + 6, 10, 4, 0, 0, Math.PI * 2); ctx.fill();
      if (stage >= 3) {
        ctx.fillStyle = '#6b7178';
        ctx.beginPath(); ctx.ellipse(cx, cyCenter + 3, 8, 3, 0, 0, Math.PI * 2); ctx.fill();
        return;
      }
      const lumps = 3 - Math.min(stage, 2);
      const sx = [-4, 5, 1];
      const sy = [3, 3, -2];
      const sr = [6, 5, 5];
      ctx.fillStyle = '#5d636b';
      for (let k = 0; k < lumps; k++) {
        ctx.beginPath(); ctx.arc(cx + sx[k], cyCenter + sy[k], sr[k], 0, Math.PI * 2); ctx.fill();
      }
      if (stage <= 1) {
        ctx.fillStyle = '#aab0b7';
        ctx.beginPath();
        ctx.arc(cx - 3, cyCenter + 1, 2, 0, Math.PI * 2);
        ctx.arc(cx + 4, cyCenter, 2, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    default:
      break;
  }
}
