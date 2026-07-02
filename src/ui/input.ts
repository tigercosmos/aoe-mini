// src/ui/input.ts
// Human InputController: box/single selection, contextual right-click commands, build-ghost placement,
// camera pan/zoom, hotkeys and control groups. READS the world, EMITS Commands into an internal buffer
// that the game loop drains once per tick. Never mutates the sim directly.

import type { InputController, PointerIntent, ViewState } from '../shared/interfaces';
import type { Command } from '../shared/commands';
import type { World } from '../shared/world';
import type { PlayerId, BuildingType } from '../shared/enums';
import {
  EntityKind,
  UnitType,
  ResourceNode,
  BuildingType as BuildingTypeEnum,
  GAIA,
  FLAG_UNDER_CONSTRUCTION,
} from '../shared/enums';
import { resolveHandle } from '../shared/world';
import { screenToWorld } from '../shared/iso';
import type { Vec2 } from '../shared/iso';
import { tileXOf, tileYOf, DEFAULT_MAP_SIZE } from '../shared/constants';
import { pickEntity, pickTile, entitiesInScreenRect, pruneSelection, BUILDING_FOOTPRINT } from './picking';
import { canPlaceBuilding } from '../map/tilemap';
import { resolveCost } from '../content/stats';

const DRAG_THRESHOLD_PX = 6; // left-drag beyond this = box select, otherwise a click
const EDGE_MARGIN_PX = 24; // cursor within this of a canvas edge triggers edge-pan
const PAN_SPEED_PX_PER_SEC = 900; // screen-space pan speed (scaled by 1/zoom into world units)
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2;
const ZOOM_STEP = 1.1;
const CLICK_MARKER_TTL_MS = 620;

interface DragState {
  active: boolean;
  moved: boolean;
  startX: number;
  startY: number;
  curX: number;
  curY: number;
}

/**
 * InputController extended with enqueueCommand — the seam the HUD's CommandSink uses to push its
 * commands into the same buffer that mouse/keyboard commands land in, so the loop drains them uniformly.
 */
export interface HumanInput extends InputController {
  /** When false (auto-play), camera still works but selection/commands are suppressed. */
  manualControl: boolean;
  enqueueCommand(cmd: Command): void;
}

class HumanInputController implements HumanInput {
  readonly view: ViewState;
  private _manualControl = false;

  get manualControl(): boolean {
    return this._manualControl;
  }

  set manualControl(enabled: boolean) {
    if (this._manualControl === enabled) return;
    this._manualControl = enabled;
    if (!enabled) this.enterAutoPlay();
  }

  private canvas: HTMLCanvasElement | null = null;
  private minimap: HTMLCanvasElement | null = null;
  private world: World | null = null;
  private readonly buffer: Command[] = [];
  private readonly keys = new Set<string>();
  private readonly controlGroups = new Map<number, number[]>();
  private readonly drag: DragState = { active: false, moved: false, startX: 0, startY: 0, curX: 0, curY: 0 };
  private mouseX = 0;
  private mouseY = 0;
  private mouseInside = false;
  private readonly tmp: Vec2 = { x: 0, y: 0 };

  // Bound handlers (stable identity for add/removeEventListener).
  private readonly onMouseDown = (e: MouseEvent) => this.handleMouseDown(e);
  private readonly onMouseMove = (e: MouseEvent) => this.handleMouseMove(e);
  private readonly onMouseUp = (e: MouseEvent) => this.handleMouseUp(e);
  private readonly onMouseLeave = () => this.handleMouseLeave();
  private readonly onContextMenu = (e: MouseEvent) => e.preventDefault();
  private readonly onWheel = (e: WheelEvent) => this.handleWheel(e);
  private readonly onKeyDown = (e: KeyboardEvent) => this.handleKeyDown(e);
  private readonly onKeyUp = (e: KeyboardEvent) => { this.keys.delete(e.key.toLowerCase()); };
  private readonly onMinimapDown = (e: MouseEvent) => this.handleMinimapDown(e);

  constructor(localPlayer: PlayerId) {
    this.view = {
      camX: DEFAULT_MAP_SIZE / 2,
      camY: DEFAULT_MAP_SIZE / 2,
      zoom: 1,
      viewportW: 0,
      viewportH: 0,
      localPlayer,
      selection: [],
      ghost: null,
      pointer: {
        x: 0,
        y: 0,
        inside: false,
        intent: 'default',
        hoverTileX: -1,
        hoverTileY: -1,
        hoverHandle: -1,
        drag: null,
        markers: [],
      },
    };
  }

  attach(canvas: HTMLCanvasElement, minimap: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.minimap = minimap;
    this.view.viewportW = canvas.clientWidth || canvas.width;
    this.view.viewportH = canvas.clientHeight || canvas.height;
    canvas.addEventListener('mousedown', this.onMouseDown);
    canvas.addEventListener('mousemove', this.onMouseMove);
    // mouseup/keys bind to window so a drag that ends outside the canvas still resolves.
    window.addEventListener('mouseup', this.onMouseUp);
    canvas.addEventListener('mouseleave', this.onMouseLeave);
    canvas.addEventListener('contextmenu', this.onContextMenu);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    minimap.addEventListener('mousedown', this.onMinimapDown);
    minimap.addEventListener('contextmenu', this.onContextMenu);
  }

  detach(): void {
    const canvas = this.canvas;
    const minimap = this.minimap;
    if (canvas) {
      canvas.removeEventListener('mousedown', this.onMouseDown);
      canvas.removeEventListener('mousemove', this.onMouseMove);
      canvas.removeEventListener('mouseleave', this.onMouseLeave);
      canvas.removeEventListener('contextmenu', this.onContextMenu);
      canvas.removeEventListener('wheel', this.onWheel);
    }
    if (minimap) {
      minimap.removeEventListener('mousedown', this.onMinimapDown);
      minimap.removeEventListener('contextmenu', this.onContextMenu);
    }
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.canvas = null;
    this.minimap = null;
    this.keys.clear();
    this.drag.active = false;
  }

  update(world: World, dtMs: number): void {
    this.world = world;
    this.ageClickMarkers(dtMs);
    // Camera pan from held keys + screen edges.
    this.applyCameraPan(world, dtMs);
    // Keep the live-ghost validity fresh even without mouse motion (resources/placement change over time).
    if (this.view.ghost) this.refreshGhost(world);
    // Drop dead handles from the selection so the HUD / commands never reference stale entities.
    this.view.selection = pruneSelection(world, this.view.selection);
    this.refreshPointerFeedback(world);
  }

  drainCommands(): Command[] {
    if (this.buffer.length === 0) return [];
    const out = this.buffer.slice();
    this.buffer.length = 0;
    return out;
  }

  /** Push a command from an external source (the HUD's CommandSink) into the drain buffer. */
  enqueueCommand(cmd: Command): void {
    if (!this._manualControl) return;
    this.buffer.push(cmd);
  }

  private enterAutoPlay(): void {
    this.view.selection = [];
    this.view.ghost = null;
    this.buffer.length = 0;
    this.drag.active = false;
    this.syncDragFeedback();
  }

  // ---- internal ----------------------------------------------------------

  private localCoords(e: MouseEvent, el: HTMLElement): { x: number; y: number } {
    const rect = el.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private handleMouseLeave(): void {
    this.mouseInside = false;
    const p = this.view.pointer;
    if (p) {
      p.inside = false;
      p.intent = 'default';
      p.hoverTileX = -1;
      p.hoverTileY = -1;
      p.hoverHandle = -1;
      if (!this.drag.active) p.drag = null;
    }
    this.setCanvasCursor('default');
  }

  private handleMouseDown(e: MouseEvent): void {
    if (!this.canvas) return;
    const { x, y } = this.localCoords(e, this.canvas);
    this.mouseX = x;
    this.mouseY = y;
    this.mouseInside = true;
    this.syncPointerPosition();

    if (!this._manualControl) return;

    if (e.button === 0) {
      // Left button.
      if (this.view.ghost) {
        // Placement click handled on mousedown for immediacy.
        this.placeGhost(e.shiftKey);
        e.preventDefault();
        return;
      }
      this.drag.active = true;
      this.drag.moved = false;
      this.drag.startX = x;
      this.drag.startY = y;
      this.drag.curX = x;
      this.drag.curY = y;
      this.syncDragFeedback();
      e.preventDefault();
    } else if (e.button === 2) {
      // Right button.
      if (this.view.ghost) {
        this.view.ghost = null; // right-click cancels placement
        this.pushMarker('invalid', x, y);
        e.preventDefault();
        return;
      }
      if (this.world) this.resolveContextCommand(this.world, x, y);
      e.preventDefault();
    }
  }

  private handleMouseMove(e: MouseEvent): void {
    if (!this.canvas) return;
    const { x, y } = this.localCoords(e, this.canvas);
    this.mouseX = x;
    this.mouseY = y;
    this.mouseInside = true;
    this.syncPointerPosition();

    if (this.view.ghost && this.world) {
      const tile = pickTile(this.view, x, y, this.world.mapSize);
      if (tile >= 0) {
        this.view.ghost.tileX = tileXOf(this.world.mapSize, tile);
        this.view.ghost.tileY = tileYOf(this.world.mapSize, tile);
      }
      this.refreshGhost(this.world);
    }

    if (this.drag.active) {
      this.drag.curX = x;
      this.drag.curY = y;
      const dx = x - this.drag.startX;
      const dy = y - this.drag.startY;
      if (dx * dx + dy * dy > DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) this.drag.moved = true;
      this.syncDragFeedback();
    }

    if (this.world) this.refreshPointerFeedback(this.world);
  }

  private handleMouseUp(e: MouseEvent): void {
    if (e.button !== 0) return;
    if (!this.drag.active) return;
    this.drag.active = false;
    this.syncDragFeedback();
    if (!this._manualControl || !this.world || !this.canvas) return;

    if (this.drag.moved) {
      // Box select own units.
      const picked = entitiesInScreenRect(
        this.world,
        this.view,
        this.drag.startX,
        this.drag.startY,
        this.drag.curX,
        this.drag.curY,
        this.view.localPlayer,
      );
      this.setSelection(picked, e.shiftKey);
      this.pushMarker(picked.length > 0 ? 'select' : 'invalid', this.drag.curX, this.drag.curY);
    } else {
      // Single click select (any owner; enemies are view-only).
      const handle = pickEntity(this.world, this.view, this.drag.startX, this.drag.startY);
      if (handle >= 0) {
        this.setSelection([handle], e.shiftKey);
        this.pushMarker('select', this.drag.startX, this.drag.startY);
      } else if (!e.shiftKey) {
        this.view.selection = [];
      }
    }
    this.refreshPointerFeedback(this.world);
  }

  private handleWheel(e: WheelEvent): void {
    e.preventDefault();
    const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    this.view.zoom = clamp(this.view.zoom * factor, ZOOM_MIN, ZOOM_MAX);
  }

  private handleKeyDown(e: KeyboardEvent): void {
    const key = e.key.toLowerCase();
    this.keys.add(key);

    if (key === 'h') {
      if (this.world) this.jumpToTownCenter(this.world);
      return;
    }

    if (!this._manualControl) return;

    if (key === 'escape') {
      this.view.ghost = null;
      return;
    }
    // Control groups 1-9.
    if (key.length === 1 && key >= '1' && key <= '9') {
      const group = key.charCodeAt(0) - '0'.charCodeAt(0);
      if (e.ctrlKey || e.metaKey) {
        this.controlGroups.set(group, this.view.selection.slice());
      } else if (this.world) {
        const saved = this.controlGroups.get(group);
        if (saved) this.setSelection(pruneSelection(this.world, saved), false);
      }
    }
  }

  private handleMinimapDown(e: MouseEvent): void {
    if (!this.minimap || !this.world) return;
    e.preventDefault();
    const rect = this.minimap.getBoundingClientRect();
    const w = rect.width || this.minimap.width;
    const h = rect.height || this.minimap.height;
    if (w <= 0 || h <= 0) return;
    const fx = (e.clientX - rect.left) / w;
    const fy = (e.clientY - rect.top) / h;
    // Linear map of the minimap square to world tiles (v1 approximation; ignores the 45deg render skew).
    this.view.camX = clamp(fx * this.world.mapSize, 0, this.world.mapSize);
    this.view.camY = clamp(fy * this.world.mapSize, 0, this.world.mapSize);
    this.pushMarker('move', this.view.viewportW - 105, this.view.viewportH - 105);
  }

  private syncPointerPosition(): void {
    const p = this.view.pointer;
    if (!p) return;
    p.x = this.mouseX;
    p.y = this.mouseY;
    p.inside = this.mouseInside;
  }

  private syncDragFeedback(): void {
    const p = this.view.pointer;
    if (!p) return;
    if (this.drag.active) {
      p.drag = {
        active: true,
        moved: this.drag.moved,
        startX: this.drag.startX,
        startY: this.drag.startY,
        curX: this.drag.curX,
        curY: this.drag.curY,
      };
    } else {
      p.drag = null;
    }
  }

  private ageClickMarkers(dtMs: number): void {
    const markers = this.view.pointer?.markers;
    if (!markers) return;
    for (const m of markers) m.ttlMs -= dtMs;
    let write = 0;
    for (let read = 0; read < markers.length; read++) {
      if (markers[read].ttlMs > 0) markers[write++] = markers[read];
    }
    markers.length = write;
  }

  private pushMarker(kind: PointerIntent, x: number, y: number): void {
    const markers = this.view.pointer?.markers;
    if (!markers) return;
    markers.push({ kind, x, y, ttlMs: CLICK_MARKER_TTL_MS, totalMs: CLICK_MARKER_TTL_MS });
    if (markers.length > 12) markers.shift();
  }

  private refreshPointerFeedback(world: World): void {
    const p = this.view.pointer;
    if (!p) return;
    this.syncPointerPosition();
    this.syncDragFeedback();
    if (!this.mouseInside) {
      p.intent = 'default';
      p.hoverTileX = -1;
      p.hoverTileY = -1;
      p.hoverHandle = -1;
      this.setCanvasCursor('default');
      return;
    }

    const tile = pickTile(this.view, this.mouseX, this.mouseY, world.mapSize);
    p.hoverTileX = tile >= 0 ? tileXOf(world.mapSize, tile) : -1;
    p.hoverTileY = tile >= 0 ? tileYOf(world.mapSize, tile) : -1;
    p.hoverHandle = pickEntity(world, this.view, this.mouseX, this.mouseY);
    p.intent = this.resolvePointerIntent(world, p.hoverHandle, tile);
    this.setCanvasCursor(cursorForIntent(p.intent));
  }

  private resolvePointerIntent(world: World, handle: number, tile: number): PointerIntent {
    if (this.view.ghost) return this.view.ghost.valid ? 'build' : 'invalid';
    if (this.drag.active) return 'select';

    const { units, villagers, buildings } = this.classifySelection(world);
    const comp = world.comp;
    const em = world.em;
    const player = this.view.localPlayer;

    if (handle >= 0) {
      const i = resolveHandle(em, handle);
      if (i >= 0) {
        const owner = comp.owner[i];
        const kind = comp.kind[i];
        const subtype = comp.subtype[i];
        if (owner !== player && units.length > 0) return 'attack';
        if (owner === GAIA && kind === EntityKind.Unit && subtype === UnitType.Sheep && villagers.length > 0) return 'gather';
        if (owner === player && kind === EntityKind.Building && villagers.length > 0) {
          if ((comp.flags[i] & FLAG_UNDER_CONSTRUCTION) !== 0) return 'build';
          if (subtype === BuildingTypeEnum.Farm) return 'gather';
        }
        return 'select';
      }
    }

    if (tile >= 0 && villagers.length > 0) {
      const node = world.map.resourceType[tile];
      if (
        node === ResourceNode.Tree ||
        node === ResourceNode.Forage ||
        node === ResourceNode.GoldMine ||
        node === ResourceNode.StoneMine
      ) return 'gather';
    }

    if (buildings.length > 0 && units.length === 0) return 'rally';
    if (units.length > 0) return this.keys.has('a') ? 'attack' : 'move';
    return handle >= 0 ? 'select' : 'default';
  }

  private setCanvasCursor(cursor: string): void {
    if (this.canvas && this.canvas.style.cursor !== cursor) this.canvas.style.cursor = cursor;
  }

  private applyCameraPan(world: World, dtMs: number): void {
    let sx = 0;
    let sy = 0;
    if (this.keys.has('w') || this.keys.has('arrowup')) sy -= 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) sy += 1;
    if (this.keys.has('a') || this.keys.has('arrowleft')) sx -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) sx += 1;

    if (this.mouseInside && this.view.viewportW > 0 && this.view.viewportH > 0) {
      if (this.mouseX <= EDGE_MARGIN_PX) sx -= 1;
      else if (this.mouseX >= this.view.viewportW - EDGE_MARGIN_PX) sx += 1;
      if (this.mouseY <= EDGE_MARGIN_PX) sy -= 1;
      else if (this.mouseY >= this.view.viewportH - EDGE_MARGIN_PX) sy += 1;
    }

    if (sx === 0 && sy === 0) return;
    // Normalize diagonal so speed is consistent.
    const len = Math.hypot(sx, sy) || 1;
    const stepPx = (PAN_SPEED_PX_PER_SEC * dtMs) / 1000;
    const dsx = (sx / len) * stepPx;
    const dsy = (sy / len) * stepPx;
    // Convert a screen-space shift to a world (tile) shift via the inverse iso projection, scaled by zoom.
    const dix = dsx / this.view.zoom;
    const diy = dsy / this.view.zoom;
    // worldX(px,py) = px/TILE_W + py/TILE_H ; worldY(px,py) = py/TILE_H - px/TILE_W
    // Inlined here to avoid importing constants twice; TILE_W=64, TILE_H=32.
    const dWorldX = dix / 64 + diy / 32;
    const dWorldY = diy / 32 - dix / 64;
    this.view.camX = clamp(this.view.camX + dWorldX, 0, world.mapSize);
    this.view.camY = clamp(this.view.camY + dWorldY, 0, world.mapSize);
  }

  private setSelection(handles: number[], additive: boolean): void {
    if (additive) {
      const set = new Set(this.view.selection);
      for (const h of handles) set.add(h);
      this.view.selection = Array.from(set).sort((a, b) => a - b);
    } else {
      this.view.selection = handles.slice().sort((a, b) => a - b);
    }
  }

  private jumpToTownCenter(world: World): void {
    const comp = world.comp;
    const em = world.em;
    for (let i = 0; i < comp.capacity; i++) {
      if (em.alive[i] !== 1) continue;
      if (comp.owner[i] !== this.view.localPlayer) continue;
      if (comp.kind[i] !== EntityKind.Building) continue;
      if (comp.subtype[i] !== BuildingTypeEnum.TownCenter) continue;
      this.view.camX = comp.posX[i];
      this.view.camY = comp.posY[i];
      return;
    }
  }

  /** Recompute view.ghost.valid = placeable footprint AND player can afford the building cost. */
  private refreshGhost(world: World): void {
    const ghost = this.view.ghost;
    if (!ghost) return;
    const fp = BUILDING_FOOTPRINT[ghost.building];
    const placeable = canPlaceBuilding(world.map, ghost.tileX, ghost.tileY, fp.sizeX, fp.sizeY);
    ghost.valid = placeable && this.canAfford(world, { building: ghost.building });
  }

  private canAfford(world: World, item: { unit?: UnitType; building?: BuildingType }): boolean {
    const player = world.players[this.view.localPlayer];
    if (!player) return false;
    const cost = resolveCost(world, this.view.localPlayer, item);
    const r = player.resources;
    return r[0] >= cost.food && r[1] >= cost.wood && r[2] >= cost.gold && r[3] >= cost.stone;
  }

  private placeGhost(shift: boolean): void {
    const ghost = this.view.ghost;
    if (!ghost || !this.world) return;
    this.refreshGhost(this.world);
    if (!ghost.valid) {
      this.pushMarker('invalid', this.mouseX, this.mouseY);
      return;
    }
    const villagers = this.selectedVillagerHandles(this.world);
    if (villagers.length === 0) return;
    this.pushMarker('build', this.mouseX, this.mouseY);
    this.buffer.push({
      type: 'build',
      player: this.view.localPlayer,
      units: villagers,
      building: ghost.building,
      tileX: ghost.tileX,
      tileY: ghost.tileY,
    });
    if (!shift) this.view.ghost = null; // shift keeps the ghost active for chained placement
  }

  /** Collect selected own units / villagers / buildings (as handles) once for context resolution. */
  private classifySelection(world: World): { units: number[]; villagers: number[]; buildings: number[] } {
    const comp = world.comp;
    const em = world.em;
    const units: number[] = [];
    const villagers: number[] = [];
    const buildings: number[] = [];
    for (const h of this.view.selection) {
      const i = resolveHandle(em, h);
      if (i < 0) continue;
      if (comp.owner[i] !== this.view.localPlayer) continue;
      if (comp.kind[i] === EntityKind.Unit) {
        units.push(h);
        if (comp.subtype[i] === UnitType.Villager) villagers.push(h);
      } else if (comp.kind[i] === EntityKind.Building) {
        buildings.push(h);
      }
    }
    return { units, villagers, buildings };
  }

  private selectedVillagerHandles(world: World): number[] {
    return this.classifySelection(world).villagers;
  }

  /**
   * Resolve a right-click into a single Command (or several setRally commands) based on what is under
   * the cursor and what is selected. Priority: enemy entity -> attack; resource tile -> gatherTile
   * (villagers); gaia sheep / own farm -> gatherEntity (villagers); own under-construction building ->
   * build resume; own buildings selected + ground -> setRally; else ground -> move/attackMove.
   */
  private resolveContextCommand(world: World, sx: number, sy: number): void {
    const { units, villagers, buildings } = this.classifySelection(world);
    if (units.length === 0 && buildings.length === 0) return;

    const player = this.view.localPlayer;
    const comp = world.comp;
    const em = world.em;
    const handle = pickEntity(world, this.view, sx, sy);

    // --- entity under cursor ---
    if (handle >= 0) {
      const i = resolveHandle(em, handle);
      if (i >= 0) {
        const owner = comp.owner[i];
        const kind = comp.kind[i];
        const subtype = comp.subtype[i];

        // Gaia sheep -> gather (villagers).
        if (owner === GAIA && kind === EntityKind.Unit && subtype === UnitType.Sheep) {
          if (villagers.length > 0) {
            this.pushMarker('gather', sx, sy);
            this.buffer.push({ type: 'gatherEntity', player, units: villagers, target: handle });
            return;
          }
        } else if (owner === player && kind === EntityKind.Building) {
          if ((comp.flags[i] & FLAG_UNDER_CONSTRUCTION) !== 0) {
            // Resume construction: re-issue the build at this building's footprint origin.
            if (villagers.length > 0) {
              const originX = Math.round(comp.posX[i] - comp.sizeX[i] / 2);
              const originY = Math.round(comp.posY[i] - comp.sizeY[i] / 2);
              this.pushMarker('build', sx, sy);
              this.buffer.push({
                type: 'build',
                player,
                units: villagers,
                building: subtype as BuildingType,
                tileX: originX,
                tileY: originY,
              });
              return;
            }
          } else if (subtype === BuildingTypeEnum.Farm) {
            // Completed own farm -> gather (villagers).
            if (villagers.length > 0) {
              this.pushMarker('gather', sx, sy);
              this.buffer.push({ type: 'gatherEntity', player, units: villagers, target: handle });
              return;
            }
          }
          // Other own buildings: fall through to a ground move to the building.
        } else if (owner !== player) {
          // Enemy (another player or a gaia non-sheep entity) -> attack.
          if (units.length > 0) {
            this.pushMarker('attack', sx, sy);
            this.buffer.push({ type: 'attack', player, units, target: handle });
            return;
          }
        }
      }
    }

    // --- tile under cursor ---
    const tile = pickTile(this.view, sx, sy, world.mapSize);
    if (tile >= 0) {
      const node = world.map.resourceType[tile];
      if (
        node === ResourceNode.Tree ||
        node === ResourceNode.Forage ||
        node === ResourceNode.GoldMine ||
        node === ResourceNode.StoneMine
      ) {
        if (villagers.length > 0) {
          this.pushMarker('gather', sx, sy);
          this.buffer.push({ type: 'gatherTile', player, units: villagers, tile });
          return;
        }
      }
    }

    // --- plain ground ---
    screenToWorld(this.view, sx, sy, this.tmp);
    const gx = this.tmp.x;
    const gy = this.tmp.y;

    if (units.length > 0) {
      const attackMove = this.keys.has('a');
      this.pushMarker(attackMove ? 'attack' : 'move', sx, sy);
      this.buffer.push({ type: attackMove ? 'attackMove' : 'move', player, units, x: gx, y: gy });
      return;
    }
    // Only buildings selected -> set rally point for each.
    if (buildings.length > 0) {
      this.pushMarker('rally', sx, sy);
      for (const b of buildings) this.buffer.push({ type: 'setRally', player, building: b, x: gx, y: gy });
    }
  }
}

function cursorForIntent(intent: PointerIntent): string {
  switch (intent) {
    case 'attack': return 'crosshair';
    case 'gather': return 'grab';
    case 'build': return 'copy';
    case 'invalid': return 'not-allowed';
    case 'move': return 'move';
    case 'rally': return 'cell';
    case 'select': return 'pointer';
    default: return 'crosshair';
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function createInputController(localPlayer: PlayerId): HumanInput {
  return new HumanInputController(localPlayer);
}
