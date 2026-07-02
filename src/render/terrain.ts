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

import { TILE_W, TILE_H } from '../shared/constants';
import { Terrain, ResourceNode } from '../shared/enums';
import { isoX, isoY } from '../shared/iso';
import type { World } from '../shared/world';
import type { ViewState } from '../shared/interfaces';
import { createOffscreenCanvas, get2d, type OffCanvas } from './sprites';

export interface TerrainLayer {
  draw(ctx: CanvasRenderingContext2D, world: World, view: ViewState): void;
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
        const baseContrib = explored ? map.resourceType[ti] * 8 + map.terrain[ti] + 1 : 0;
        const fogContrib = explored ? (visible ? 2 : 1) : 0;
        baseFold[c] = (Math.imul(baseFold[c], 33) + baseContrib) | 0;
        fogFold[c] = (Math.imul(fogFold[c], 33) + fogContrib) | 0;
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
    for (let ty = y0; ty < yEnd; ty++) {
      for (let tx = x0; tx < xEnd; tx++) {
        const ti = ty * size + tx;
        if (((map.explored[ti] >> lp) & 1) === 0) continue;
        const lx = isoX(tx, ty) - originIsoX;
        const ly = isoY(tx, ty) - originIsoY;
        ctx.fillStyle = terrainColor(map.terrain[ti], tx, ty);
        tileDiamond(ctx, lx, ly);
        ctx.fill();
        ctx.strokeStyle = terrainEdgeColor(map.terrain[ti]);
        ctx.lineWidth = 1;
        ctx.stroke();
        const node = map.resourceType[ti];
        if (node !== ResourceNode.None) {
          drawNode(ctx, node, lx, ly + HH); // node centred on tile centre
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
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    for (let ty = y0; ty < yEnd; ty++) {
      for (let tx = x0; tx < xEnd; tx++) {
        const ti = ty * size + tx;
        const explored = (map.explored[ti] >> lp) & 1;
        const visible = (map.visible[ti] >> lp) & 1;
        if (explored && !visible) {
          tileDiamond(ctx, isoX(tx, ty) - originIsoX, isoY(tx, ty) - originIsoY);
          ctx.fill();
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

  return {
    draw(ctx, world, view) {
      refresh(world, view);
      composite(ctx, baseCanvas, baseDirty, redrawBase, world, view);
    },
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

function terrainColor(terrain: number, tx: number, ty: number): string {
  const noise = (Math.imul(tx + 17, 92837111) ^ Math.imul(ty + 31, 689287499)) & 3;
  const alt = ((tx + ty + noise) & 1) === 0;
  switch (terrain) {
    case Terrain.Water: return alt ? '#2f69a9' : '#245b95';
    case Terrain.Dirt: return alt ? '#967f52' : '#806b45';
    case Terrain.Grass:
    default: return alt ? '#547f3f' : '#496f37';
  }
}

function terrainEdgeColor(terrain: number): string {
  switch (terrain) {
    case Terrain.Water: return 'rgba(119,169,205,0.18)';
    case Terrain.Dirt: return 'rgba(62,45,25,0.18)';
    case Terrain.Grass:
    default: return 'rgba(24,45,22,0.18)';
  }
}

// cx = tile top-corner x; cyCenter = tile CENTRE y (caller passes ly + HH).
function drawNode(ctx: CanvasRenderingContext2D, node: number, cx: number, cyCenter: number): void {
  switch (node) {
    case ResourceNode.Tree: {
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.beginPath(); ctx.ellipse(cx, cyCenter + 5, 9, 3, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#5b3b20';
      ctx.fillRect(cx - 2, cyCenter - 3, 4, 11);
      ctx.fillStyle = '#244f25';
      ctx.beginPath(); ctx.arc(cx, cyCenter - 8, 8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#32743a';
      ctx.beginPath();
      ctx.arc(cx - 5, cyCenter - 7, 5, 0, Math.PI * 2);
      ctx.arc(cx + 5, cyCenter - 7, 5, 0, Math.PI * 2);
      ctx.arc(cx, cyCenter - 13, 5, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case ResourceNode.Forage: {
      ctx.fillStyle = 'rgba(0,0,0,0.16)';
      ctx.beginPath(); ctx.ellipse(cx, cyCenter + 4, 8, 3, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#2f6730';
      ctx.beginPath();
      ctx.arc(cx - 4, cyCenter, 5, 0, Math.PI * 2);
      ctx.arc(cx + 3, cyCenter - 1, 5, 0, Math.PI * 2);
      ctx.arc(cx, cyCenter + 3, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#c84434';
      ctx.beginPath();
      ctx.arc(cx - 4, cyCenter - 2, 1.4, 0, Math.PI * 2);
      ctx.arc(cx + 3, cyCenter - 2, 1.4, 0, Math.PI * 2);
      ctx.arc(cx, cyCenter + 2, 1.4, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case ResourceNode.GoldMine: {
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.beginPath(); ctx.ellipse(cx, cyCenter + 6, 9, 4, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#6b5428';
      ctx.beginPath();
      ctx.arc(cx - 4, cyCenter + 2, 5, 0, Math.PI * 2);
      ctx.arc(cx + 4, cyCenter + 2, 6, 0, Math.PI * 2);
      ctx.arc(cx, cyCenter - 2, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#f0c23c';
      ctx.beginPath();
      ctx.arc(cx - 3, cyCenter, 2, 0, Math.PI * 2);
      ctx.arc(cx + 3, cyCenter + 1, 2, 0, Math.PI * 2);
      ctx.arc(cx, cyCenter + 4, 1.7, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case ResourceNode.StoneMine: {
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.beginPath(); ctx.ellipse(cx, cyCenter + 6, 10, 4, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#5d636b';
      ctx.beginPath();
      ctx.arc(cx - 4, cyCenter + 3, 6, 0, Math.PI * 2);
      ctx.arc(cx + 5, cyCenter + 3, 5, 0, Math.PI * 2);
      ctx.arc(cx + 1, cyCenter - 2, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#aab0b7';
      ctx.beginPath();
      ctx.arc(cx - 3, cyCenter + 1, 2, 0, Math.PI * 2);
      ctx.arc(cx + 4, cyCenter, 2, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    default:
      break;
  }
}
