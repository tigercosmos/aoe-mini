import type { BuildingType, CivId, PlayerId } from './enums';
import type { World } from './world';
import type { Command } from './commands';
import type { GameEvent } from './events';

export type System = (world: World) => void;

/** The four behavior systems T4's createStepper wires into the tick pipeline (production, villager, combat, projectile). Lets T4 unit-test the stepper with no-op fakes; real wiring lives in src/sim/step-default.ts. */
export interface SystemSet { production: System; villager: System; combat: System; projectile: System }

export interface ViewState {
  camX: number; camY: number;   // world coords (tile units) at viewport center
  zoom: number;                 // 1 = native; clamp [0.5, 2]
  viewportW: number; viewportH: number; // CSS pixels
  localPlayer: PlayerId;
  selection: number[];          // entity HANDLES, ascending
  ghost: { building: BuildingType; tileX: number; tileY: number; valid: boolean } | null;
  pointer?: PointerFeedback;
}

export type PointerIntent = 'default' | 'select' | 'move' | 'attack' | 'gather' | 'build' | 'rally' | 'invalid';

export interface PointerDragFeedback {
  active: boolean;
  moved: boolean;
  startX: number;
  startY: number;
  curX: number;
  curY: number;
}

export interface ClickMarker {
  kind: PointerIntent;
  x: number;
  y: number;
  ttlMs: number;
  totalMs: number;
}

export interface PointerFeedback {
  x: number;
  y: number;
  inside: boolean;
  intent: PointerIntent;
  hoverTileX: number;
  hoverTileY: number;
  hoverHandle: number;
  drag: PointerDragFeedback | null;
  markers: ClickMarker[];
}

export interface Renderer {
  init(canvas: HTMLCanvasElement): void;
  resize(width: number, height: number): void;
  /** alpha in [0,1): interpolate prevX/prevY -> posX/posY. Renders terrain, fog, entities, projectiles, selection, HP bars, ghost. */
  render(world: World, view: ViewState, alpha: number): void;
  renderMinimap(world: World, view: ViewState, ctx: CanvasRenderingContext2D): void;
  dispose(): void;
}

export interface InputController {
  readonly view: ViewState;
  attach(canvas: HTMLCanvasElement, minimap: HTMLCanvasElement): void;
  detach(): void;
  update(world: World, dtMs: number): void; // edge-pan / key-pan / prune dead selection
  drainCommands(): Command[];               // commands issued since last drain (then cleared)
}

export interface AIConfig { maxVillagers: number; attackArmySize: number; thinkInterval: number }
export interface AIPlayer {
  readonly player: PlayerId;
  /** Called EVERY tick before stepWorld; must return [] on non-think ticks (tick % thinkInterval !== player % thinkInterval). Read-only World access + private RNG only. */
  think(world: World): Command[];
}

export interface PlayerSetup { civ: CivId; isAI: boolean }
export interface MatchSetup { seed: number; mapSize?: number; players: PlayerSetup[] } // players[0] -> PlayerId 1
export interface MatchResult { winner: PlayerId; ticks: number; checksum: number; events: GameEvent[] } // winner -1 on timeout; events = playerDefeated/matchEnded log
