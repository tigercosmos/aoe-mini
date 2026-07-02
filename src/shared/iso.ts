import { TILE_H, TILE_W } from './constants';
import type { ViewState } from './interfaces';

// World (tile units, +x = east, +y = south) -> unscaled iso pixel space.
export function isoX(wx: number, wy: number): number { return (wx - wy) * (TILE_W / 2); }
export function isoY(wx: number, wy: number): number { return (wx + wy) * (TILE_H / 2); }
// Inverse (unscaled iso pixels -> world).
export function worldX(px: number, py: number): number { return px / TILE_W + py / TILE_H; }
export function worldY(px: number, py: number): number { return py / TILE_H - px / TILE_W; }

export interface Vec2 { x: number; y: number }

/** World -> canvas CSS pixels under a camera view. */
export function worldToScreen(view: ViewState, wx: number, wy: number, out: Vec2): void {
  out.x = (isoX(wx, wy) - isoX(view.camX, view.camY)) * view.zoom + view.viewportW / 2;
  out.y = (isoY(wx, wy) - isoY(view.camX, view.camY)) * view.zoom + view.viewportH / 2;
}
/** Canvas CSS pixels -> world coords under a camera view. */
export function screenToWorld(view: ViewState, sx: number, sy: number, out: Vec2): void {
  const px = (sx - view.viewportW / 2) / view.zoom + isoX(view.camX, view.camY);
  const py = (sy - view.viewportH / 2) / view.zoom + isoY(view.camX, view.camY);
  out.x = worldX(px, py);
  out.y = worldY(px, py);
}
