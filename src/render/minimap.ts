// src/render/minimap.ts
// T7 — rotated-45° minimap: terrain colour (dim when explored-but-fogged, black when
// unexplored for the local player), entity dots in player colours, and a white viewport
// rhombus showing the current camera window.
//
// Imports: shared only (+ PLAYER_COLORS from sibling sprites.ts).

import { EntityKind } from '../shared/enums';
import { screenToWorld, type Vec2 } from '../shared/iso';
import type { World } from '../shared/world';
import type { ViewState } from '../shared/interfaces';
import { PLAYER_COLORS } from './sprites';

const scratch: Vec2 = { x: 0, y: 0 };

/** Map a world coord (or tile coord) into minimap-canvas pixels for an N-tile map. */
function project(wx: number, wy: number, size: number, W: number, H: number): void {
  const denom = size > 1 ? 2 * (size - 1) : 1;
  const nx = (wx - wy + (size - 1)) / denom;
  const ny = (wx + wy) / denom;
  scratch.x = nx * W;
  scratch.y = ny * H;
}

export function drawMinimap(world: World, view: ViewState, ctx: CanvasRenderingContext2D): void {
  const canvas = ctx.canvas;
  const W = canvas ? canvas.width : 0;
  const H = canvas ? canvas.height : 0;
  if (W <= 0 || H <= 0) return;

  const size = world.mapSize;
  const map = world.map;
  const lp = view.localPlayer;

  // Background (unexplored = black).
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, W, H);

  const cell = Math.max(1, Math.ceil(W / size) + 1);
  const half = cell / 2;

  // Terrain.
  for (let ty = 0; ty < size; ty++) {
    const row = ty * size;
    for (let tx = 0; tx < size; tx++) {
      const ti = row + tx;
      const explored = (map.explored[ti] >> lp) & 1;
      if (!explored) continue;
      const visible = (map.visible[ti] >> lp) & 1;
      project(tx, ty, size, W, H);
      ctx.fillStyle = miniColor(map.terrain[ti], visible === 0);
      ctx.fillRect(scratch.x - half, scratch.y - half, cell, cell);
    }
  }

  // Entity dots: buildings when explored, units when currently visible.
  const em = world.em;
  const comp = world.comp;
  const cap = comp.capacity;
  const dot = Math.max(2, Math.round(cell * 0.9));
  for (let i = 0; i < cap; i++) {
    if (em.alive[i] !== 1) continue;
    const kind = comp.kind[i];
    if (kind === EntityKind.Projectile) continue;
    const tx = clampTile(comp.posX[i] | 0, size);
    const ty = clampTile(comp.posY[i] | 0, size);
    const ti = ty * size + tx;
    const explored = (map.explored[ti] >> lp) & 1;
    if (!explored) continue;
    if (kind === EntityKind.Unit && ((map.visible[ti] >> lp) & 1) === 0) continue;
    project(comp.posX[i], comp.posY[i], size, W, H);
    ctx.fillStyle = PLAYER_COLORS[comp.owner[i]] ?? PLAYER_COLORS[0];
    ctx.fillRect(scratch.x - dot / 2, scratch.y - dot / 2, dot, dot);
  }

  // Viewport rhombus: project the four screen corners back to world, then to minimap.
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  ctx.beginPath();
  viewportCorner(view, 0, 0, size, W, H, true, ctx);
  viewportCorner(view, view.viewportW, 0, size, W, H, false, ctx);
  viewportCorner(view, view.viewportW, view.viewportH, size, W, H, false, ctx);
  viewportCorner(view, 0, view.viewportH, size, W, H, false, ctx);
  ctx.closePath();
  ctx.stroke();
}

function viewportCorner(view: ViewState, sx: number, sy: number, size: number, W: number, H: number,
  first: boolean, ctx: CanvasRenderingContext2D): void {
  screenToWorld(view, sx, sy, scratch);
  const wx = scratch.x;
  const wy = scratch.y;
  project(wx, wy, size, W, H);
  if (first) ctx.moveTo(scratch.x, scratch.y);
  else ctx.lineTo(scratch.x, scratch.y);
}

function clampTile(v: number, size: number): number {
  return v < 0 ? 0 : v >= size ? size - 1 : v;
}

function miniColor(terrain: number, dim: boolean): string {
  // Terrain enum: Grass 0, Dirt 1, Water 2.
  switch (terrain) {
    case 2: return dim ? '#193760' : '#2f5fa8';
    case 1: return dim ? '#463a24' : '#8a7448';
    case 0:
    default: return dim ? '#273e1d' : '#4d7c3a';
  }
}
