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
// FX sprite namespace. The 4-bit sprite-key `kind` field only uses 0..2 for real
// entities (Unit/Building/Projectile); FX reuse the same memo cache under kind 3.
// `variant` selects the animation frame (and, for RallyFlag, `owner` tints it).
// ---------------------------------------------------------------------------

export const SPRITE_KIND_FX = 3;
export const FxSprite = { DustPuff: 0, HitSpark: 1, SmokePuff: 2, RallyFlag: 3, WaterShimmer: 4 } as const;

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
// Shared "AoE II miniature" material palette. Neutral gambeson/leather/steel
// bodies lit from the TOP-RIGHT (matching the buildings' bright SE face); player
// colour is reserved for heraldry so armies read as soldiers, not colour blobs.
// ---------------------------------------------------------------------------

const STEEL_LIGHT = '#dfe4e9';
const STEEL = '#c7ccd1';
const STEEL_DARK = '#7e8790';
const LEATHER = '#8b6b4a';
const LEATHER_DARK = '#5a4632';
const WOOD = '#76542e';
const CLOTH = '#b8ad98';
const GAMBESON = '#b8a888';
const SKIN = '#e1bd8b';
const SKIN_SHADE = '#c49f70';
const HAIR = '#7d5b32';
const BOOT = '#2c2722';
const KEYLINE = 'rgba(24,18,12,0.5)';

/** Re-stroke the current path as a 1px dark keyline — the outline that keeps a
 *  28px-tall figure readable at zoom 0.5. Call immediately after filling a mass. */
function keyline(ctx: CanvasRenderingContext2D): void {
  ctx.strokeStyle = KEYLINE;
  ctx.lineWidth = 1;
  ctx.stroke();
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
  if (kind === SPRITE_KIND_FX) return rasterizeFx(subtype, owner, variant);
  // Units: variant bit 0 = mirrored (west-facing). variant 0 stays the default
  // east-facing sprite (portraits rely on this — see spec §3.2).
  if (variant & 1) return rasterizeMirroredUnit(subtype, owner);
  return rasterizeUnit(subtype, owner);
}

/** West-facing unit: rasterize the default east sprite, then blit it horizontally flipped. */
function rasterizeMirroredUnit(subtype: number, owner: number): Sprite {
  const base = getSprite(spriteKey(EntityKind.Unit, subtype, owner, 0));
  const bw = base.canvas.width;
  const bh = base.canvas.height;
  const canvas = createOffscreenCanvas(bw, bh);
  const ctx = get2d(canvas);
  ctx.clearRect(0, 0, bw, bh);
  ctx.save();
  ctx.translate(bw, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(base.canvas, 0, 0);
  ctx.restore();
  return { canvas, anchorX: bw - base.anchorX, anchorY: base.anchorY };
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

  const cav = isCavalry(subtype);

  // Soft radial ground shadow (a real falloff, not two flat ellipses) so the
  // figure sits on the terrain instead of floating on a hard disc.
  const shR = cav ? 18 : 11;
  const shRy = cav ? 6 : 4.5;
  const gshadow = ctx.createRadialGradient(UNIT_AX, UNIT_AY, 2, UNIT_AX, UNIT_AY, shR + 2);
  gshadow.addColorStop(0, 'rgba(0,0,0,0.30)');
  gshadow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gshadow;
  ellipse(ctx, UNIT_AX, UNIT_AY, shR + 2, shRy + 2);
  ctx.fill();

  if (subtype === UnitType.Sheep) {
    drawSheep(ctx);
    return { canvas, anchorX: UNIT_AX, anchorY: UNIT_AY };
  }

  if (cav) drawHorse(ctx, color, subtype);
  else drawFoot(ctx, color, subtype);

  drawWeapon(ctx, color, subtype);

  return { canvas, anchorX: UNIT_AX, anchorY: UNIT_AY };
}

// Per-class weapon glyph, drawn last so it reads on top of the figure. Distinct
// silhouette per class is the fastest friend/foe + role read at zoom 0.5.
function drawWeapon(ctx: CanvasRenderingContext2D, color: string, subtype: number): void {
  if (subtype === UnitType.Spearman) {
    // Longest, steepest weapon in the roster — the instant spearman read.
    ctx.strokeStyle = WOOD; ctx.lineWidth = 2; line(ctx, 44, 4, 30, 48);
    ctx.strokeStyle = shade(WOOD, 1.25); ctx.lineWidth = 1; line(ctx, 45, 5, 31, 48);
    ctx.fillStyle = STEEL; tri(ctx, 45, 2, 48, 10, 41, 8);
    ctx.strokeStyle = STEEL_LIGHT; ctx.lineWidth = 1; line(ctx, 45, 2, 48, 10);
    ctx.strokeStyle = color; ctx.lineWidth = 1;
    line(ctx, 43, 10, 39, 12); line(ctx, 43, 10, 40, 14); line(ctx, 43, 10, 44, 14);
    return;
  }
  if (subtype === UnitType.Militia) {
    ctx.strokeStyle = STEEL; ctx.lineWidth = 2; line(ctx, 38, 34, 45, 18);
    ctx.strokeStyle = STEEL_LIGHT; ctx.lineWidth = 1; line(ctx, 39, 33, 46, 18);
    ctx.strokeStyle = LEATHER_DARK; ctx.lineWidth = 2; line(ctx, 35, 32, 41, 30);
    return;
  }
  if (subtype === UnitType.ManAtArms) {
    ctx.strokeStyle = STEEL; ctx.lineWidth = 3; line(ctx, 38, 35, 46, 15);
    ctx.strokeStyle = STEEL_LIGHT; ctx.lineWidth = 1; line(ctx, 40, 34, 47, 16);
    ctx.strokeStyle = '#4a4f55'; ctx.lineWidth = 2; line(ctx, 34, 32, 41, 29);
    return;
  }
  if (subtype === UnitType.ThrowingAxeman) {
    ctx.strokeStyle = WOOD; ctx.lineWidth = 2; line(ctx, 40, 39, 47, 20);
    ctx.fillStyle = STEEL; // curved francisca bit as an arc-bounded wedge (no beziers).
    ctx.beginPath(); ctx.moveTo(46, 17); ctx.arc(49, 21, 5, -1.3, 0.9); ctx.lineTo(46, 24); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = STEEL_LIGHT; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(49, 21, 5, -1.3, 0.9); ctx.stroke();
    ctx.fillStyle = STEEL; ctx.fillRect(33, 38, 3, 2); // spare axe on the belt
    return;
  }
  if (isArcher(subtype)) {
    const longbow = subtype === UnitType.Longbowman;
    const bx = longbow ? 36 : 38, by = longbow ? 30 : 31, r = longbow ? 20 : 14;
    ctx.strokeStyle = WOOD; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(bx, by, r, -1.15, 1.15); ctx.stroke();
    ctx.strokeStyle = shade(WOOD, 1.3); ctx.lineWidth = 1; // belly highlight
    ctx.beginPath(); ctx.arc(bx, by, r, -0.85, 0.85); ctx.stroke();
    const a = 1.15;
    ctx.strokeStyle = 'rgba(239,231,212,0.9)'; ctx.lineWidth = 1;
    line(ctx, bx + Math.cos(-a) * r, by + Math.sin(-a) * r, bx + Math.cos(a) * r, by + Math.sin(a) * r);
    ctx.strokeStyle = STEEL_DARK; ctx.lineWidth = 1; line(ctx, bx - 3, by, bx + r - 1, by);
    ctx.fillStyle = STEEL_LIGHT; tri(ctx, bx + r - 1, by - 1.6, bx + r + 2, by, bx + r - 1, by + 1.6);
    return;
  }
  if (subtype === UnitType.Villager) {
    ctx.strokeStyle = WOOD; ctx.lineWidth = 2; line(ctx, 40, 40, 46, 24);
    ctx.fillStyle = STEEL; ctx.fillRect(43, 21, 8, 4);
    ctx.fillStyle = STEEL_LIGHT; ctx.fillRect(43, 21, 8, 1);
    return;
  }
  if (subtype === UnitType.Knight) {
    // Flagged lance — grandest silhouette; scout carries a bare stick instead.
    ctx.strokeStyle = STEEL; ctx.lineWidth = 2; line(ctx, 46, 7, 46, 37);
    ctx.strokeStyle = STEEL_LIGHT; ctx.lineWidth = 1; line(ctx, 47, 7, 47, 37);
    ctx.fillStyle = color; tri(ctx, 46, 10, 55, 14, 46, 19);
    ctx.fillStyle = shade(color, 0.7); tri(ctx, 46, 14, 55, 14, 46, 19);
    return;
  }
  if (subtype === UnitType.ScoutCavalry) {
    ctx.strokeStyle = WOOD; ctx.lineWidth = 2; line(ctx, 38, 6, 42, 28);
    ctx.fillStyle = STEEL; tri(ctx, 37, 3, 40, 9, 36, 8);
    return;
  }
  if (subtype === UnitType.Mangudai) {
    const bx = 43, by = 29, r = 12;
    ctx.strokeStyle = WOOD; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(bx, by, r, -1.1, 1.1); ctx.stroke();
    const a = 1.1;
    const ex0 = bx + Math.cos(-a) * r, ey0 = by + Math.sin(-a) * r;
    const ex1 = bx + Math.cos(a) * r, ey1 = by + Math.sin(a) * r;
    ctx.lineWidth = 2; // recurve kick-back at the limb tips
    line(ctx, ex0, ey0, ex0 - 2, ey0 - 1);
    line(ctx, ex1, ey1, ex1 - 2, ey1 + 1);
    ctx.strokeStyle = 'rgba(239,231,212,0.9)'; ctx.lineWidth = 1; line(ctx, ex0, ey0, ex1, ey1);
    ctx.fillStyle = LEATHER_DARK; ctx.fillRect(33, 30, 4, 9); // hip quiver
    ctx.strokeStyle = '#d9d2bd'; ctx.lineWidth = 1; line(ctx, 34, 30, 34, 26); line(ctx, 36, 30, 36, 26);
    return;
  }
}

// Paper-doll foot soldier, drawn back-to-front so the memoized atlas bakes a fully
// shaded figurine: neutral gambeson/leather/steel body + top highlight + 1px keyline,
// with player colour confined to heraldry (sash / surcoat / hood / shield / plume).
// Feet straddle x=28 and land exactly on y=50 so the anchor + walk bob stay honest.
function drawFoot(ctx: CanvasRenderingContext2D, color: string, subtype: number): void {
  const villager = subtype === UnitType.Villager;
  const axeman = subtype === UnitType.ThrowingAxeman;
  const archerCls = isArcher(subtype);
  const manAtArms = subtype === UnitType.ManAtArms;

  const topY = villager ? 23 : 18;       // head-centre y (villager stoops lower)
  const headX = villager ? 27 : 28;
  const torsoW = villager ? 15 : 17;
  const torsoTop = topY + 6;
  const torsoBot = 44;
  const torsoH = torsoBot - torsoTop;
  const half = torsoW / 2;

  // Garment palette — most bodies are neutral cloth/mail/leather; only Militia and
  // Spearman wear a player-colour tunic outright.
  let tunic: string;
  if (subtype === UnitType.Militia || subtype === UnitType.Spearman) tunic = color;
  else if (manAtArms) tunic = '#8d949c';
  else if (subtype === UnitType.Longbowman) tunic = '#e8e0cc';
  else if (subtype === UnitType.Archer) tunic = LEATHER;
  else if (axeman) tunic = GAMBESON;
  else tunic = '#a3906f';
  const tunicShade = shade(tunic, 0.68);
  const tunicHi = shade(tunic, 1.25);
  const trouser = manAtArms ? '#6a7178' : '#5b4a33';
  const bareArms = villager || axeman;
  const sleeve = bareArms ? SKIN : tunic;
  const sleeveShade = bareArms ? SKIN_SHADE : tunicShade;

  // (1) back arm.
  ctx.strokeStyle = sleeve; ctx.lineWidth = 3; line(ctx, 24, torsoTop + 3, 19, torsoTop + 15);
  ctx.strokeStyle = sleeveShade; ctx.lineWidth = 1; line(ctx, 24, torsoTop + 4, 19, torsoTop + 16);

  // (1b) archer back quiver with fletched shafts poking over the shoulder.
  if (archerCls) {
    ctx.fillStyle = LEATHER_DARK; ctx.fillRect(17, topY + 8, 5, 12);
    ctx.strokeStyle = '#d9d2bd'; ctx.lineWidth = 1;
    for (let k = 0; k < 3; k++) { const qx = 18 + k * 2; line(ctx, qx, topY + 8, qx, topY + 2); }
    ctx.fillStyle = STEEL_LIGHT;
    for (let k = 0; k < 3; k++) ctx.fillRect(18 + k * 2, topY + 1, 1, 1);
  }

  // (2) legs + boots (+ per-foot contact shadows and a body AO pool).
  ctx.fillStyle = trouser;
  ctx.fillRect(22, 40, 4, 10); ctx.fillRect(30, 40, 4, 10);
  ctx.fillStyle = shade(trouser, 1.2); ctx.fillRect(22, 40, 4, 2); ctx.fillRect(30, 40, 4, 2);
  ctx.fillStyle = BOOT; ctx.fillRect(21, 47, 6, 3); ctx.fillRect(29, 47, 6, 3);
  ctx.fillStyle = shade(BOOT, 1.7); ctx.fillRect(21, 47, 6, 1); ctx.fillRect(29, 47, 6, 1);
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ellipse(ctx, 24, 50, 3, 1.5); ctx.fill();
  ellipse(ctx, 32, 50, 3, 1.5); ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.10)';
  ellipse(ctx, 28, 46, 6, 2.5); ctx.fill();

  // (3) tunic mass + top-right highlight + lower-left core shadow + keyline.
  ctx.fillStyle = tunic;
  roundBody(ctx, 28 - half, torsoTop, torsoW, torsoH); ctx.fill(); keyline(ctx);
  ctx.fillStyle = tunicShade; ctx.fillRect(28 - half + 1, torsoTop + 5, torsoW * 0.42, torsoH - 8);
  ctx.fillStyle = tunicHi; ctx.fillRect(28 - half + 1, torsoTop + 1, torsoW - 2, 3);

  // Class torso detailing.
  if (manAtArms) {
    ctx.fillStyle = '#6a7178'; // mail stipple
    const dots = [[24, 26], [31, 27], [27, 30], [32, 33], [24, 35], [30, 38]];
    for (let k = 0; k < dots.length; k++) ctx.fillRect(dots[k][0], dots[k][1], 1, 1);
    ctx.fillStyle = color; ctx.fillRect(24, torsoTop + 1, 8, torsoH - 3); // surcoat panel
    ctx.fillStyle = shade(color, 0.7); ctx.fillRect(24, torsoTop + 1 + (torsoH - 3) / 2, 8, (torsoH - 3) / 2);
    ctx.strokeStyle = '#565d64'; ctx.lineWidth = 1; // mail-skirt courses
    for (let k = 0; k < 3; k++) line(ctx, 28 - half + 2, torsoBot - 6 + k * 2, 28 + half - 2, torsoBot - 6 + k * 2);
  } else if (subtype === UnitType.Longbowman) {
    ctx.fillStyle = color; ctx.fillRect(21, topY + 12, 15, 3); // player chest band
  }

  // (3b) villager satchel.
  if (villager) {
    ctx.fillStyle = LEATHER; ctx.fillRect(19, topY + 14, 6, 7);
    ctx.strokeStyle = LEATHER_DARK; ctx.lineWidth = 1; line(ctx, 19, topY + 16, 25, topY + 16);
  }

  // (4) belt — a player sash for the villager, plain leather otherwise.
  if (villager) {
    ctx.fillStyle = color; ctx.fillRect(21, topY + 18, 15, 3);
    ctx.fillStyle = shade(color, 1.2); ctx.fillRect(27, topY + 18, 2, 3);
  } else {
    ctx.fillStyle = '#3c2f1e'; ctx.fillRect(28 - half + 1, torsoBot - 5, torsoW - 2, 3);
    ctx.fillStyle = '#8a6a3a'; ctx.fillRect(27, torsoBot - 5, 2, 3);
  }

  // (5) front arm + hand, reaching toward the class weapon.
  let fhx = 38, fhy = torsoTop + 13;
  if (archerCls) { fhx = 36; fhy = 31; }
  else if (subtype === UnitType.Spearman) { fhx = 36; fhy = 28; }
  else if (villager) { fhx = 39; fhy = 36; }
  else if (axeman) { fhx = 39; fhy = 33; }
  ctx.strokeStyle = sleeve; ctx.lineWidth = 3; line(ctx, 32, torsoTop + 3, fhx, fhy);
  ctx.strokeStyle = sleeveShade; ctx.lineWidth = 1; line(ctx, 33, torsoTop + 4, fhx, fhy + 1);
  ctx.fillStyle = SKIN; ctx.beginPath(); ctx.arc(fhx, fhy, 1.6, 0, Math.PI * 2); ctx.fill();

  // (6) head — neck, dome, lower-left face shadow, eye dot (east sprite looks right).
  ctx.fillStyle = SKIN_SHADE; ctx.fillRect(headX - 2, topY + 3, 4, 4);
  ctx.fillStyle = SKIN; ctx.beginPath(); ctx.arc(headX, topY, 5.5, 0, Math.PI * 2); ctx.fill(); keyline(ctx);
  ctx.fillStyle = SKIN_SHADE; ctx.beginPath(); ctx.arc(headX - 1.5, topY + 1, 4, 0.5, 2.7); ctx.fill();
  ctx.fillStyle = '#2a2018'; ctx.fillRect(30, topY - 1, 1, 1);

  // (7) headgear + (8) shield.
  drawHeadgear(ctx, color, subtype, headX, topY);
  drawShield(ctx, color, subtype, topY);
}

// Distinct >= 2px headgear silhouette + hue per class (portraits blit these at ~2x).
function drawHeadgear(ctx: CanvasRenderingContext2D, color: string, subtype: number, headX: number, topY: number): void {
  const dome = (r: number, fill: string): void => {
    ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(headX, topY - 1, r, Math.PI, Math.PI * 2); ctx.fill(); keyline(ctx);
  };
  if (subtype === UnitType.Villager) {
    ctx.fillStyle = HAIR; ctx.fillRect(headX - 5, topY - 1, 10, 3); // fringe under the brim
    dome(6, '#c8a95e');
    ctx.fillStyle = shade('#c8a95e', 0.82); ctx.fillRect(headX - 8, topY - 1, 16, 2); // straw brim
    return;
  }
  if (subtype === UnitType.Militia) {
    dome(5.5, LEATHER);
    ctx.fillStyle = LEATHER_DARK; ctx.fillRect(headX - 7, topY - 3, 14, 2);
    return;
  }
  if (subtype === UnitType.ManAtArms) {
    dome(5.5, STEEL);
    ctx.fillStyle = STEEL_DARK; ellipse(ctx, headX, topY - 4, 9, 2.5); ctx.fill(); // kettle brim
    ctx.fillStyle = STEEL_LIGHT; ctx.fillRect(headX - 1, topY - 6, 3, 3);
    return;
  }
  if (subtype === UnitType.Spearman) {
    ctx.fillStyle = STEEL; tri(ctx, headX, topY - 9, headX + 6, topY - 2, headX - 6, topY - 2); keyline(ctx);
    ctx.fillStyle = STEEL_LIGHT; tri(ctx, headX, topY - 9, headX + 2, topY - 4, headX, topY - 3);
    ctx.strokeStyle = STEEL_DARK; ctx.lineWidth = 1; line(ctx, headX, topY - 2, headX, topY + 1); // nasal
    return;
  }
  if (subtype === UnitType.Longbowman) {
    dome(5.5, LEATHER);
    ctx.fillStyle = LEATHER_DARK; ellipse(ctx, headX, topY - 3, 8, 2.5); ctx.fill();
    return;
  }
  if (subtype === UnitType.Archer || subtype === UnitType.ThrowingAxeman) {
    ctx.fillStyle = color; // player hood — a large heraldic accent framing the face
    ctx.beginPath(); ctx.arc(headX, topY - 1, 6.5, Math.PI, Math.PI * 2); ctx.fill(); keyline(ctx);
    ctx.fillStyle = shade(color, 0.7); ctx.fillRect(headX - 6, topY - 1, 2, 5);
    ctx.fillStyle = color; ctx.fillRect(headX + 4, topY - 1, 2, 5);
    return;
  }
}

// Left-arm shields — small enough to keep the body silhouette, coloured per faction.
function drawShield(ctx: CanvasRenderingContext2D, color: string, subtype: number, topY: number): void {
  if (subtype === UnitType.Militia) {
    ctx.fillStyle = WOOD; ctx.beginPath(); ctx.arc(16, topY + 22, 7, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = shade(WOOD, 0.6); ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = STEEL; ctx.beginPath(); ctx.arc(16, topY + 22, 2, 0, Math.PI * 2); ctx.fill();
    return;
  }
  if (subtype === UnitType.ManAtArms) {
    ctx.fillStyle = color; tri(ctx, 12, topY + 16, 22, topY + 16, 17, topY + 30); keyline(ctx);
    ctx.strokeStyle = shade(color, 1.25); ctx.lineWidth = 1; line(ctx, 14, topY + 17, 20, topY + 26);
    return;
  }
  if (subtype === UnitType.Spearman) {
    ctx.fillStyle = LEATHER_DARK; ctx.beginPath(); ctx.arc(15, topY + 20, 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = STEEL; ctx.beginPath(); ctx.arc(15, topY + 20, 1.5, 0, Math.PI * 2); ctx.fill();
  }
}

// Shared horse kit (chest + rump + belly ellipses, arched neck, mane, tail, 4 legs
// whose hooves land on y=50) parameterised by coat + bulk, plus a class-specific rider.
function drawHorse(ctx: CanvasRenderingContext2D, color: string, subtype: number): void {
  const knight = subtype === UnitType.Knight;
  const mang = subtype === UnitType.Mangudai;
  const coat = knight ? '#5a4632' : mang ? '#6b5b46' : '#c4a26a'; // bay / steppe dun / palomino
  const coatDark = shade(coat, 0.72);
  const coatHi = shade(coat, 1.2);
  const hoof = '#1d1a17';

  // Tail (behind the rump) — three tapered strokes.
  ctx.strokeStyle = shade(coat, 0.55);
  ctx.lineWidth = 2; line(ctx, 10, 33, 6, 40);
  ctx.lineWidth = 1.5; line(ctx, 9, 34, 5, 42);
  ctx.lineWidth = 1; line(ctx, 11, 35, 5, 44);

  // Legs — rear pair offset + darker for depth; hooves sit exactly on y=50.
  ctx.fillStyle = coatDark; ctx.fillRect(34, 38, 4, 7); ctx.fillRect(41, 38, 4, 7);
  ctx.fillStyle = shade(coat, 0.6); ctx.fillRect(35, 44, 3, 6); ctx.fillRect(42, 44, 3, 6);
  ctx.fillStyle = coat; ctx.fillRect(15, 38, 4, 7); ctx.fillRect(22, 38, 4, 7);
  ctx.fillStyle = coatDark; ctx.fillRect(16, 44, 3, 6); ctx.fillRect(23, 44, 3, 6);
  ctx.fillStyle = hoof;
  ctx.fillRect(16, 48, 3, 2); ctx.fillRect(23, 48, 3, 2); ctx.fillRect(35, 48, 3, 2); ctx.fillRect(42, 48, 3, 2);

  // Body.
  ctx.fillStyle = coat;
  ellipse(ctx, 20, 34, 10, 9); ctx.fill(); keyline(ctx); // chest
  ellipse(ctx, 36, 35, 11, 9); ctx.fill(); keyline(ctx); // rump
  ctx.fillStyle = coatDark; ellipse(ctx, 30, 39, 14, 5); ctx.fill(); // belly
  ctx.fillStyle = coatHi; ellipse(ctx, 33, 31, 8, 3); ctx.fill(); // back highlight
  if (mang) {
    ctx.strokeStyle = coatDark; ctx.lineWidth = 1; // shaggy belly fringe
    line(ctx, 24, 42, 24, 45); line(ctx, 30, 43, 30, 46); line(ctx, 36, 42, 36, 45);
  }

  // Neck + head + mane.
  ctx.fillStyle = coat;
  ctx.beginPath(); ctx.moveTo(43, 32); ctx.lineTo(48, 16); ctx.lineTo(53, 19); ctx.lineTo(47, 36); ctx.closePath(); ctx.fill(); keyline(ctx);
  ctx.fillStyle = coat; ellipse(ctx, 50, 17, 4.5, 3.5); ctx.fill(); keyline(ctx);
  ctx.fillStyle = shade(coat, 0.85); ctx.fillRect(52, 16, 3, 3); // muzzle
  ctx.fillStyle = '#141414'; ctx.fillRect(50, 16, 1, 1);         // eye
  ctx.fillStyle = coatDark; tri(ctx, 48, 12, 50, 16, 46, 15);    // ear
  ctx.strokeStyle = shade(coat, 0.5); ctx.lineWidth = 2;
  line(ctx, 47, 17, 45, 20); line(ctx, 46, 20, 44, 23); line(ctx, 45, 23, 43, 26); line(ctx, 44, 26, 43, 29);

  // Barding / saddle blanket (player-colour heraldry over the barrel).
  if (knight) {
    ctx.fillStyle = color; ctx.fillRect(14, 30, 30, 11); // caparison
    for (let k = 0; k < 4; k++) { const cx2 = 18 + k * 8; ctx.beginPath(); ctx.arc(cx2, 41, 4, 0, Math.PI); ctx.fill(); } // scallop hem
    ctx.fillStyle = shade(color, 1.25); ctx.fillRect(14, 30, 30, 2);
    ctx.fillStyle = shade(color, 0.7); ctx.fillRect(14, 37, 30, 4);
    ctx.strokeStyle = KEYLINE; ctx.lineWidth = 1; line(ctx, 14, 30, 44, 30);
  } else if (subtype === UnitType.ScoutCavalry) {
    ctx.fillStyle = color; ctx.fillRect(21, 31, 14, 4);
    ctx.fillStyle = shade(color, 0.7); ctx.fillRect(21, 34, 14, 1);
  }

  // Rider.
  const riderBody = knight ? STEEL_LIGHT : CLOTH;
  ctx.strokeStyle = knight ? STEEL_DARK : '#4a3a26'; ctx.lineWidth = 3; line(ctx, 27, 30, 24, 37); // near thigh
  ctx.fillStyle = riderBody; roundBody(ctx, 23, 15, 11, 16); ctx.fill(); keyline(ctx);
  if (knight) {
    ctx.fillStyle = STEEL_DARK; ctx.fillRect(24, 24, 9, 7); // lower plate shade
    const sheen = ctx.createRadialGradient(29, 19, 1, 29, 21, 8);
    sheen.addColorStop(0, 'rgba(255,255,255,0.5)'); sheen.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sheen; ellipse(ctx, 29, 21, 6, 8); ctx.fill();
  } else {
    ctx.fillStyle = shade(CLOTH, 1.2); ctx.fillRect(24, 16, 9, 3);
    ctx.fillStyle = color; ctx.fillRect(24, 19, 9, 3); // player sash accent
  }
  ctx.strokeStyle = knight ? STEEL : SKIN; ctx.lineWidth = 3; line(ctx, 33, 19, 40, 15); // weapon arm

  if (knight) {
    ctx.fillStyle = STEEL; ctx.fillRect(26, 8, 9, 8); // great helm
    ctx.strokeStyle = STEEL_DARK; ctx.lineWidth = 1; line(ctx, 26, 8, 26, 16);
    ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 1; line(ctx, 27, 12, 34, 12); // visor slit
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(30, 6, 4, Math.PI, Math.PI * 2); ctx.fill(); // plume
    ctx.strokeStyle = color; ctx.lineWidth = 1; line(ctx, 33, 5, 37, 3); line(ctx, 33, 6, 38, 5);
  } else {
    ctx.fillStyle = SKIN_SHADE; ctx.fillRect(27, 15, 4, 3); // neck
    ctx.fillStyle = SKIN; ctx.beginPath(); ctx.arc(29, 11, 4.5, 0, Math.PI * 2); ctx.fill(); keyline(ctx);
    ctx.fillStyle = '#2a2018'; ctx.fillRect(31, 10, 1, 1);
    if (mang) {
      ctx.fillStyle = LEATHER_DARK; ctx.beginPath(); ctx.arc(29, 10, 5, Math.PI, Math.PI * 2); ctx.fill(); keyline(ctx);
      ctx.strokeStyle = 'rgba(230,222,205,0.9)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(29, 10, 5, Math.PI, Math.PI * 2); ctx.stroke(); // fur trim
      ctx.strokeStyle = color; ctx.lineWidth = 1; line(ctx, 24, 10, 34, 10); // player band
    } else {
      ctx.strokeStyle = LEATHER; ctx.lineWidth = 2; line(ctx, 25, 9, 33, 9); // scout headband
    }
  }

  // Hoof contact shadows.
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ellipse(ctx, 19, 50, 4, 1.5); ctx.fill();
  ellipse(ctx, 39, 50, 4, 1.5); ctx.fill();
}

// Gaia sheep — never player-tinted. A gradient-fluff body with ears/legs/tail so it
// reads as a cute animal, not a wool blob.
function drawSheep(ctx: CanvasRenderingContext2D): void {
  // Legs first (behind the fleece).
  ctx.fillStyle = '#6a5c4c';
  for (const lx of [17, 21, 33, 37]) ctx.fillRect(lx, 45, 2, 5);
  ctx.fillStyle = '#2e2a24';
  for (const lx of [17, 21, 33, 37]) ctx.fillRect(lx, 48, 2, 2);

  // Fleece — a soft radial gradient body under a cluster of bump arcs.
  const g = ctx.createRadialGradient(27, 36, 2, 27, 39, 16);
  g.addColorStop(0, '#fbf8f0'); g.addColorStop(1, '#ddd6c4');
  ctx.fillStyle = g;
  ellipse(ctx, 27, 38, 14, 9); ctx.fill(); keyline(ctx);
  ctx.fillStyle = '#f4efe4';
  ctx.beginPath();
  ctx.arc(16, 39, 4.5, 0, Math.PI * 2);
  ctx.arc(22, 34, 5.5, 0, Math.PI * 2);
  ctx.arc(29, 33, 5.5, 0, Math.PI * 2);
  ctx.arc(35, 35, 5, 0, Math.PI * 2);
  ctx.arc(38, 40, 4.5, 0, Math.PI * 2);
  ctx.fill();
  // Low belly shading arcs.
  ctx.fillStyle = 'rgba(0,0,0,0.08)';
  ctx.beginPath(); ctx.arc(20, 44, 3, 0, Math.PI); ctx.fill();
  ctx.beginPath(); ctx.arc(27, 45, 3, 0, Math.PI); ctx.fill();
  ctx.beginPath(); ctx.arc(34, 44, 3, 0, Math.PI); ctx.fill();

  // Head + drooping ear + muzzle highlight + eye.
  ctx.fillStyle = '#3b332c';
  ellipse(ctx, 42, 41, 4.5, 4); ctx.fill(); keyline(ctx);
  ctx.fillStyle = '#2f2822'; tri(ctx, 45, 38, 49, 40, 45, 42);
  ctx.fillStyle = '#8a7f72'; ctx.beginPath(); ctx.arc(44, 42, 1.6, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#f4f0e6'; ctx.fillRect(43, 40, 1, 1);
  // Tail.
  ctx.fillStyle = '#f0ebde'; ctx.beginPath(); ctx.arc(13, 39, 2.5, 0, Math.PI * 2); ctx.fill();
}

// Rounded torso built from a rect + top/bottom arcs (no beziers). Path only — the
// caller fills it and re-strokes the same path for the keyline.
function roundBody(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y + 3);
  ctx.lineTo(x, y + h - 3);
  ctx.arc(x + w / 2, y + h - 3, w / 2, Math.PI, 0, true);
  ctx.lineTo(x + w, y + 3);
  ctx.arc(x + w / 2, y + 3, w / 2, 0, Math.PI, true);
  ctx.closePath();
}

// ---- Projectiles ------------------------------------------------------------

const PROJ = 16;

function rasterizeProjectile(subtype: number): Sprite {
  const canvas = createOffscreenCanvas(PROJ, PROJ);
  const ctx = get2d(canvas);
  ctx.clearRect(0, 0, PROJ, PROJ);
  if (subtype === ProjectileType.Axe) {
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1; // spin motion arc
    ctx.beginPath(); ctx.arc(8, 8, 6, -0.6, 0.9); ctx.stroke();
    ctx.strokeStyle = WOOD; ctx.lineWidth = 2; line(ctx, 3, 13, 11, 5);
    ctx.fillStyle = STEEL; // francisca bit as an arc-bounded wedge (~60% scale)
    ctx.beginPath(); ctx.moveTo(11, 3); ctx.arc(13, 6, 3.4, -1.3, 0.9); ctx.lineTo(11, 8); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = STEEL_LIGHT; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(13, 6, 3.4, -1.3, 0.9); ctx.stroke();
  } else {
    // arrow: shaft + steel head with a glint + two fletching fins at the tail
    ctx.strokeStyle = '#4a3620'; ctx.lineWidth = 1.5; line(ctx, 2, 14, 12, 4);
    ctx.fillStyle = STEEL_LIGHT; tri(ctx, 12, 4, 15, 1, 13, 7);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(13, 3, 1, 1);
    ctx.fillStyle = '#d8d2c0';
    tri(ctx, 2, 14, 5, 12, 4, 15);
    tri(ctx, 2, 14, 0, 12, 2, 16);
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
    aoSkirt(ctx, gcx, gcy, Wd, Hd, 3);
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

  aoSkirt(ctx, gcx, gcy, Wd, Hd, 4);

  // Front-left wall (south-west face): darker.
  ctx.fillStyle = wallDark;
  quad(ctx, gLeft, gBot, rBot, rLeft); ctx.fill();
  // Front-right wall (south-east face): lighter.
  ctx.fillStyle = wallLight;
  quad(ctx, gBot, gRight, rRight, rBot); ctx.fill();

  drawWallTexture(ctx, subtype, wall, gLeft, gBot, gRight, rLeft, rBot, rRight, wallH);

  drawPitchedRoof(ctx, roofColor, subtype, rTop, rRight, rBot, rLeft, wallH);

  addBuildingDetails(ctx, subtype, roofColor, wall, wallH, gcx, gcy, gTop, gRight, gBot, gLeft, rTop, rRight, rBot, rLeft);

  drawPennant(ctx, subtype, owner, rTop);

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
// Baked building embellishments (pennants, wall texture, AO skirt).
// ---------------------------------------------------------------------------

// Soft ambient-occlusion skirt: three concentric ground diamonds, offset south,
// growing outward. Replaces the old flat single-alpha shadow.
function aoSkirt(ctx: CanvasRenderingContext2D, gcx: number, gcy: number, Wd: number, Hd: number, offY: number): void {
  const alphas = [0.10, 0.10, 0.08];
  const grow = [6, 3, 0];
  for (let k = 0; k < 3; k++) {
    const ex = Wd / 2 + grow[k];
    const ey = Hd / 2 + grow[k];
    ctx.fillStyle = `rgba(0,0,0,${alphas[k]})`;
    diamond(ctx, [gcx, gcy - ey + offY], [gcx + ex, gcy + offY], [gcx, gcy + ey + offY], [gcx - ex, gcy + offY]);
    ctx.fill();
  }
}

// Horizontal course lines on both wall faces (stone) or vertical plank lines (wood).
function drawWallTexture(
  ctx: CanvasRenderingContext2D,
  subtype: number,
  wall: string,
  gLeft: readonly number[], gBot: readonly number[], gRight: readonly number[],
  rLeft: readonly number[], rBot: readonly number[], rRight: readonly number[],
  wallH: number,
): void {
  if (wallH < 8) return;
  const wooden = subtype === BuildingType.Barracks || subtype === BuildingType.House ||
    subtype === BuildingType.LumberCamp || subtype === BuildingType.Stable;
  if (wooden) {
    // Vertical plank seams every ~5px across each face, faint.
    ctx.strokeStyle = shade(wall, 0.8);
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.25;
    for (let t = 0.18; t < 0.95; t += 0.22) {
      const lx = gLeft[0] + (gBot[0] - gLeft[0]) * t;
      const ly = gLeft[1] + (gBot[1] - gLeft[1]) * t;
      line(ctx, lx, ly, lx, ly - wallH);
      const rx = gBot[0] + (gRight[0] - gBot[0]) * t;
      const ry = gBot[1] + (gRight[1] - gBot[1]) * t;
      line(ctx, rx, ry, rx, ry - wallH);
    }
    ctx.globalAlpha = 1;
    return;
  }
  // Stone: horizontal courses climbing each face.
  const stone = subtype === BuildingType.Castle || subtype === BuildingType.TownCenter;
  ctx.strokeStyle = shade(wall, 0.85);
  ctx.lineWidth = 1;
  const courses = Math.max(2, Math.min(4, Math.round(wallH / 12)));
  for (let k = 1; k <= courses; k++) {
    const h = (wallH * k) / (courses + 1);
    line(ctx, gLeft[0], gLeft[1] - h, gBot[0], gBot[1] - h);
    line(ctx, gBot[0], gBot[1] - h, gRight[0], gRight[1] - h);
  }
  if (stone) {
    // Staggered vertical joints for a block look.
    ctx.strokeStyle = shade(wall, 0.78);
    for (let k = 1; k <= courses; k++) {
      const h = (wallH * k) / (courses + 1);
      const hn = (wallH * (k + 1)) / (courses + 1);
      const off = (k & 1) ? 0.35 : 0.6;
      const lx = gLeft[0] + (gBot[0] - gLeft[0]) * off;
      const ly = gLeft[1] + (gBot[1] - gLeft[1]) * off;
      line(ctx, lx, ly - h, lx, ly - hn);
      const rx = gBot[0] + (gRight[0] - gBot[0]) * off;
      const ry = gBot[1] + (gRight[1] - gBot[1]) * off;
      line(ctx, rx, ry - h, rx, ry - hn);
    }
  }
}

// A player-coloured triangular pennant on a short pole at the roof apex.
function drawPennant(ctx: CanvasRenderingContext2D, subtype: number, owner: number, rTop: readonly number[]): void {
  if (subtype !== BuildingType.TownCenter && subtype !== BuildingType.Castle &&
      subtype !== BuildingType.Barracks && subtype !== BuildingType.ArcheryRange &&
      subtype !== BuildingType.Stable) return;
  const color = PLAYER_COLORS[owner] ?? PLAYER_COLORS[0];
  const px = rTop[0];
  const baseY = rTop[1] + (subtype === BuildingType.Castle ? -2 : 2);
  const poleTop = baseY - 13;
  ctx.strokeStyle = '#2b2b2b'; ctx.lineWidth = 1.5;
  line(ctx, px, baseY, px, poleTop);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(px, poleTop);
  ctx.lineTo(px + 11, poleTop + 3);
  ctx.lineTo(px, poleTop + 7);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = shade(color, 0.7);
  ctx.beginPath();
  ctx.moveTo(px, poleTop + 4);
  ctx.lineTo(px + 7, poleTop + 5.5);
  ctx.lineTo(px, poleTop + 7);
  ctx.closePath();
  ctx.fill();
}

// ---------------------------------------------------------------------------
// FX sprites (dust puffs, hit sparks, chimney smoke, rally flag, water shimmer).
// variant = animation frame; owner tints RallyFlag.
// ---------------------------------------------------------------------------

function rasterizeFx(subtype: number, owner: number, variant: number): Sprite {
  switch (subtype) {
    case FxSprite.DustPuff: return rasterizeDustPuff(variant);
    case FxSprite.HitSpark: return rasterizeHitSpark(variant);
    case FxSprite.SmokePuff: return rasterizeSmokePuff(variant);
    case FxSprite.RallyFlag: return rasterizeRallyFlag(owner);
    case FxSprite.WaterShimmer: return rasterizeWaterShimmer(variant);
    default: return rasterizeDustPuff(0);
  }
}

// 3 frames: tight puff -> wide wisps -> faint ring. Each blob is a warm radial core
// so the dust has volume; frame 1 flicks up pebbles, frame 2 leaves a thin ring.
function rasterizeDustPuff(frame: number): Sprite {
  const S = 24;
  const canvas = createOffscreenCanvas(S, S);
  const ctx = get2d(canvas);
  ctx.clearRect(0, 0, S, S);
  const cx = S / 2, cy = S / 2;
  const spread = 3 + frame * 3;
  const alpha = frame === 0 ? 0.55 : frame === 1 ? 0.40 : 0.22;
  const puffs = [[0, 0, 4], [-spread, 1, 3], [spread, 0, 3], [0, -spread * 0.7, 2.5], [spread * 0.6, spread * 0.5, 2.5]];
  for (let k = 0; k < puffs.length; k++) {
    const px = cx + puffs[k][0], py = cy + puffs[k][1], r = puffs[k][2] + frame * 0.5;
    const g = ctx.createRadialGradient(px, py, 0.5, px, py, r);
    g.addColorStop(0, `rgba(203,188,152,${alpha})`);
    g.addColorStop(1, 'rgba(203,188,152,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
  }
  if (frame === 1) {
    ctx.fillStyle = 'rgba(120,100,70,0.7)';
    ctx.fillRect(cx + spread + 2, cy - 4, 1, 1);
    ctx.fillRect(cx - spread - 2, cy - 2, 1, 1);
  } else if (frame === 2) {
    ctx.strokeStyle = 'rgba(203,188,152,0.15)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, spread + 3, 0, Math.PI * 2); ctx.stroke();
  }
  return { canvas, anchorX: cx, anchorY: cy };
}

// 2 frames on an 18x18 canvas (anchor 9,9): a glowing 8-ray white star on impact,
// then a smaller orange star with scattered embers. canvas2d reads the anchor, so the
// resize is transparent to the caller.
function rasterizeHitSpark(frame: number): Sprite {
  const S = 18;
  const canvas = createOffscreenCanvas(S, S);
  const ctx = get2d(canvas);
  ctx.clearRect(0, 0, S, S);
  const cx = 9, cy = 9;
  if (frame === 0) {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 7);
    g.addColorStop(0, 'rgba(255,240,200,0.5)'); g.addColorStop(1, 'rgba(255,240,200,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    const r = 7;
    ctx.lineWidth = 2; line(ctx, cx - r, cy, cx + r, cy); line(ctx, cx, cy - r, cx, cy + r);
    const d = r * 0.62;
    ctx.lineWidth = 1; line(ctx, cx - d, cy - d, cx + d, cy + d); line(ctx, cx + d, cy - d, cx - d, cy + d);
  } else {
    const r = 4.5;
    ctx.strokeStyle = 'rgba(255,150,90,0.9)';
    ctx.lineWidth = 1.5; line(ctx, cx - r, cy, cx + r, cy); line(ctx, cx, cy - r, cx, cy + r);
    const d = r * 0.6;
    ctx.lineWidth = 1; line(ctx, cx - d, cy - d, cx + d, cy + d); line(ctx, cx + d, cy - d, cx - d, cy + d);
    ctx.fillStyle = 'rgba(255,180,90,0.85)';
    ctx.fillRect(cx + 5, cy - 3, 1, 1); ctx.fillRect(cx - 4, cy + 4, 1, 1); ctx.fillRect(cx + 3, cy + 5, 1, 1);
  }
  return { canvas, anchorX: cx, anchorY: cy };
}

// 3 frames: rising, expanding, thinning grey smoke ball.
function rasterizeSmokePuff(frame: number): Sprite {
  const S = 16;
  const canvas = createOffscreenCanvas(S, S);
  const ctx = get2d(canvas);
  ctx.clearRect(0, 0, S, S);
  const cx = S / 2, cy = S / 2;
  const r = 3 + frame * 1.6;
  ctx.fillStyle = `rgba(120,120,120,${0.5 - frame * 0.12})`;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = `rgba(160,160,160,${0.35 - frame * 0.1})`;
  ctx.beginPath(); ctx.arc(cx - 1, cy - 1, r * 0.6, 0, Math.PI * 2); ctx.fill();
  return { canvas, anchorX: cx, anchorY: cy };
}

// A little pole + player-colour pennant, anchored at the flag base.
function rasterizeRallyFlag(owner: number): Sprite {
  const W = 12, H = 18;
  const canvas = createOffscreenCanvas(W, H);
  const ctx = get2d(canvas);
  ctx.clearRect(0, 0, W, H);
  const color = PLAYER_COLORS[owner] ?? PLAYER_COLORS[0];
  ctx.strokeStyle = '#2b2b2b'; ctx.lineWidth = 1.5;
  line(ctx, 3, H, 3, 1);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(3, 1); ctx.lineTo(11, 4); ctx.lineTo(3, 7); ctx.closePath(); ctx.fill();
  ctx.fillStyle = shade(color, 0.7);
  ctx.beginPath();
  ctx.moveTo(3, 4); ctx.lineTo(8, 5.5); ctx.lineTo(3, 7); ctx.closePath(); ctx.fill();
  return { canvas, anchorX: 3, anchorY: H };
}

// A tile-diamond of thin light crescents; 3 frames at different offsets for shimmer.
function rasterizeWaterShimmer(frame: number): Sprite {
  const W = TILE_W, H = TILE_H;
  const canvas = createOffscreenCanvas(W, H);
  const ctx = get2d(canvas);
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(190,225,245,0.35)';
  ctx.lineWidth = 1;
  const cx = W / 2, cy = H / 2;
  const cr = [
    [[-10, -2], [8, 2]],
    [[-4, 4], [10, -3]],
    [[2, -4], [-8, 3]],
  ][frame % 3];
  for (let k = 0; k < cr.length; k++) {
    const ox = cr[k][0], oy = cr[k][1];
    ctx.beginPath();
    ctx.arc(cx + ox, cy + oy, 4, 0.2, 2.4);
    ctx.stroke();
  }
  return { canvas, anchorX: cx, anchorY: cy };
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
