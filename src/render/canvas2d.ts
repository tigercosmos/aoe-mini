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

import { EntityKind, FLAG_UNDER_CONSTRUCTION } from '../shared/enums';
import { makeHandle, resolveHandle } from '../shared/world';
import type { World } from '../shared/world';
import { worldToScreen, type Vec2 } from '../shared/iso';
import type { Renderer, ViewState } from '../shared/interfaces';
import { spriteKey, getSprite, clearSpriteCache, type OffCanvas } from './sprites';
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

  const p: Vec2 = { x: 0, y: 0 };
  const q: Vec2 = { x: 0, y: 0 };
  const selSet = new Set<number>();

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
  function sortEntities(world: World, view: ViewState, alpha: number): number {
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
      if (em.alive[i] !== 1) continue;
      const kind = comp.kind[i];
      const ix = comp.prevX[i] + (comp.posX[i] - comp.prevX[i]) * alpha;
      const iy = comp.prevY[i] + (comp.posY[i] - comp.prevY[i]) * alpha;
      interpX[i] = ix;
      interpY[i] = iy;
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

  function drawEntity(c: CanvasRenderingContext2D, world: World, view: ViewState, i: number, status: number): void {
    const comp = world.comp;
    const kind = comp.kind[i];
    const sub = comp.subtype[i];
    const owner = comp.owner[i];
    worldToScreen(view, interpX[i], interpY[i], p);
    const handle = makeHandle(i, world.em.generation[i]);
    const selected = selSet.has(handle);
    const z = view.zoom;

    if (selected) {
      if (kind === EntityKind.Building) drawFootprintOutline(c, world, view, i);
      else drawSelectionRing(c, p.x, p.y, z);
    }

    const variant = kind === EntityKind.Building ? buildingVariant(comp, i) : 0;
    const spr = getSprite(spriteKey(kind, sub, owner, variant));
    const img = spr.canvas as OffCanvas;
    c.globalAlpha = status === 2 ? 0.5 : 1;
    c.drawImage(img, p.x - spr.anchorX * z, p.y - spr.anchorY * z, img.width * z, img.height * z);
    c.globalAlpha = 1;
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
    c.fillStyle = 'rgba(0,0,0,0.66)';
    c.fillRect(bx - 2, by - 2, barW + 4, barH + 4);
    c.fillStyle = 'rgba(255,255,255,0.2)';
    c.fillRect(bx - 1, by - 1, barW + 2, 1);
    c.fillStyle = underConstruction ? '#e3a82f' : ratio > 0.5 ? '#43b05a' : ratio > 0.25 ? '#d9bc35' : '#d9564a';
    c.fillRect(bx, by, barW * ratio, barH);
  }

  function drawSelectionRing(c: CanvasRenderingContext2D, x: number, y: number, z: number): void {
    c.strokeStyle = 'rgba(0,0,0,0.55)';
    c.lineWidth = Math.max(2, 3 * z);
    c.beginPath();
    c.ellipse(x, y, 14 * z, 6 * z, 0, 0, Math.PI * 2);
    c.stroke();
    c.strokeStyle = 'rgba(244,224,118,0.95)';
    c.lineWidth = Math.max(1, 1.5 * z);
    c.beginPath();
    c.ellipse(x, y, 14 * z, 6 * z, 0, 0, Math.PI * 2);
    c.stroke();
  }

  function drawFootprintOutline(c: CanvasRenderingContext2D, world: World, view: ViewState, i: number): void {
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
    c.strokeStyle = 'rgba(244,224,118,0.95)';
    c.lineWidth = Math.max(1, 1.5 * view.zoom);
    c.beginPath();
    worldToScreen(view, cxw - sx, cyw - sy, q); c.moveTo(q.x, q.y);
    worldToScreen(view, cxw + sx, cyw - sy, q); c.lineTo(q.x, q.y);
    worldToScreen(view, cxw + sx, cyw + sy, q); c.lineTo(q.x, q.y);
    worldToScreen(view, cxw - sx, cyw + sy, q); c.lineTo(q.x, q.y);
    c.closePath();
    c.stroke();
  }

  function drawGhost(c: CanvasRenderingContext2D, view: ViewState): void {
    const g = view.ghost;
    if (!g) return;
    // NOTE: ViewState.ghost carries only the anchor tile; the footprint size is content
    // data the renderer intentionally never imports, so the highlight covers the anchor
    // tile. T8 owns validity (ghost.valid via canPlaceBuilding over the full footprint).
    c.beginPath();
    worldToScreen(view, g.tileX, g.tileY, q); c.moveTo(q.x, q.y);
    worldToScreen(view, g.tileX + 1, g.tileY, q); c.lineTo(q.x, q.y);
    worldToScreen(view, g.tileX + 1, g.tileY + 1, q); c.lineTo(q.x, q.y);
    worldToScreen(view, g.tileX, g.tileY + 1, q); c.lineTo(q.x, q.y);
    c.closePath();
    c.fillStyle = g.valid ? 'rgba(91,191,100,0.34)' : 'rgba(214,82,71,0.36)';
    c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.55)';
    c.lineWidth = Math.max(2, 2 * view.zoom);
    c.stroke();
    c.strokeStyle = g.valid ? '#78d37b' : '#e06b5f';
    c.lineWidth = Math.max(1, 1.25 * view.zoom);
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

      // Background (unexplored reads as black).
      c.globalAlpha = 1;
      c.fillStyle = '#070908';
      c.fillRect(0, 0, view.viewportW, view.viewportH);

      terrain!.draw(c, world, view);
      if (view.ghost) drawGhost(c, view);

      selSet.clear();
      const sel = view.selection;
      for (let s = 0; s < sel.length; s++) selSet.add(sel[s]);

      const total = sortEntities(world, view, alpha);
      for (let s = 0; s < total; s++) {
        const i = sortedIdx[s];
        drawEntity(c, world, view, i, drawStatus[i]);
      }
      for (let s = 0; s < total; s++) {
        drawBars(c, world, view, sortedIdx[s]);
      }

      terrain!.drawFog(c, world, view);
      drawPointerFeedback(c, world, view);
    },
    renderMinimap(world: World, view: ViewState, mmCtx: CanvasRenderingContext2D): void {
      drawMinimap(world, view, mmCtx);
    },
    dispose(): void {
      clearSpriteCache();
      terrain = null;
      terrainMapSize = -1;
      ctx = null;
      canvas = null;
    },
  };
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
