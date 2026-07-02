// src/render/sprites.ts
// T7 renderer — procedural sprite atlas. NO art assets: every sprite is drawn with
// primitive Canvas2D calls into an offscreen canvas, pre-rasterized ONCE per
// (kind, subtype, owner, variant) and memoized. Buildings are sized to their footprint,
// which is passed through `variant` (packed sizeX/sizeY) so the renderer never needs the
// content stat tables (see review requiredChanges #3 — renderer stays content-free).
//
// Imports: shared only. This module also owns the offscreen-canvas factory used by the
// other render modules (terrain chunks / fog) so it can be swapped for a fake in tests
// (jsdom has no real 2D backend).

import { EntityKind, ProjectileType, UnitType, BuildingType } from '../shared/enums';

export type OffCanvas = HTMLCanvasElement | OffscreenCanvas;

export interface Sprite {
  canvas: OffCanvas;
  anchorX: number; // sprite-pixel x that lines up with the entity's projected world position
  anchorY: number; // sprite-pixel y that lines up with the entity's projected world position
}

/** Player colours indexed by PlayerId: 0 = Gaia, 1..3 = players. */
export const PLAYER_COLORS: readonly string[] = ['#7b7f86', '#2f6fde', '#c93f3a', '#3d9a52'];

// ---------------------------------------------------------------------------
// Offscreen canvas factory (overridable for headless/jsdom tests).
// ---------------------------------------------------------------------------

export type CanvasFactory = (width: number, height: number) => OffCanvas;

function defaultCanvasFactory(width: number, height: number): OffCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }
  throw new Error('render: no canvas backend available; call setCanvasFactory() in a headless environment');
}

let canvasFactory: CanvasFactory = defaultCanvasFactory;

/** Test hook: install a fake offscreen-canvas factory (or pass null to restore the default). */
export function setCanvasFactory(factory: CanvasFactory | null): void {
  canvasFactory = factory ?? defaultCanvasFactory;
}

/** Create an offscreen drawing surface (min 1x1). */
export function createOffscreenCanvas(width: number, height: number): OffCanvas {
  return canvasFactory(Math.max(1, width | 0), Math.max(1, height | 0));
}

/** Fetch a 2D context, throwing a clear error when the backend has none. */
export function get2d(c: OffCanvas): CanvasRenderingContext2D {
  const ctx = (c as HTMLCanvasElement).getContext('2d');
  if (!ctx) throw new Error('render: 2d context unavailable on offscreen canvas');
  return ctx as unknown as CanvasRenderingContext2D;
}

// ---------------------------------------------------------------------------
// Sprite key packing. Reversible so getSprite() can rasterize from the key alone.
//   bits 20-23 kind | 12-19 subtype | 8-11 owner | 0-7 variant
// For buildings, variant packs the footprint: (sizeX << 4) | sizeY.
// ---------------------------------------------------------------------------

export function spriteKey(kind: number, subtype: number, owner: number, variant: number): number {
  return (((kind & 0xf) << 20) | ((subtype & 0xff) << 12) | ((owner & 0xf) << 8) | (variant & 0xff)) >>> 0;
}
function keyKind(key: number): number { return (key >>> 20) & 0xf; }
function keySubtype(key: number): number { return (key >>> 12) & 0xff; }
function keyOwner(key: number): number { return (key >>> 8) & 0xf; }
function keyVariant(key: number): number { return key & 0xff; }

// ---------------------------------------------------------------------------
// Colour helpers.
// ---------------------------------------------------------------------------

function clampByte(n: number): number { return n < 0 ? 0 : n > 255 ? 255 : n | 0; }

function parseHex(hex: string): [number, number, number] {
  let h = hex.charAt(0) === '#' ? hex.slice(1) : hex;
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgb(r: number, g: number, b: number): string { return `rgb(${clampByte(r)},${clampByte(g)},${clampByte(b)})`; }
/** Multiply a hex colour's channels by `f` (>1 lightens, <1 darkens). */
function shade(hex: string, f: number): string {
  const [r, g, b] = parseHex(hex);
  return rgb(r * f, g * f, b * f);
}

// ---------------------------------------------------------------------------
// Sprite cache.
// ---------------------------------------------------------------------------

const cache = new Map<number, Sprite>();

/** Lazily pre-rasterize (and memoize) the procedural sprite for a packed key. */
export function getSprite(key: number): Sprite {
  const hit = cache.get(key);
  if (hit) return hit;
  const spr = rasterize(key);
  cache.set(key, spr);
  return spr;
}

/** Test hook: current number of memoized sprites. */
export function getSpriteCacheSize(): number { return cache.size; }

/** Drop every memoized sprite (called by renderer.dispose()). */
export function clearSpriteCache(): void { cache.clear(); }

// ---------------------------------------------------------------------------
// Rasterization dispatch.
// ---------------------------------------------------------------------------

function rasterize(key: number): Sprite {
  const kind = keyKind(key);
  const subtype = keySubtype(key);
  const owner = keyOwner(key);
  const variant = keyVariant(key);
  if (kind === EntityKind.Building) return rasterizeBuilding(subtype, owner, variant);
  if (kind === EntityKind.Projectile) return rasterizeProjectile(subtype);
  return rasterizeUnit(subtype, owner);
}

// ---- Units -----------------------------------------------------------------

const UNIT_W = 56;
const UNIT_H = 66;
const UNIT_AX = 28; // horizontal centre
const UNIT_AY = 50; // ground-contact y

function isInfantry(t: number): boolean {
  return t === UnitType.Militia || t === UnitType.ManAtArms || t === UnitType.Spearman || t === UnitType.ThrowingAxeman;
}
function isArcher(t: number): boolean { return t === UnitType.Archer || t === UnitType.Longbowman; }
function isCavalry(t: number): boolean {
  return t === UnitType.ScoutCavalry || t === UnitType.Knight || t === UnitType.Mangudai;
}

function rasterizeUnit(subtype: number, owner: number): Sprite {
  const canvas = createOffscreenCanvas(UNIT_W, UNIT_H);
  const ctx = get2d(canvas);
  const color = PLAYER_COLORS[owner] ?? PLAYER_COLORS[0];
  ctx.clearRect(0, 0, UNIT_W, UNIT_H);

  // Ground shadow.
  ctx.fillStyle = 'rgba(0,0,0,0.26)';
  ellipse(ctx, UNIT_AX, UNIT_AY, isCavalry(subtype) ? 19 : 13, isCavalry(subtype) ? 6 : 5);
  ctx.fill();

  if (subtype === UnitType.Sheep) { drawSheep(ctx); return { canvas, anchorX: UNIT_AX, anchorY: UNIT_AY }; }

  const body = color;
  const dark = shade(color, 0.62);
  const light = shade(color, 1.2);
  const steel = '#c7ccd1';
  const steelDark = '#7e8790';
  const wood = '#76542e';

  if (isCavalry(subtype)) {
    drawHorse(ctx, body, dark, light, subtype);
  } else {
    drawFoot(ctx, body, dark, light, subtype);
  }

  // Class-specific weapon glyphs.
  if (subtype === UnitType.Spearman) {
    ctx.strokeStyle = wood; ctx.lineWidth = 2;
    line(ctx, 42, 8, 31, 47);
    ctx.fillStyle = steel;
    tri(ctx, 43, 5, 47, 13, 39, 11);
  } else if (subtype === UnitType.Militia || subtype === UnitType.ManAtArms) {
    ctx.strokeStyle = steel; ctx.lineWidth = subtype === UnitType.ManAtArms ? 3 : 2;
    line(ctx, 39, 41, 48, 18);
    ctx.strokeStyle = steelDark; ctx.lineWidth = 1;
    line(ctx, 38, 41, 45, 20);
    ctx.strokeStyle = '#5a3d1e'; ctx.lineWidth = 2;
    line(ctx, 36, 41, 41, 37);
  } else if (subtype === UnitType.ThrowingAxeman) {
    ctx.strokeStyle = wood; ctx.lineWidth = 2; line(ctx, 40, 39, 47, 22);
    ctx.fillStyle = steel;
    ctx.beginPath(); ctx.arc(48, 21, 5, -0.9, 1.8); ctx.stroke();
    tri(ctx, 47, 16, 55, 20, 47, 25);
  } else if (isArcher(subtype)) {
    ctx.strokeStyle = wood; ctx.lineWidth = 2;
    const r = subtype === UnitType.Longbowman ? 19 : 15;
    ctx.beginPath(); ctx.arc(39, 31, r, -1.2, 1.2); ctx.stroke();
    ctx.strokeStyle = '#efe7d4'; ctx.lineWidth = 1;
    line(ctx, 39 + Math.cos(-1.2) * r, 31 + Math.sin(-1.2) * r, 39 + Math.cos(1.2) * r, 31 + Math.sin(1.2) * r);
    ctx.strokeStyle = steelDark;
    line(ctx, 23, 32, 51, 25);
  } else if (subtype === UnitType.Knight) {
    ctx.strokeStyle = steel; ctx.lineWidth = 2; line(ctx, 46, 7, 46, 37);
    ctx.fillStyle = color;
    tri(ctx, 46, 11, 55, 17, 46, 25);
  } else if (subtype === UnitType.Mangudai) {
    ctx.strokeStyle = wood; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(45, 29, 13, -1.1, 1.1); ctx.stroke();
    ctx.strokeStyle = steelDark; ctx.lineWidth = 1;
    line(ctx, 31, 31, 54, 24);
  } else if (subtype === UnitType.Villager) {
    ctx.strokeStyle = wood; ctx.lineWidth = 2; line(ctx, 40, 40, 47, 22);
    ctx.fillStyle = steel; ctx.fillRect(44, 19, 10, 4);
  }

  return { canvas, anchorX: UNIT_AX, anchorY: UNIT_AY };
}

function drawFoot(ctx: CanvasRenderingContext2D, body: string, dark: string, light: string, subtype: number): void {
  const villager = subtype === UnitType.Villager;
  const topY = villager ? 23 : 18;
  const w = villager ? 15 : 17;
  const skin = '#e1bd8b';
  const boot = '#2c2722';

  ctx.fillStyle = shade(body, 0.48);
  ellipse(ctx, UNIT_AX - 1, topY + 22, w * 0.62, 10);
  ctx.fill();

  ctx.fillStyle = dark;
  ctx.fillRect(UNIT_AX - 7, 42, 5, 9);
  ctx.fillRect(UNIT_AX + 2, 42, 5, 9);
  ctx.fillStyle = boot;
  ctx.fillRect(UNIT_AX - 9, 50, 8, 3);
  ctx.fillRect(UNIT_AX + 1, 50, 8, 3);

  ctx.fillStyle = body;
  roundBody(ctx, UNIT_AX - w / 2, topY + 8, w, 24);
  ctx.fillStyle = light;
  ctx.fillRect(UNIT_AX - w / 2 + 1, topY + 9, w - 2, 4);

  ctx.strokeStyle = skin; ctx.lineWidth = 3;
  line(ctx, UNIT_AX - 7, topY + 18, UNIT_AX - 14, topY + 29);
  line(ctx, UNIT_AX + 7, topY + 18, UNIT_AX + 15, topY + 28);

  if (isInfantry(subtype)) {
    ctx.fillStyle = shade(body, 0.7);
    ellipse(ctx, UNIT_AX - 12, topY + 23, 6, 9);
    ctx.fill();
    ctx.strokeStyle = shade(body, 0.35); ctx.lineWidth = 1;
    ctx.stroke();
  } else if (isArcher(subtype)) {
    ctx.strokeStyle = '#5f4120'; ctx.lineWidth = 2;
    line(ctx, UNIT_AX - 10, topY + 11, UNIT_AX - 3, topY + 28);
  } else if (villager) {
    ctx.fillStyle = '#8b6b3e';
    ctx.fillRect(UNIT_AX - 11, topY + 29, 7, 7);
    ctx.fillStyle = '#c7a66f';
    ctx.fillRect(UNIT_AX - 10, topY + 30, 5, 2);
  }

  ctx.fillStyle = skin;
  ctx.beginPath(); ctx.arc(UNIT_AX, topY, 5.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = villager ? '#7d5b32' : '#6b6f74';
  ctx.fillRect(UNIT_AX - 7, topY - 7, 14, 4);
  if (!villager) {
    ctx.fillStyle = '#4d5358';
    ctx.fillRect(UNIT_AX - 5, topY - 10, 10, 3);
  }
}

function drawHorse(ctx: CanvasRenderingContext2D, body: string, dark: string, light: string, subtype: number): void {
  const horse = subtype === UnitType.Knight ? '#8b6b4a' : '#6f5136';
  const horseDark = '#3d2b1e';
  // legs
  ctx.fillStyle = horseDark;
  ctx.fillRect(12, 38, 4, 13);
  ctx.fillRect(21, 39, 4, 12);
  ctx.fillRect(33, 39, 4, 12);
  ctx.fillRect(43, 38, 4, 13);
  // body
  ctx.fillStyle = horse;
  ellipse(ctx, 29, 36, 22, 10);
  ctx.fill();
  ctx.fillStyle = '#c7b08a';
  ellipse(ctx, 25, 33, 12, 4);
  ctx.fill();
  // neck + head
  ctx.fillStyle = horseDark;
  ctx.beginPath();
  ctx.moveTo(43, 34); ctx.lineTo(50, 18); ctx.lineTo(55, 21); ctx.lineTo(47, 37); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#141414';
  ctx.fillRect(51, 21, 2, 2);
  // rider
  ctx.fillStyle = subtype === UnitType.Knight ? '#c9ced4' : body;
  roundBody(ctx, 24, 17, 11, 17);
  ctx.fillStyle = light;
  ctx.fillRect(24, 19, 11, 4);
  ctx.fillStyle = '#e3c39b';
  ctx.beginPath(); ctx.arc(30, 14, 4.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = subtype === UnitType.Knight ? '#9aa0a6' : dark;
  ctx.fillRect(24, 8, 12, 4);
}

function drawSheep(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#f2efe6';
  ellipse(ctx, 27, 41, 14, 8);
  ctx.fill();
  // fluff bumps
  ctx.beginPath();
  ctx.arc(17, 40, 5, 0, Math.PI * 2);
  ctx.arc(24, 36, 5.5, 0, Math.PI * 2);
  ctx.arc(32, 37, 5, 0, Math.PI * 2);
  ctx.arc(38, 41, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#3b3029';
  ctx.fillRect(18, 48, 2, 5);
  ctx.fillRect(35, 48, 2, 5);
  // head
  ctx.fillStyle = '#34302e';
  ctx.beginPath(); ctx.arc(42, 41, 4.5, 0, Math.PI * 2); ctx.fill();
}

function roundBody(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  // rounded-ish torso built from a rect + top/bottom arcs (no quadraticCurveTo needed)
  ctx.beginPath();
  ctx.moveTo(x, y + 3);
  ctx.lineTo(x, y + h - 3);
  ctx.arc(x + w / 2, y + h - 3, w / 2, Math.PI, 0, true);
  ctx.lineTo(x + w, y + 3);
  ctx.arc(x + w / 2, y + 3, w / 2, 0, Math.PI, true);
  ctx.closePath();
  ctx.fill();
}

// ---- Projectiles ------------------------------------------------------------

const PROJ = 16;

function rasterizeProjectile(subtype: number): Sprite {
  const canvas = createOffscreenCanvas(PROJ, PROJ);
  const ctx = get2d(canvas);
  ctx.clearRect(0, 0, PROJ, PROJ);
  if (subtype === ProjectileType.Axe) {
    ctx.strokeStyle = '#7a5a30'; ctx.lineWidth = 2; line(ctx, 3, 13, 12, 4);
    ctx.fillStyle = '#c7ccd1';
    ctx.beginPath(); ctx.moveTo(12, 4); ctx.lineTo(15, 3); ctx.lineTo(13, 8); ctx.closePath(); ctx.fill();
  } else {
    // arrow: a short line with a head
    ctx.strokeStyle = '#3a2a16'; ctx.lineWidth = 2; line(ctx, 3, 13, 12, 4);
    ctx.fillStyle = '#e8e2d0';
    ctx.beginPath(); ctx.moveTo(12, 4); ctx.lineTo(9, 5); ctx.lineTo(11, 8); ctx.closePath(); ctx.fill();
  }
  return { canvas, anchorX: PROJ / 2, anchorY: PROJ / 2 };
}

// ---- Buildings --------------------------------------------------------------

const TILE_W = 64; // must match shared/constants; buildings drawn in unscaled iso pixels
const TILE_H = 32;

function wallHeightFor(subtype: number, sizeX: number, sizeY: number): number {
  switch (subtype) {
    case BuildingType.Farm: return 2;
    case BuildingType.House: return 28;
    case BuildingType.Mill:
    case BuildingType.LumberCamp:
    case BuildingType.MiningCamp: return 22;
    case BuildingType.Barracks:
    case BuildingType.ArcheryRange:
    case BuildingType.Stable:
    case BuildingType.Blacksmith: return 30;
    case BuildingType.TownCenter: return 54;
    case BuildingType.Castle: return 66;
    default: return 24 + (sizeX + sizeY) * 2;
  }
}

// Purely cosmetic wall tints per building type (NOT content stats).
function wallTint(subtype: number): string {
  switch (subtype) {
    case BuildingType.Barracks: return '#b08a6a';
    case BuildingType.ArcheryRange: return '#c2a877';
    case BuildingType.Stable: return '#a88a5a';
    case BuildingType.Blacksmith: return '#9aa0a6';
    case BuildingType.Castle: return '#8f9399';
    case BuildingType.TownCenter: return '#cbb890';
    case BuildingType.Mill: return '#c7a77a';
    case BuildingType.LumberCamp: return '#b48b5d';
    case BuildingType.MiningCamp: return '#a99d88';
    default: return '#c9b48a';
  }
}

function rasterizeBuilding(subtype: number, owner: number, variant: number): Sprite {
  let sizeX = (variant >> 4) & 0xf;
  let sizeY = variant & 0xf;
  if (sizeX < 1) sizeX = 1;
  if (sizeY < 1) sizeY = 1;

  const Wd = (sizeX + sizeY) * (TILE_W / 2); // ground diamond width
  const Hd = (sizeX + sizeY) * (TILE_H / 2); // ground diamond height
  const wallH = wallHeightFor(subtype, sizeX, sizeY);
  const pad = 8;
  const topPad = subtype === BuildingType.TownCenter ? 30 : subtype === BuildingType.House ? 14 : 10;
  const W = Math.max(1, Wd + pad * 2);
  const H = Math.max(1, topPad + wallH + Hd + pad);
  const canvas = createOffscreenCanvas(W, H);
  const ctx = get2d(canvas);
  ctx.clearRect(0, 0, W, H);

  const gcx = W / 2;        // ground-centre x
  const gcy = topPad + wallH + Hd / 2; // ground-centre y (== anchorY)

  // Ground diamond corners.
  const gTop = [gcx, gcy - Hd / 2] as const;
  const gRight = [gcx + Wd / 2, gcy] as const;
  const gBot = [gcx, gcy + Hd / 2] as const;
  const gLeft = [gcx - Wd / 2, gcy] as const;

  const roofColor = PLAYER_COLORS[owner] ?? PLAYER_COLORS[0];

  if (subtype === BuildingType.Farm) {
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    diamond(ctx, [gTop[0], gTop[1] + 3], [gRight[0], gRight[1] + 3], [gBot[0], gBot[1] + 3], [gLeft[0], gLeft[1] + 3]); ctx.fill();
    ctx.fillStyle = '#8f6a3a';
    diamond(ctx, gTop, gRight, gBot, gLeft); ctx.fill();
    ctx.strokeStyle = '#6c4e2c'; ctx.lineWidth = 1;
    for (let k = 1; k < sizeX + sizeY; k++) {
      const t = k / (sizeX + sizeY);
      line(ctx, gLeft[0] + (gTop[0] - gLeft[0]) * t, gLeft[1] + (gTop[1] - gLeft[1]) * t,
        gBot[0] + (gRight[0] - gBot[0]) * t, gBot[1] + (gRight[1] - gBot[1]) * t);
    }
    ctx.strokeStyle = '#a87c44';
    for (let k = 1; k < sizeX + sizeY; k += 2) {
      const t = k / (sizeX + sizeY);
      line(ctx, gTop[0] + (gRight[0] - gTop[0]) * t, gTop[1] + (gRight[1] - gTop[1]) * t,
        gLeft[0] + (gBot[0] - gLeft[0]) * t, gLeft[1] + (gBot[1] - gLeft[1]) * t);
    }
    ctx.fillStyle = shade(roofColor, 1.08);
    diamond(ctx, [gTop[0], gTop[1] + 2], [gTop[0] + 8, gTop[1] + 6], [gTop[0], gTop[1] + 10], [gTop[0] - 8, gTop[1] + 6]); ctx.fill();
    return { canvas, anchorX: gcx, anchorY: gcy };
  }

  const wall = wallTint(subtype);
  const wallDark = shade(wall, 0.72);
  const wallLight = shade(wall, 0.92);

  // Roof-level corners (ground corners lifted by wallH).
  const rTop = [gTop[0], gTop[1] - wallH] as const;
  const rRight = [gRight[0], gRight[1] - wallH] as const;
  const rBot = [gBot[0], gBot[1] - wallH] as const;
  const rLeft = [gLeft[0], gLeft[1] - wallH] as const;

  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  diamond(ctx, [gTop[0], gTop[1] + 4], [gRight[0], gRight[1] + 4], [gBot[0], gBot[1] + 4], [gLeft[0], gLeft[1] + 4]); ctx.fill();

  // Front-left wall (south-west face): darker.
  ctx.fillStyle = wallDark;
  quad(ctx, gLeft, gBot, rBot, rLeft); ctx.fill();
  // Front-right wall (south-east face): lighter.
  ctx.fillStyle = wallLight;
  quad(ctx, gBot, gRight, rRight, rBot); ctx.fill();

  drawPitchedRoof(ctx, roofColor, subtype, rTop, rRight, rBot, rLeft, wallH);

  addBuildingDetails(ctx, subtype, roofColor, wall, wallH, gcx, gcy, gTop, gRight, gBot, gLeft, rTop, rRight, rBot, rLeft);

  // A door hint on the front-right face for larger buildings.
  if (sizeX + sizeY >= 4 && subtype !== BuildingType.Castle) {
    ctx.fillStyle = '#4a3a24';
    const dx = (gBot[0] + gRight[0]) / 2;
    const dyTop = (gBot[1] + gRight[1]) / 2 - wallH * 0.6;
    ctx.fillRect(dx - 3, dyTop, 6, wallH * 0.5);
  }
  // Castle crenellations.
  if (subtype === BuildingType.Castle) {
    ctx.fillStyle = shade(roofColor, 0.8);
    for (let k = 0; k < 4; k++) {
      const t = 0.15 + k * 0.23;
      const cxp = rLeft[0] + (rRight[0] - rLeft[0]) * t;
      const cyp = rLeft[1] + (rRight[1] - rLeft[1]) * t;
      ctx.fillRect(cxp - 2, cyp - 6, 4, 6);
    }
  }

  return { canvas, anchorX: gcx, anchorY: gcy };
}

function addBuildingDetails(
  ctx: CanvasRenderingContext2D,
  subtype: number,
  roofColor: string,
  wall: string,
  wallH: number,
  gcx: number,
  gcy: number,
  gTop: readonly number[],
  gRight: readonly number[],
  gBot: readonly number[],
  gLeft: readonly number[],
  rTop: readonly number[],
  rRight: readonly number[],
  rBot: readonly number[],
  rLeft: readonly number[],
): void {
  const darkWood = '#4d3420';
  const trim = shade(wall, 0.55);
  ctx.strokeStyle = trim;
  ctx.lineWidth = 1;
  line(ctx, gLeft[0], gLeft[1], gBot[0], gBot[1]);
  line(ctx, gBot[0], gBot[1], gRight[0], gRight[1]);

  if (subtype === BuildingType.House) {
    ctx.strokeStyle = '#6b5130'; ctx.lineWidth = 2;
    line(ctx, gLeft[0] + 7, gLeft[1] - wallH * 0.35, gBot[0] - 6, gBot[1] - wallH * 0.12);
    line(ctx, gRight[0] - 7, gRight[1] - wallH * 0.35, gBot[0] + 6, gBot[1] - wallH * 0.12);
    ctx.fillStyle = darkWood;
    ctx.fillRect(gcx - 7, gcy - wallH * 0.52, 14, wallH * 0.52);
    ctx.fillStyle = '#2f2115';
    ctx.fillRect(gcx - 4, gcy - wallH * 0.38, 8, wallH * 0.38);
    ctx.fillStyle = '#f0d48a';
    ctx.fillRect(gcx + 13, gcy - wallH * 0.62, 6, 5);
    ctx.fillRect(gcx - 19, gcy - wallH * 0.5, 5, 4);
    ctx.fillStyle = '#5a3b22';
    ctx.fillRect(gcx - 17, rTop[1] - 8, 5, 12);
    ctx.fillStyle = '#3d2a1a';
    ctx.fillRect(gcx - 18, rTop[1] - 10, 7, 3);
    ctx.strokeStyle = shade(roofColor, 0.55); ctx.lineWidth = 1;
    line(ctx, rTop[0] - 10, rTop[1] + 8, rBot[0] - 17, rBot[1] - 1);
    line(ctx, rTop[0] + 10, rTop[1] + 8, rBot[0] + 17, rBot[1] - 1);
    return;
  }

  if (subtype === BuildingType.Mill) {
    ctx.strokeStyle = '#ede2bf'; ctx.lineWidth = 2;
    line(ctx, gcx, rTop[1] + 2, gcx, rTop[1] + 28);
    line(ctx, gcx - 13, rTop[1] + 15, gcx + 13, rTop[1] + 15);
    ctx.fillStyle = '#ede2bf';
    ctx.fillRect(gcx - 2, rTop[1] + 13, 4, 4);
    return;
  }

  if (subtype === BuildingType.LumberCamp) {
    ctx.strokeStyle = '#6f4b28'; ctx.lineWidth = 3;
    for (let k = 0; k < 4; k++) line(ctx, gLeft[0] + 10 + k * 7, gcy - 6, gLeft[0] + 20 + k * 7, gcy - 1);
    return;
  }

  if (subtype === BuildingType.MiningCamp || subtype === BuildingType.Blacksmith) {
    ctx.fillStyle = subtype === BuildingType.Blacksmith ? '#2b2c2d' : '#6c6658';
    ctx.fillRect(gcx + 10, gcy - wallH * 0.75, 8, 16);
    ctx.fillStyle = '#d86f2a';
    ctx.fillRect(gcx + 12, gcy - wallH * 0.72, 4, 4);
    return;
  }

  if (subtype === BuildingType.Barracks) {
    ctx.fillStyle = darkWood;
    ctx.fillRect(gcx - 16, gcy - wallH * 0.45, 8, wallH * 0.45);
    ctx.fillRect(gcx + 8, gcy - wallH * 0.45, 8, wallH * 0.45);
    ctx.strokeStyle = '#c7ccd1'; ctx.lineWidth = 2;
    line(ctx, gcx - 22, gcy - wallH + 4, gcx - 22, gcy - wallH + 20);
    line(ctx, gcx + 22, gcy - wallH + 4, gcx + 22, gcy - wallH + 20);
    return;
  }

  if (subtype === BuildingType.ArcheryRange) {
    ctx.strokeStyle = '#5f4120'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(gcx + 12, gcy - wallH * 0.45, 10, -1.15, 1.15); ctx.stroke();
    line(ctx, gcx - 18, gcy - wallH * 0.3, gcx + 18, gcy - wallH * 0.5);
    return;
  }

  if (subtype === BuildingType.Stable) {
    ctx.fillStyle = '#5d3b22';
    ctx.fillRect(gcx - 14, gcy - wallH * 0.45, 28, wallH * 0.45);
    ctx.strokeStyle = '#d4b082'; ctx.lineWidth = 1;
    line(ctx, gcx, gcy - wallH * 0.45, gcx, gcy);
    return;
  }

  if (subtype === BuildingType.TownCenter) {
    ctx.fillStyle = darkWood;
    ctx.fillRect(gcx - 11, gcy - wallH * 0.46, 22, wallH * 0.46);
    ctx.fillStyle = '#2e2114';
    ctx.fillRect(gcx - 7, gcy - wallH * 0.36, 14, wallH * 0.36);
    ctx.fillStyle = '#f0d48a';
    ctx.fillRect(gcx - 30, gcy - wallH * 0.6, 7, 6);
    ctx.fillRect(gcx + 23, gcy - wallH * 0.6, 7, 6);
    ctx.fillRect(gcx - 4, gcy - wallH * 0.74, 8, 5);
    ctx.strokeStyle = '#7b5f38'; ctx.lineWidth = 3;
    line(ctx, gLeft[0] + 10, gLeft[1] - wallH * 0.2, gLeft[0] + 28, gLeft[1] - wallH * 0.08);
    line(ctx, gRight[0] - 10, gRight[1] - wallH * 0.2, gRight[0] - 28, gRight[1] - wallH * 0.08);
    return;
  }

  if (subtype === BuildingType.Castle) {
    ctx.fillStyle = shade(wall, 0.82);
    const towerY = rTop[1] + 6;
    ctx.fillRect(rLeft[0] + 8, towerY, 10, wallH * 0.52);
    ctx.fillRect(rRight[0] - 18, towerY, 10, wallH * 0.52);
    ctx.fillStyle = darkWood;
    ctx.fillRect(gcx - 8, gcy - wallH * 0.42, 16, wallH * 0.42);
    ctx.strokeStyle = '#5f646b'; ctx.lineWidth = 2;
    line(ctx, gTop[0], gTop[1] - wallH * 0.75, gTop[0], gTop[1] - wallH * 1.05);
  }
}

function drawPitchedRoof(
  ctx: CanvasRenderingContext2D,
  roofColor: string,
  subtype: number,
  rTop: readonly number[],
  rRight: readonly number[],
  rBot: readonly number[],
  rLeft: readonly number[],
  wallH: number,
): void {
  const overhang = subtype === BuildingType.Castle ? 0 : subtype === BuildingType.TownCenter ? 2 : 4;
  if (overhang > 0) {
    ctx.fillStyle = shade(roofColor, 0.62);
    diamond(
      ctx,
      [rTop[0], rTop[1] + 2],
      [rRight[0] + overhang, rRight[1] + 2],
      [rBot[0], rBot[1] + 3],
      [rLeft[0] - overhang, rLeft[1] + 2],
    );
    ctx.fill();
  }

  ctx.fillStyle = shade(roofColor, subtype === BuildingType.Castle ? 0.72 : 0.9);
  ctx.beginPath();
  ctx.moveTo(rTop[0], rTop[1]);
  ctx.lineTo(rLeft[0], rLeft[1]);
  ctx.lineTo(rBot[0], rBot[1]);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = shade(roofColor, subtype === BuildingType.Castle ? 0.82 : 1.08);
  ctx.beginPath();
  ctx.moveTo(rTop[0], rTop[1]);
  ctx.lineTo(rRight[0], rRight[1]);
  ctx.lineTo(rBot[0], rBot[1]);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = shade(roofColor, 1.28); ctx.lineWidth = 1;
  line(ctx, rTop[0], rTop[1], rBot[0], rBot[1]);
  ctx.strokeStyle = shade(roofColor, 0.62);
  line(ctx, rLeft[0], rLeft[1], rRight[0], rRight[1]);

  if (subtype !== BuildingType.Castle) {
    ctx.strokeStyle = shade(roofColor, 0.68);
    const ribs = Math.max(2, Math.min(5, Math.round(wallH / 10)));
    for (let k = 1; k <= ribs; k++) {
      const t = k / (ribs + 1);
      line(
        ctx,
        rTop[0] + (rLeft[0] - rTop[0]) * t,
        rTop[1] + (rLeft[1] - rTop[1]) * t,
        rBot[0] + (rLeft[0] - rBot[0]) * t * 0.45,
        rBot[1] + (rLeft[1] - rBot[1]) * t * 0.45,
      );
      line(
        ctx,
        rTop[0] + (rRight[0] - rTop[0]) * t,
        rTop[1] + (rRight[1] - rTop[1]) * t,
        rBot[0] + (rRight[0] - rBot[0]) * t * 0.45,
        rBot[1] + (rRight[1] - rBot[1]) * t * 0.45,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Small primitive helpers.
// ---------------------------------------------------------------------------

function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
}
function ellipse(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number): void {
  ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
}
function diamond(ctx: CanvasRenderingContext2D, t: readonly number[], r: readonly number[], b: readonly number[], l: readonly number[]): void {
  ctx.beginPath();
  ctx.moveTo(t[0], t[1]); ctx.lineTo(r[0], r[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(l[0], l[1]); ctx.closePath();
}
function quad(ctx: CanvasRenderingContext2D, a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[]): void {
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(c[0], c[1]); ctx.lineTo(d[0], d[1]); ctx.closePath();
}
function tri(ctx: CanvasRenderingContext2D, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): void {
  ctx.beginPath();
  ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(cx, cy); ctx.closePath(); ctx.fill();
}
