// src/ui/hud.ts
// DOM HUD: top resource/pop/age bar (procedural icons, per-resource villager counts, idle-villager
// button + badge, game clock, pop warning, age-up progress), selection panel v2 (sprite portraits,
// live HP bar, effective stats, clickable multi-select cells), command grid v2 (positional hotkeys,
// affordability-colored costs, rich tooltips), minimap attack pings, "under attack" alerts, footprint
// ghost data, and a victory/defeat screen with match stats. Reads the world read-only and emits
// Commands through the injected CommandSink; sets view.ghost / view.selection / view.camX,camY.
//
// DOM is rebuilt only when watched state changes (selection + age + statsVersion); per-frame it
// refreshes text, HP bars, affordability and production-queue progress in place. Sprites are touched
// LAZILY (inside portraitCanvas) so headless tests can install a setCanvasFactory fake first.

import type { World, PlayerState } from '../shared/world';
import { resolveHandle } from '../shared/world';
import type { ViewState } from '../shared/interfaces';
import type { CommandSink } from '../shared/commands';
import type { GameEvent } from '../shared/events';
import type { PlayerId, BuildingType, UnitType, TechId } from '../shared/enums';
import {
  EntityKind,
  UnitType as UnitTypeEnum,
  BuildingType as BuildingTypeEnum,
  TechId as TechIdEnum,
  Age,
  Resource,
  OrderType,
  FLAG_UNDER_CONSTRUCTION,
  UNIT_TYPE_COUNT,
  nodeToResource,
} from '../shared/enums';
import type { ResourceNode } from '../shared/enums';
import type { Cost } from '../shared/content-types';
import {
  resolveCost,
  canTrain,
  canResearch,
  resolveUnitStats,
  resolveBuildingStats,
} from '../content/stats';
import { BUILDING_FOOTPRINT } from './picking';
import { findIdleVillagers } from './input';
import { MIN_SIM_SPEED, MAX_SIM_SPEED, TICK_RATE, POP_CAP_MAX } from '../shared/constants';
import { getSprite, spriteKey, PLAYER_COLORS } from '../render/sprites';

export interface Hud {
  update(world: World, view: ViewState, events: GameEvent[]): void;
  root: HTMLElement;
  setAutoPlay(auto: boolean): void;
  setSimSpeed(speed: number): void;
}

// ---- UI-only content labels (cosmetic; no sim correctness dependency) ----

const UNIT_LABEL: Record<UnitType, { name: string; glyph: string }> = {
  0: { name: 'Villager', glyph: 'Vil' },
  1: { name: 'Militia', glyph: 'Mil' },
  2: { name: 'Man-at-Arms', glyph: 'MaA' },
  3: { name: 'Spearman', glyph: 'Spr' },
  4: { name: 'Archer', glyph: 'Arc' },
  5: { name: 'Scout Cavalry', glyph: 'Sct' },
  6: { name: 'Knight', glyph: 'Kni' },
  7: { name: 'Longbowman', glyph: 'Lbw' },
  8: { name: 'Throwing Axeman', glyph: 'Axe' },
  9: { name: 'Mangudai', glyph: 'Mgd' },
  10: { name: 'Sheep', glyph: 'She' },
};

const BUILDING_LABEL: Record<BuildingType, string> = {
  0: 'Town Center',
  1: 'House',
  2: 'Mill',
  3: 'Lumber Camp',
  4: 'Mining Camp',
  5: 'Farm',
  6: 'Barracks',
  7: 'Archery Range',
  8: 'Stable',
  9: 'Blacksmith',
  10: 'Castle',
};

const TECH_LABEL: Record<TechId, string> = {
  0: 'Loom',
  1: 'Wheelbarrow',
  2: 'Man-at-Arms Upgrade',
  3: 'Forging',
  4: 'Iron Casting',
  5: 'Fletching',
  6: 'Bodkin Arrow',
  7: 'Scale Mail Armor',
  8: 'Chain Mail Armor',
  9: 'Scale Barding Armor',
  10: 'Feudal Age',
  11: 'Castle Age',
  12: 'Imperial Age',
};

// UI-only flavor blurbs for research tooltips (cosmetic; no sim dependency).
const TECH_BLURB: Partial<Record<TechId, string>> = {
  0: 'Villagers +15 HP, +1/+1 armor',
  1: 'Villagers carry more resources',
  2: 'Upgrades Militia to Man-at-Arms',
  3: '+1 infantry attack',
  4: '+1 infantry attack',
  5: '+1 archer attack and range',
  6: '+1 archer attack and range',
  7: '+1 infantry/cavalry melee armor',
  8: '+1 infantry/cavalry melee armor',
  9: '+1 cavalry pierce armor',
  10: 'Unlocks new buildings, units and techs',
  11: 'Unlocks new buildings, units and techs',
  12: 'Unlocks new buildings, units and techs',
};

const AGE_LABEL: Record<Age, string> = { 0: 'Dark', 1: 'Feudal', 2: 'Castle', 3: 'Imperial' };
const RES_NAME = ['Food', 'Wood', 'Gold', 'Stone'];

// Which techs are researched at each building (mirrors contentDesign researchedAt); used to lay out
// research buttons. canResearch() gates availability; this only decides where each button appears.
const BUILDING_RESEARCH: Partial<Record<BuildingType, TechId[]>> = {
  0: [TechIdEnum.Loom, TechIdEnum.Wheelbarrow, TechIdEnum.FeudalAge, TechIdEnum.CastleAge, TechIdEnum.ImperialAge],
  6: [TechIdEnum.ManAtArmsUpgrade],
  9: [
    TechIdEnum.Forging,
    TechIdEnum.IronCasting,
    TechIdEnum.Fletching,
    TechIdEnum.BodkinArrow,
    TechIdEnum.ScaleMailArmor,
    TechIdEnum.ChainMailArmor,
    TechIdEnum.ScaleBardingArmor,
  ],
};

// Build menu offered when villagers are selected, with the minimum age gate (rest validated by the sim).
const BUILD_MENU: { building: BuildingType; minAge: Age }[] = [
  { building: BuildingTypeEnum.House, minAge: Age.Dark },
  { building: BuildingTypeEnum.Mill, minAge: Age.Dark },
  { building: BuildingTypeEnum.LumberCamp, minAge: Age.Dark },
  { building: BuildingTypeEnum.MiningCamp, minAge: Age.Dark },
  { building: BuildingTypeEnum.Farm, minAge: Age.Dark },
  { building: BuildingTypeEnum.Barracks, minAge: Age.Dark },
  { building: BuildingTypeEnum.TownCenter, minAge: Age.Dark },
  { building: BuildingTypeEnum.ArcheryRange, minAge: Age.Feudal },
  { building: BuildingTypeEnum.Stable, minAge: Age.Feudal },
  { building: BuildingTypeEnum.Blacksmith, minAge: Age.Feudal },
  { building: BuildingTypeEnum.Castle, minAge: Age.Castle },
];

// Positional command hotkeys (rows of the classic AoE II grid). BUILD deliberately skips 'a' so
// 'a'+right-click attack-move keeps working while villagers are selected.
const TRAIN_KEYS = ['q', 'w', 'e', 'r', 't'];
const RESEARCH_KEYS = ['z', 'x', 'c', 'v', 'b', 'n', 'm'];
const BUILD_KEYS = ['q', 'w', 'e', 'r', 't', 's', 'd', 'f', 'g', 'z', 'x'];

const TOAST_TTL = 40; // HUD updates (~4s at a 10Hz HUD cadence)

type ToastKind = 'info' | 'alert' | 'good';
interface Toast {
  text: string;
  ttl: number;
  kind: ToastKind;
  x?: number;
  y?: number;
}
interface TooltipData {
  title: string;
  cost?: Cost;
  lines: string[];
  req?: string;
  hotkey?: string;
}
interface CostChip {
  res: Resource;
  el: HTMLElement;
  need: number;
}
interface AffordanceRef {
  el: HTMLButtonElement;
  cost: Cost;
  costEls: CostChip[];
}
interface SelRef {
  hpFill: HTMLElement;
  hpText: HTMLElement;
  carryEl?: HTMLElement;
  buildBar?: HTMLElement;
  buildTicks: number;
  index: number;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function affordable(player: PlayerState, cost: Cost): boolean {
  const r = player.resources;
  return r[0] >= cost.food && r[1] >= cost.wood && r[2] >= cost.gold && r[3] >= cost.stone;
}

function formatClock(tick: number): string {
  const secs = Math.floor(tick / TICK_RATE);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// ---------------------------------------------------------------------------
// Procedural resource/pop/idle icons (memoized; blank if no 2D backend, e.g. jsdom).
// ---------------------------------------------------------------------------

type IconKind = 'food' | 'wood' | 'gold' | 'stone' | 'pop' | 'idle' | 'sword';
const iconCache = new Map<IconKind, HTMLCanvasElement>();

function makeIcon(kind: IconKind): HTMLCanvasElement {
  const cached = iconCache.get(kind);
  if (cached) return cached;
  const c = document.createElement('canvas');
  c.width = 36;
  c.height = 36;
  try {
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.scale(2, 2);
      drawIcon(ctx, kind);
    }
  } catch {
    // No 2D backend (jsdom) — leave the icon blank.
  }
  iconCache.set(kind, c);
  return c;
}

function drawIcon(ctx: CanvasRenderingContext2D, kind: IconKind): void {
  ctx.lineJoin = 'round';
  switch (kind) {
    case 'food':
      ctx.fillStyle = '#6fa14f';
      ctx.beginPath();
      ctx.moveTo(9, 3);
      ctx.lineTo(12, 6);
      ctx.lineTo(8, 6);
      ctx.closePath();
      ctx.fill();
      for (const [x, y] of [[6, 10], [12, 10], [9, 13]] as const) {
        ctx.fillStyle = '#c94f43';
        ctx.beginPath();
        ctx.arc(x, y, 3.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.beginPath();
        ctx.arc(x - 1, y - 1, 1, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    case 'wood':
      for (const y of [6, 11]) {
        ctx.fillStyle = '#7a5226';
        ctx.fillRect(3, y, 12, 4);
        ctx.strokeStyle = '#4d3418';
        ctx.lineWidth = 1;
        ctx.strokeRect(3, y, 12, 4);
        ctx.fillStyle = '#c9a066';
        ctx.beginPath();
        ctx.arc(4.5, y + 2, 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    case 'gold':
      for (const [x, y] of [[6, 11], [11, 11], [9, 7]] as const) {
        ctx.fillStyle = '#e7c64a';
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff3b0';
        ctx.beginPath();
        ctx.arc(x - 1, y - 1, 0.9, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    case 'stone':
      ctx.fillStyle = '#a7aeb8';
      ctx.fillRect(3, 8, 6, 6);
      ctx.fillRect(9, 6, 6, 6);
      ctx.fillStyle = '#d7dce2';
      ctx.fillRect(3, 8, 6, 2);
      ctx.fillRect(9, 6, 6, 2);
      break;
    case 'pop':
      ctx.fillStyle = '#c98a4a';
      ctx.beginPath();
      ctx.moveTo(9, 3);
      ctx.lineTo(15, 8);
      ctx.lineTo(3, 8);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#e8d4a0';
      ctx.fillRect(4, 8, 10, 7);
      ctx.fillStyle = '#5a3b22';
      ctx.fillRect(7, 10, 4, 5);
      break;
    case 'idle':
      ctx.fillStyle = '#e8d4a0';
      ctx.beginPath();
      ctx.arc(8, 6, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(3, 15);
      ctx.quadraticCurveTo(8, 9, 13, 15);
      ctx.fill();
      ctx.strokeStyle = '#f0d48a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(11, 3);
      ctx.lineTo(14, 3);
      ctx.lineTo(11, 6);
      ctx.lineTo(14, 6);
      ctx.stroke();
      break;
    case 'sword':
      ctx.strokeStyle = '#c7ccd1';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(4, 14);
      ctx.lineTo(13, 4);
      ctx.moveTo(14, 14);
      ctx.lineTo(5, 4);
      ctx.stroke();
      break;
  }
}

// ---------------------------------------------------------------------------
// Sprite portraits (procedural; reuse the renderer's memoized atlas). Blank when there is no 2D
// backend (jsdom) — the gilded CSS frame still shows. Sprites are touched only here (never at module
// import time) so a setCanvasFactory fake installed by tests takes effect first.
// ---------------------------------------------------------------------------

const portraitCache = new Map<string, HTMLCanvasElement>();

function portraitCanvas(
  kind: EntityKind,
  subtype: number,
  owner: PlayerId,
  sizeX = 0,
  sizeY = 0,
  px = 52,
): HTMLCanvasElement {
  const key = `${kind}:${subtype}:${owner}:${sizeX}:${sizeY}:${px}`;
  const cached = portraitCache.get(key);
  if (cached) return cached;
  const c = document.createElement('canvas');
  c.width = px * 2;
  c.height = px * 2;
  try {
    const ctx = c.getContext('2d');
    if (ctx) {
      const variant = kind === EntityKind.Building ? ((sizeX << 4) | sizeY) & 0xff : 0;
      const spr = getSprite(spriteKey(kind, subtype, owner, variant));
      const src = spr.canvas as HTMLCanvasElement;
      const sw = src.width;
      const sh = src.height;
      if (sw > 0 && sh > 0) {
        ctx.imageSmoothingEnabled = false;
        const s = Math.min((px * 2 - 8) / sw, (px * 2 - 8) / sh);
        const w = sw * s;
        const h = sh * s;
        ctx.drawImage(src as CanvasImageSource, (px * 2 - w) / 2, (px * 2 - h) / 2, w, h);
      }
    }
  } catch {
    // No usable 2D backend — leave the portrait blank.
  }
  portraitCache.set(key, c);
  return c;
}

interface EconInfo {
  perRes: number[]; // [food, wood, gold, stone] villager counts
  idle: number[]; // idle villager handles
  military: number;
}

class GameHud implements Hud {
  readonly root: HTMLElement;
  private readonly sink: CommandSink;
  private readonly localPlayer: PlayerId;
  private readonly view: ViewState;

  private readonly barEl: HTMLElement;
  private readonly resCellEls: HTMLElement[] = [];
  private readonly resValEls: HTMLElement[] = [];
  private readonly resVillEls: HTMLElement[] = [];
  private readonly agePipEls: HTMLElement[] = [];
  private readonly idleBtn: HTMLButtonElement;
  private readonly idleCountEl: HTMLElement;
  private readonly popEl: HTMLElement;
  private readonly popValEl: HTMLElement;
  private readonly ageEl: HTMLElement;
  private readonly agingEl: HTMLElement;
  private readonly agingLabel: HTMLElement;
  private readonly agingBar: HTMLElement;
  private readonly clockEl: HTMLElement;
  private readonly selectionEl: HTMLElement;
  private readonly commandEl: HTMLElement;
  private readonly toastEl: HTMLElement;
  private readonly overlayEl: HTMLElement;
  private readonly tooltipEl: HTMLElement;
  private readonly helpEl: HTMLElement;
  private readonly helpBtn: HTMLButtonElement;
  private readonly controlBtn: HTMLButtonElement;
  private readonly speedBtn: HTMLButtonElement;

  private contextSig = ' '; // force initial build
  private toasts: Toast[] = [];
  private ended = false;
  private autoPlay = true;
  private helpOpen = false;
  private simSpeed = MIN_SIM_SPEED;
  private onControlChange: ((auto: boolean) => void) | null = null;
  private onSpeedChange: ((speed: number) => void) | null = null;

  // Live refs refreshed per frame (set during a context rebuild).
  private affordances: AffordanceRef[] = [];
  private selRefs: SelRef[] = [];
  private hotkeyMap = new Map<string, HTMLButtonElement>();
  private queueHostEl: HTMLElement | null = null;
  private queueBuildingHandle = -1;
  private queueStructSig = ' ';
  private queueBars: HTMLElement[] = [];

  // Cross-frame state.
  private lastWorld: World | null = null;
  private lastIdle: number[] = [];
  private idleCycleIdx = -1;
  private lastHousedToastTick = -1e9;
  private lastBuiltToastTick = -1e9;
  private ageBannerTimer: ReturnType<typeof setTimeout> | null = null;
  private prevHp: Float32Array | null = null;
  private prevAlive: Uint8Array | null = null;
  private recentAlerts: { x: number; y: number; tick: number }[] = [];
  private lastAlert: { x: number; y: number } | null = null;
  private stats = { trained: 0, lost: 0, kills: 0, razed: 0, built: 0 };

  constructor(
    root: HTMLElement,
    localPlayer: PlayerId,
    sink: CommandSink,
    view: ViewState,
    onControlChange?: (auto: boolean) => void,
    onSpeedChange?: (speed: number) => void,
  ) {
    this.root = root;
    this.sink = sink;
    this.localPlayer = localPlayer;
    this.view = view;
    this.onControlChange = onControlChange ?? null;
    this.onSpeedChange = onSpeedChange ?? null;
    root.classList.add('hud');

    // ---- Top bar ----
    this.barEl = el('div', 'hud-topbar');
    const labels = ['Food', 'Wood', 'Gold', 'Stone'];
    const iconKinds: IconKind[] = ['food', 'wood', 'gold', 'stone'];
    for (let i = 0; i < 4; i++) {
      const cell = el('span', `hud-res hud-res-${i}`);
      cell.title = labels[i];
      const icon = el('span', 'hud-res-icon');
      icon.append(makeIcon(iconKinds[i]));
      const val = el('span', 'hud-res-val', '0');
      const vill = el('span', 'hud-res-vill', '');
      cell.append(icon, val, vill);
      this.resCellEls.push(cell);
      this.resValEls.push(val);
      this.resVillEls.push(vill);
      this.barEl.append(cell);
    }

    this.idleBtn = el('button', 'hud-idle');
    this.idleBtn.type = 'button';
    this.idleBtn.title = 'Idle villagers — click to cycle (.), Shift-click selects all (,)';
    const idleIcon = el('span', 'hud-idle-icon');
    idleIcon.append(makeIcon('idle'));
    this.idleCountEl = el('span', 'hud-idle-count', '0');
    this.idleBtn.append(idleIcon, this.idleCountEl);
    this.idleBtn.addEventListener('click', (e) => this.onIdleClick(e));
    this.barEl.append(this.idleBtn);

    this.popEl = el('span', 'hud-pop');
    this.popEl.title = 'Population / housing cap';
    const popIcon = el('span', 'hud-pop-icon');
    popIcon.append(makeIcon('pop'));
    this.popValEl = el('span', 'hud-pop-val', '0/0');
    this.popEl.append(popIcon, this.popValEl);
    this.barEl.append(this.popEl);

    this.ageEl = el('span', 'hud-age', 'Dark Age');
    this.barEl.append(this.ageEl);

    // Persistent AoE-style age insignia. A SIBLING of ageEl (whose textContent is rewritten each
    // frame, which would otherwise wipe child pips). Filled up to the current age in renderTopBar.
    const agePips = el('span', 'hud-age-pips');
    for (let k = 0; k < 4; k++) {
      const pip = el('span', 'hud-age-pip');
      this.agePipEls.push(pip);
      agePips.append(pip);
    }
    this.barEl.append(agePips);

    this.agingEl = el('span', 'hud-aging hud-hidden');
    this.agingLabel = el('span', 'hud-aging-label', '');
    const agingTrack = el('span', 'hud-progress hud-aging-track');
    this.agingBar = el('span', 'hud-progress-bar');
    agingTrack.append(this.agingBar);
    this.agingEl.append(this.agingLabel, agingTrack);
    this.barEl.append(this.agingEl);

    this.clockEl = el('span', 'hud-clock', '0:00');
    this.barEl.append(this.clockEl);

    const topRight = el('div', 'hud-topbar-right');
    this.helpBtn = el('button', 'hud-control hud-help-btn', '?');
    this.helpBtn.type = 'button';
    this.helpBtn.title = 'Help / hotkeys (F1)';
    this.helpBtn.addEventListener('click', () => this.toggleHelp());
    this.speedBtn = el('button', 'hud-control hud-speed', `${MIN_SIM_SPEED}x`);
    this.speedBtn.type = 'button';
    this.speedBtn.title = 'Click to increase simulation speed (1x–5x)';
    this.speedBtn.addEventListener('click', () => this.cycleSimSpeed());
    this.controlBtn = el('button', 'hud-control hud-control-auto', 'Auto Play');
    this.controlBtn.type = 'button';
    this.controlBtn.title = 'AI is controlling your civilization — click to take manual control';
    this.controlBtn.addEventListener('click', () => this.setAutoPlay(!this.autoPlay));
    topRight.append(this.helpBtn, this.speedBtn, this.controlBtn);
    this.barEl.append(topRight);

    // ---- Bottom panels ----
    const bottom = el('div', 'hud-bottom');
    this.selectionEl = el('div', 'hud-selection');
    this.commandEl = el('div', 'hud-commands');
    bottom.append(this.selectionEl, this.commandEl);

    this.toastEl = el('div', 'hud-toasts');
    this.overlayEl = el('div', 'hud-overlay hud-hidden');
    this.tooltipEl = el('div', 'hud-tooltip hud-hidden');
    this.helpEl = this.buildHelpPanel();

    root.append(this.barEl, bottom, this.toastEl, this.tooltipEl, this.helpEl, this.overlayEl);
    this.syncControlButton();
    this.syncSpeedButton();

    // Registered here (constructor runs before input.attach in game.ts) so this listener fires first
    // and can preventDefault() to hand keys off to the grid before the input controller sees them.
    // Lives for the page lifetime (game.ts never destroys the HUD).
    window.addEventListener('keydown', this.onHudKeyDown);
  }

  // ---- sim speed / control buttons (unchanged behavior) ----

  setSimSpeed(speed: number): void {
    const clamped = clampSimSpeed(speed);
    if (this.simSpeed === clamped) return;
    this.simSpeed = clamped;
    this.syncSpeedButton();
    this.onSpeedChange?.(clamped);
  }

  private cycleSimSpeed(): void {
    const next = this.simSpeed >= MAX_SIM_SPEED ? MIN_SIM_SPEED : this.simSpeed + 1;
    this.setSimSpeed(next);
  }

  private syncSpeedButton(): void {
    this.speedBtn.textContent = `${this.simSpeed}x`;
    this.speedBtn.title = `Simulation speed ${this.simSpeed}x — click to cycle (${MIN_SIM_SPEED}x–${MAX_SIM_SPEED}x)`;
    this.speedBtn.classList.toggle('hud-speed-fast', this.simSpeed >= 3);
  }

  setAutoPlay(auto: boolean): void {
    if (this.autoPlay === auto) return;
    this.autoPlay = auto;
    if (!auto) {
      this.view.selection = [];
      this.view.ghost = null;
    }
    this.contextSig = '';
    this.syncControlButton();
    this.onControlChange?.(auto);
  }

  private syncControlButton(): void {
    if (this.autoPlay) {
      this.controlBtn.textContent = 'Auto Play';
      this.controlBtn.title = 'AI is controlling your civilization — click to take manual control';
      this.controlBtn.classList.remove('hud-control-manual');
      this.controlBtn.classList.add('hud-control-auto');
      this.root.classList.add('hud-autoplay');
      this.root.classList.remove('hud-manual');
    } else {
      this.controlBtn.textContent = 'Manual';
      this.controlBtn.title = 'You are in control — click to return to auto play';
      this.controlBtn.classList.remove('hud-control-auto');
      this.controlBtn.classList.add('hud-control-manual');
      this.root.classList.remove('hud-autoplay');
      this.root.classList.add('hud-manual');
    }
  }

  // ---- main update ----

  update(world: World, view: ViewState, events: GameEvent[]): void {
    const player = world.players[this.localPlayer];
    if (!player) return;
    this.lastWorld = world;

    this.ingestEvents(events, world);
    this.detectAttacks(world);
    const econ = this.scanEconomy(world);
    this.renderTopBar(world, player, econ);
    this.renderAgeProgress(world);

    const sig = this.contextSignature(player);
    if (sig !== this.contextSig) {
      this.contextSig = sig;
      this.rebuildSelection(world);
      this.rebuildCommands(world, player);
    }

    this.refreshDynamic(world, player);
    this.renderToasts();
  }

  // ---- economy scan (per-resource villager counts + idle list) ----

  private scanEconomy(world: World): EconInfo {
    const comp = world.comp;
    const em = world.em;
    const perRes = [0, 0, 0, 0];
    const idle: number[] = [];
    let military = 0;
    const cap = comp.capacity;
    for (let i = 0; i < cap; i++) {
      if (em.alive[i] !== 1) continue;
      if (comp.owner[i] !== this.localPlayer) continue;
      if (comp.kind[i] !== EntityKind.Unit) continue;
      const st = comp.subtype[i];
      if (st === UnitTypeEnum.Villager) {
        const ot = comp.orderType[i];
        if (ot === OrderType.GatherTile) {
          const tile = comp.orderTile[i];
          if (tile >= 0) {
            const r = nodeToResource(world.map.resourceType[tile] as ResourceNode);
            if (r !== -1) perRes[r]++;
          }
        } else if (ot === OrderType.GatherEntity) {
          perRes[Resource.Food]++; // sheep or farm — both food
        } else if (ot === OrderType.ReturnResource) {
          const r = comp.carryType[i];
          if (r >= 0 && r < 4) perRes[r]++;
        } else if (ot === OrderType.Idle) {
          idle.push(em.handleFor(i));
        }
      } else if (st !== UnitTypeEnum.Sheep) {
        military++;
      }
    }
    return { perRes, idle, military };
  }

  // ---- top bar ----

  private renderTopBar(world: World, player: PlayerState, econ: EconInfo): void {
    const r = player.resources;
    for (let i = 0; i < 4; i++) {
      const t = String(Math.floor(r[i]));
      if (this.resValEls[i].textContent !== t) this.resValEls[i].textContent = t;
      const v = econ.perRes[i];
      const vt = v > 0 ? `·${v}` : '';
      if (this.resVillEls[i].textContent !== vt) this.resVillEls[i].textContent = vt;
      // Low-resource warning on the CELL (never on the .hud-res-vill span, whose order is test-pinned).
      this.resCellEls[i].classList.toggle('hud-res-low', Math.floor(r[i]) < 50);
    }

    const pop = `${player.population}/${player.populationCap}`;
    if (this.popValEl.textContent !== pop) this.popValEl.textContent = pop;
    const full = player.population >= player.populationCap;
    const near = !full && player.populationCap - player.population <= 3 && player.populationCap < POP_CAP_MAX;
    this.popEl.classList.toggle('hud-pop-full', full);
    this.popEl.classList.toggle('hud-pop-near', near);
    if (full && !this.autoPlay && world.tick - this.lastHousedToastTick >= 600) {
      this.lastHousedToastTick = world.tick;
      this.pushToast('Build more houses!', 'alert');
    }

    const age = `${AGE_LABEL[player.age]} Age`;
    if (this.ageEl.textContent !== age) this.ageEl.textContent = age;
    for (let k = 0; k < this.agePipEls.length; k++) {
      this.agePipEls[k].classList.toggle('hud-age-pip-on', k <= player.age);
    }

    const clock = formatClock(world.tick);
    if (this.clockEl.textContent !== clock) this.clockEl.textContent = clock;

    // Idle badge/button.
    this.lastIdle = econ.idle;
    const n = econ.idle.length;
    const it = String(n);
    if (this.idleCountEl.textContent !== it) this.idleCountEl.textContent = it;
    this.idleBtn.classList.toggle('hud-idle-some', n > 0);
    this.idleBtn.classList.toggle('hud-hidden', n === 0 && this.autoPlay);
    this.idleBtn.disabled = this.autoPlay || n === 0;
  }

  private renderAgeProgress(world: World): void {
    const comp = world.comp;
    const em = world.em;
    const cap = comp.capacity;
    let found: { tech: TechId; ticksLeft: number; totalTicks: number } | null = null;
    for (let i = 0; i < cap && !found; i++) {
      if (em.alive[i] !== 1) continue;
      if (comp.owner[i] !== this.localPlayer) continue;
      if (comp.kind[i] !== EntityKind.Building) continue;
      const q = comp.queue[i];
      if (!q || q.length === 0) continue;
      for (const it of q) {
        if (
          it.kind === 'tech' &&
          (it.tech === TechIdEnum.FeudalAge || it.tech === TechIdEnum.CastleAge || it.tech === TechIdEnum.ImperialAge)
        ) {
          found = { tech: it.tech, ticksLeft: it.ticksLeft, totalTicks: it.totalTicks };
          break;
        }
      }
    }
    if (found) {
      this.agingEl.classList.remove('hud-hidden');
      const label = TECH_LABEL[found.tech];
      if (this.agingLabel.textContent !== label) this.agingLabel.textContent = label;
      const frac = found.totalTicks > 0 ? 1 - found.ticksLeft / found.totalTicks : 0;
      const pct = `${Math.max(0, Math.min(100, frac * 100)).toFixed(0)}%`;
      if (this.agingBar.style.width !== pct) this.agingBar.style.width = pct;
    } else {
      this.agingEl.classList.add('hud-hidden');
    }
  }

  // ---- context signature (structural rebuild trigger) ----

  private contextSignature(player: PlayerState): string {
    return `${this.view.selection.join(',')}|${player.age}|${player.statsVersion}`;
  }

  // ---- selection panel ----

  private rebuildSelection(world: World): void {
    const comp = world.comp;
    const em = world.em;
    this.selectionEl.replaceChildren();
    this.selRefs = [];

    const indices: number[] = [];
    for (const h of this.view.selection) {
      const i = resolveHandle(em, h);
      if (i >= 0) indices.push(i);
    }
    if (indices.length === 0) {
      this.selectionEl.append(el('div', 'hud-hint', 'Nothing selected'));
      return;
    }
    if (indices.length === 1) {
      this.buildSingleSelection(world, indices[0]);
      return;
    }
    this.buildMultiSelection(world, indices);
  }

  private buildSingleSelection(world: World, i: number): void {
    const comp = world.comp;
    const isUnit = comp.kind[i] === EntityKind.Unit;
    const owner = comp.owner[i] as PlayerId;
    const subtype = comp.subtype[i];
    const name = isUnit ? UNIT_LABEL[subtype as UnitType].name : BUILDING_LABEL[subtype as BuildingType];

    const panel = el('div', 'hud-sel-single');
    const header = el('div', 'hud-sel-header');
    const portraitWrap = el('div', 'hud-portrait');
    portraitWrap.append(
      portraitCanvas(
        isUnit ? EntityKind.Unit : EntityKind.Building,
        subtype,
        owner,
        isUnit ? 0 : comp.sizeX[i],
        isUnit ? 0 : comp.sizeY[i],
        52,
      ),
    );

    const meta = el('div', 'hud-sel-meta');
    const nameEl = el('div', 'hud-sel-name', name);
    if (owner !== this.localPlayer) nameEl.style.color = PLAYER_COLORS[owner] ?? PLAYER_COLORS[0];
    meta.append(nameEl);

    const hpbar = el('div', 'hud-hpbar');
    const hpFill = el('div', 'hud-hpbar-fill');
    const hpText = el('span', 'hud-hpbar-text', '');
    hpbar.append(hpFill, hpText);
    meta.append(hpbar);

    let carryEl: HTMLElement | undefined;
    if (isUnit) {
      const line = `Atk ${Math.round(comp.attack[i])} · Armor ${Math.round(comp.meleeArmor[i])}/${Math.round(comp.pierceArmor[i])} · Range ${Math.round(comp.attackRange[i])} · LOS ${Math.round(comp.los[i])}`;
      meta.append(el('div', 'hud-sel-stat', line));
      if (subtype === UnitTypeEnum.Villager) {
        carryEl = el('div', 'hud-sel-stat hud-sel-carry hud-hidden', '');
        meta.append(carryEl);
      }
    } else {
      const line = `Armor ${Math.round(comp.meleeArmor[i])}/${Math.round(comp.pierceArmor[i])} · LOS ${Math.round(comp.los[i])}`;
      meta.append(el('div', 'hud-sel-stat', line));
    }

    header.append(portraitWrap, meta);
    panel.append(header);

    let buildBar: HTMLElement | undefined;
    let buildTicks = 0;
    if (!isUnit && (comp.flags[i] & FLAG_UNDER_CONSTRUCTION) !== 0) {
      buildTicks = resolveBuildingStats(world, owner, subtype as BuildingType).buildTicks;
      const wrap = el('div', 'hud-sel-build');
      wrap.append(el('span', undefined, 'Constructing'));
      const track = el('span', 'hud-progress');
      buildBar = el('span', 'hud-progress-bar');
      track.append(buildBar);
      wrap.append(track);
      panel.append(wrap);
    }

    this.selectionEl.append(panel);
    this.selRefs.push({ hpFill, hpText, carryEl, buildBar, buildTicks, index: i });
  }

  private buildMultiSelection(world: World, indices: number[]): void {
    const comp = world.comp;
    const em = world.em;
    const groups = new Map<number, { subtype: number; isUnit: boolean; owner: PlayerId; handles: number[] }>();
    for (const i of indices) {
      const isUnit = comp.kind[i] === EntityKind.Unit;
      const key = isUnit ? comp.subtype[i] : 100 + comp.subtype[i];
      let g = groups.get(key);
      if (!g) {
        g = { subtype: comp.subtype[i], isUnit, owner: comp.owner[i] as PlayerId, handles: [] };
        groups.set(key, g);
      }
      g.handles.push(em.handleFor(i));
    }

    this.selectionEl.append(el('div', 'hud-sel-name', `${indices.length} selected`));
    const grid = el('div', 'hud-sel-grid');
    for (const g of groups.values()) {
      const name = g.isUnit ? UNIT_LABEL[g.subtype as UnitType].name : BUILDING_LABEL[g.subtype as BuildingType];
      const cell = el('button', 'hud-sel-cell');
      cell.type = 'button';
      cell.title = `${name} ×${g.handles.length} — click to select only these; Shift-click to drop them`;
      cell.disabled = this.autoPlay;
      const pw = el('span', 'hud-portrait-sm');
      const fp = g.isUnit ? null : BUILDING_FOOTPRINT[g.subtype as BuildingType];
      pw.append(
        portraitCanvas(
          g.isUnit ? EntityKind.Unit : EntityKind.Building,
          g.subtype,
          g.owner,
          fp ? fp.sizeX : 0,
          fp ? fp.sizeY : 0,
          34,
        ),
      );
      cell.append(pw, el('span', 'hud-count', `×${g.handles.length}`));
      const handles = g.handles.slice().sort((a, b) => a - b);
      cell.addEventListener('click', (ev) => {
        if (this.autoPlay) return;
        if (ev.shiftKey) {
          const set = new Set(this.view.selection);
          for (const h of handles) set.delete(h);
          this.view.selection = Array.from(set).sort((a, b) => a - b);
        } else {
          this.view.selection = handles.slice();
        }
      });
      grid.append(cell);
    }
    this.selectionEl.append(grid);
  }

  // ---- command panel ----

  private rebuildCommands(world: World, player: PlayerState): void {
    const comp = world.comp;
    const em = world.em;
    this.commandEl.replaceChildren();
    this.affordances = [];
    this.hotkeyMap.clear();
    this.queueHostEl = null;
    this.queueBuildingHandle = -1;
    this.queueStructSig = ' ';
    this.queueBars = [];

    // Classify the selection into own villagers / own buildings.
    let primaryBuildingHandle = -1;
    let primaryBuildingIdx = -1;
    let hasVillager = false;
    for (const h of this.view.selection) {
      const i = resolveHandle(em, h);
      if (i < 0 || comp.owner[i] !== this.localPlayer) continue;
      if (comp.kind[i] === EntityKind.Building) {
        if (primaryBuildingIdx < 0 || i < primaryBuildingIdx) {
          primaryBuildingIdx = i;
          primaryBuildingHandle = h;
        }
      } else if (comp.kind[i] === EntityKind.Unit && comp.subtype[i] === UnitTypeEnum.Villager) {
        hasVillager = true;
      }
    }

    if (primaryBuildingIdx >= 0) {
      this.buildBuildingCommands(world, primaryBuildingHandle, primaryBuildingIdx);
    } else if (hasVillager) {
      this.buildVillagerCommands(world, player);
    }
  }

  private buildBuildingCommands(world: World, handle: number, index: number): void {
    const building = world.comp.subtype[index] as BuildingType;

    // Train buttons.
    const trainRow = el('div', 'hud-btn-row');
    let ti = 0;
    let anyTrain = false;
    for (let u = 0; u < UNIT_TYPE_COUNT; u++) {
      if (!canTrain(world, this.localPlayer, building, u as UnitType)) continue;
      anyTrain = true;
      const cost = resolveCost(world, this.localPlayer, { unit: u as UnitType });
      const key = TRAIN_KEYS[ti++];
      this.addCommandButton(trainRow, {
        label: UNIT_LABEL[u as UnitType].name,
        hotkey: key,
        cost,
        icon: portraitCanvas(EntityKind.Unit, u, this.localPlayer, 0, 0, 28),
        tooltip: this.unitTooltip(world, u as UnitType, cost, key),
        onTrigger: () => this.sink({ type: 'train', player: this.localPlayer, building: handle, unit: u as UnitType }),
      });
    }
    if (anyTrain) this.commandEl.append(el('div', 'hud-panel-title', 'Train'), trainRow);

    // Research buttons.
    const techs = BUILDING_RESEARCH[building];
    if (techs) {
      const resRow = el('div', 'hud-btn-row');
      let ri = 0;
      let anyRes = false;
      for (const tech of techs) {
        if (!canResearch(world, this.localPlayer, tech)) continue;
        anyRes = true;
        const cost = resolveCost(world, this.localPlayer, { tech });
        const key = RESEARCH_KEYS[ri++];
        const isAge = tech === TechIdEnum.FeudalAge || tech === TechIdEnum.CastleAge || tech === TechIdEnum.ImperialAge;
        this.addCommandButton(resRow, {
          label: TECH_LABEL[tech],
          hotkey: key,
          cost,
          tooltip: this.techTooltip(tech, cost, key),
          ageBtn: isAge,
          onTrigger: () => this.sink({ type: 'research', player: this.localPlayer, building: handle, tech }),
        });
      }
      if (anyRes) this.commandEl.append(el('div', 'hud-panel-title', 'Research'), resRow);
    }

    // Production queue host (filled per-frame) + rally hint for a completed building.
    this.queueBuildingHandle = handle;
    this.queueHostEl = el('div', 'hud-queue');
    this.commandEl.append(this.queueHostEl);
    if ((world.comp.flags[index] & FLAG_UNDER_CONSTRUCTION) === 0) {
      this.commandEl.append(el('div', 'hud-hint', 'Right-click terrain to set the rally point'));
    }
  }

  private buildVillagerCommands(world: World, player: PlayerState): void {
    const row = el('div', 'hud-btn-row');
    let bi = 0;
    for (const entry of BUILD_MENU) {
      const cost = resolveCost(world, this.localPlayer, { building: entry.building });
      const key = BUILD_KEYS[bi++];
      const ageOk = player.age >= entry.minAge;
      const fp = BUILDING_FOOTPRINT[entry.building];
      this.addCommandButton(row, {
        label: BUILDING_LABEL[entry.building],
        hotkey: key,
        cost,
        icon: portraitCanvas(EntityKind.Building, entry.building, this.localPlayer, fp.sizeX, fp.sizeY, 28),
        tooltip: this.buildingTooltip(
          world,
          entry.building,
          cost,
          key,
          ageOk ? undefined : `Requires ${AGE_LABEL[entry.minAge]} Age`,
        ),
        ageGated: !ageOk,
        onTrigger: () => this.startPlacement(entry.building, entry.minAge, player),
      });
    }
    this.commandEl.append(el('div', 'hud-panel-title', 'Build'), row);
  }

  private startPlacement(building: BuildingType, minAge: Age, player: PlayerState): void {
    if (player.age < minAge) return;
    const fp = BUILDING_FOOTPRINT[building];
    this.view.ghost = {
      building,
      tileX: Math.floor(this.view.camX),
      tileY: Math.floor(this.view.camY),
      valid: false,
      sizeX: fp.sizeX,
      sizeY: fp.sizeY,
      tileValid: new Uint8Array(fp.sizeX * fp.sizeY),
    };
  }

  private addCommandButton(
    row: HTMLElement,
    opts: {
      label: string;
      hotkey?: string;
      cost?: Cost;
      icon?: HTMLCanvasElement | null;
      tooltip: TooltipData;
      onTrigger: () => void;
      ageGated?: boolean;
      ageBtn?: boolean;
    },
  ): void {
    const b = el('button', 'hud-btn');
    b.type = 'button';
    if (opts.icon) {
      const ic = el('span', 'hud-btn-icon');
      ic.append(opts.icon);
      b.append(ic);
    }
    if (opts.hotkey) b.append(el('span', 'hud-btn-hotkey', opts.hotkey.toUpperCase()));
    b.append(el('span', 'hud-btn-main', opts.label));
    const costEls: CostChip[] = [];
    if (opts.cost) {
      const cw = el('span', 'hud-btn-cost');
      appendCostChips(cw, opts.cost, costEls);
      b.append(cw);
    }
    if (opts.ageBtn) b.classList.add('hud-btn-age');
    b.addEventListener('click', () => {
      if (b.disabled) return;
      opts.onTrigger();
    });
    this.attachTooltip(b, opts.tooltip);
    row.append(b);

    if (opts.ageGated) {
      b.classList.add('hud-btn-locked'); // CSS padlock badge in the corner
      b.disabled = true; // gated by age regardless of resources/mode
    } else {
      b.disabled = this.autoPlay;
      if (opts.cost) this.affordances.push({ el: b, cost: opts.cost, costEls });
      if (opts.hotkey) this.hotkeyMap.set(opts.hotkey, b);
    }
  }

  // ---- tooltips ----

  private unitTooltip(world: World, unit: UnitType, cost: Cost, hotkey: string): TooltipData {
    const rs = resolveUnitStats(world, this.localPlayer, unit);
    const dmgType = rs.attackIsPierce ? 'pierce' : 'melee';
    return {
      title: UNIT_LABEL[unit].name,
      cost,
      lines: [
        `HP ${Math.round(rs.hp)}`,
        `Atk ${Math.round(rs.attack)} (${dmgType})`,
        `Range ${rs.attackRange.toFixed(1)}`,
        `Armor ${Math.round(rs.meleeArmor)}/${Math.round(rs.pierceArmor)}`,
        `Speed ${(rs.speedPerTick * TICK_RATE).toFixed(1)} tiles/s`,
      ],
      hotkey,
    };
  }

  private techTooltip(tech: TechId, cost: Cost, hotkey: string): TooltipData {
    const blurb = TECH_BLURB[tech];
    return { title: TECH_LABEL[tech], cost, lines: blurb ? [blurb] : [], hotkey };
  }

  private buildingTooltip(
    world: World,
    building: BuildingType,
    cost: Cost,
    hotkey: string,
    req?: string,
  ): TooltipData {
    const bs = resolveBuildingStats(world, this.localPlayer, building);
    const lines = [`HP ${Math.round(bs.hp)}`];
    if (bs.popProvided > 0) lines.push(`Pop +${bs.popProvided}`);
    if (bs.dropOff > 0) {
      const drops: string[] = [];
      for (let r = 0; r < 4; r++) if (bs.dropOff & (1 << r)) drops.push(RES_NAME[r]);
      if (drops.length) lines.push(`Drop-off: ${drops.join('/')}`);
    }
    lines.push(`Footprint ${bs.sizeX}×${bs.sizeY}`);
    return { title: BUILDING_LABEL[building], cost, lines, req, hotkey };
  }

  private attachTooltip(btn: HTMLButtonElement, data: TooltipData): void {
    const show = (): void => this.showTooltip(btn, data);
    const hide = (): void => this.hideTooltip();
    btn.addEventListener('mouseenter', show);
    btn.addEventListener('mouseleave', hide);
    btn.addEventListener('focus', show);
    btn.addEventListener('blur', hide);
  }

  private showTooltip(btn: HTMLButtonElement, data: TooltipData): void {
    const t = this.tooltipEl;
    t.replaceChildren();
    t.append(el('div', 'hud-tt-title', data.title));
    if (data.cost) {
      const cw = el('div', 'hud-tt-cost');
      appendCostChips(cw, data.cost, []);
      t.append(cw);
    }
    for (const line of data.lines) t.append(el('div', 'hud-tt-line', line));
    if (data.req) t.append(el('div', 'hud-tt-req', data.req));
    if (data.hotkey) t.append(el('div', 'hud-tt-line', `Hotkey: ${data.hotkey.toUpperCase()}`));
    t.classList.remove('hud-hidden');
    // Position above the button, clamped to the root's left edge.
    const br = btn.getBoundingClientRect();
    const rr = this.root.getBoundingClientRect();
    const left = Math.max(8, br.left - rr.left);
    t.style.left = `${left}px`;
    t.style.top = `${br.top - rr.top - t.offsetHeight - 8}px`;
  }

  private hideTooltip(): void {
    this.tooltipEl.classList.add('hud-hidden');
  }

  // ---- per-frame dynamic refresh (no structural rebuild) ----

  private refreshDynamic(world: World, player: PlayerState): void {
    const comp = world.comp;
    const em = world.em;

    for (const ref of this.selRefs) {
      const i = ref.index;
      if (em.alive[i] !== 1) continue;
      const maxHp = comp.maxHp[i] || 1;
      const frac = Math.max(0, Math.min(1, comp.hp[i] / maxHp));
      const pct = `${(frac * 100).toFixed(0)}%`;
      if (ref.hpFill.style.width !== pct) ref.hpFill.style.width = pct;
      const cls = frac > 0.66 ? 'hud-hp-hi' : frac > 0.33 ? 'hud-hp-mid' : 'hud-hp-lo';
      if (ref.hpFill.dataset.hp !== cls) {
        ref.hpFill.classList.remove('hud-hp-hi', 'hud-hp-mid', 'hud-hp-lo');
        ref.hpFill.classList.add(cls);
        ref.hpFill.dataset.hp = cls;
      }
      const txt = `${Math.ceil(comp.hp[i])}/${Math.round(comp.maxHp[i])}`;
      if (ref.hpText.textContent !== txt) ref.hpText.textContent = txt;

      if (ref.carryEl) {
        const amt = comp.carryAmount[i];
        if (amt > 0) {
          const ct = `Carrying ${Math.floor(amt)} ${RES_NAME[comp.carryType[i]] ?? ''}`;
          if (ref.carryEl.textContent !== ct) ref.carryEl.textContent = ct;
          ref.carryEl.classList.remove('hud-hidden');
        } else if (!ref.carryEl.classList.contains('hud-hidden')) {
          ref.carryEl.classList.add('hud-hidden');
        }
      }

      if (ref.buildBar && ref.buildTicks > 0) {
        const bf = Math.max(0, Math.min(1, comp.buildProgress[i] / ref.buildTicks));
        const bp = `${(bf * 100).toFixed(0)}%`;
        if (ref.buildBar.style.width !== bp) ref.buildBar.style.width = bp;
      }
    }

    for (const a of this.affordances) {
      const canAfford = affordable(player, a.cost);
      const disabled = this.autoPlay || !canAfford;
      if (a.el.disabled !== disabled) a.el.disabled = disabled;
      a.el.classList.toggle('hud-btn-unaffordable', !this.autoPlay && !canAfford);
      for (const ce of a.costEls) {
        ce.el.classList.toggle('hud-cost-no', player.resources[ce.res] < ce.need);
      }
    }

    if (this.queueHostEl) this.renderQueue(world, this.queueBuildingHandle);
  }

  private renderQueue(world: World, buildingHandle: number): void {
    const host = this.queueHostEl;
    if (!host) return;
    const idx = resolveHandle(world.em, buildingHandle);
    const queue = idx >= 0 ? world.comp.queue[idx] : null;
    const items = queue ?? [];

    const structSig = items.map((it) => (it.kind === 'unit' ? `u${it.unit}` : `t${it.tech}`)).join(',');
    if (structSig !== this.queueStructSig) {
      this.queueStructSig = structSig;
      host.replaceChildren();
      this.queueBars = [];
      for (let k = 0; k < items.length; k++) {
        const it = items[k];
        const label = it.kind === 'unit' ? UNIT_LABEL[it.unit].glyph : TECH_LABEL[it.tech];
        const rowEl = el('div', 'hud-queue-item');
        rowEl.append(el('span', 'hud-queue-label', label));
        const track = el('div', 'hud-progress');
        const bar = el('div', 'hud-progress-bar');
        track.append(bar);
        rowEl.append(track);
        this.queueBars.push(bar);
        const cancel = el('button', 'hud-btn hud-cancel', 'x');
        cancel.type = 'button';
        cancel.title = 'Cancel';
        cancel.disabled = this.autoPlay;
        const queueIndex = k;
        cancel.addEventListener('click', () => {
          if (this.autoPlay) return;
          this.sink({ type: 'cancelProduction', player: this.localPlayer, building: buildingHandle, queueIndex });
        });
        rowEl.append(cancel);
        host.append(rowEl);
      }
    }
    for (let k = 0; k < items.length && k < this.queueBars.length; k++) {
      const it = items[k];
      const frac = it.totalTicks > 0 ? 1 - it.ticksLeft / it.totalTicks : 0;
      const pct = `${Math.max(0, Math.min(100, frac * 100)).toFixed(0)}%`;
      if (this.queueBars[k].style.width !== pct) this.queueBars[k].style.width = pct;
    }
  }

  // ---- idle villager button ----

  private onIdleClick(e: MouseEvent): void {
    if (this.autoPlay || !this.lastWorld) return;
    const idle = findIdleVillagers(this.lastWorld, this.localPlayer);
    if (idle.length === 0) return;
    if (e.shiftKey) {
      this.view.selection = idle.slice();
      this.centerCamera(this.lastWorld, idle[0]);
    } else {
      this.idleCycleIdx = (this.idleCycleIdx + 1) % idle.length;
      const h = idle[this.idleCycleIdx];
      this.view.selection = [h];
      this.centerCamera(this.lastWorld, h);
    }
  }

  private centerCamera(world: World, handle: number): void {
    const i = resolveHandle(world.em, handle);
    if (i < 0) return;
    this.view.camX = world.comp.posX[i];
    this.view.camY = world.comp.posY[i];
  }

  // ---- under-attack alerts + minimap pings ----

  private detectAttacks(world: World): void {
    const comp = world.comp;
    const em = world.em;
    const cap = comp.capacity;
    if (!this.prevHp || this.prevHp.length !== cap || !this.prevAlive) {
      this.prevHp = new Float32Array(cap);
      this.prevAlive = new Uint8Array(cap);
      this.snapshot(world);
      return;
    }
    const prevHp = this.prevHp;
    const prevAlive = this.prevAlive;
    for (let i = 0; i < cap; i++) {
      if (
        em.alive[i] === 1 &&
        comp.owner[i] === this.localPlayer &&
        prevAlive[i] === 1 &&
        comp.hp[i] < prevHp[i] - 0.01
      ) {
        this.raiseAlert(world, comp.posX[i], comp.posY[i], false);
      }
    }
    this.snapshot(world);
  }

  private snapshot(world: World): void {
    const comp = world.comp;
    const em = world.em;
    const cap = comp.capacity;
    const prevHp = this.prevHp!;
    const prevAlive = this.prevAlive!;
    for (let i = 0; i < cap; i++) {
      prevHp[i] = comp.hp[i];
      prevAlive[i] = em.alive[i] === 1 && comp.owner[i] === this.localPlayer ? 1 : 0;
    }
  }

  private raiseAlert(world: World, x: number, y: number, death: boolean): void {
    for (const a of this.recentAlerts) {
      const dx = a.x - x;
      const dy = a.y - y;
      if (dx * dx + dy * dy <= 256 && a.tick > world.tick - 200) return; // clustered/suppressed
    }
    this.recentAlerts.push({ x, y, tick: world.tick });
    this.recentAlerts = this.recentAlerts.filter((a) => a.tick > world.tick - 600);
    this.lastAlert = { x, y };
    this.pushToast(death ? 'Unit lost!' : "You're under attack!", 'alert', x, y);
    this.pingMinimap(x, y);
  }

  private jumpToLastAlert(): void {
    if (!this.lastAlert) return;
    this.view.camX = this.lastAlert.x;
    this.view.camY = this.lastAlert.y;
  }

  private pingMinimap(wx: number, wy: number): void {
    const host = typeof document !== 'undefined' ? document.getElementById('minimap-pings') : null;
    if (!host) return;
    const W = host.clientWidth || 200;
    const H = host.clientHeight || 200;
    const size = this.lastWorld ? this.lastWorld.mapSize : 96;
    const denom = size > 1 ? 2 * (size - 1) : 1;
    const nx = (wx - wy + (size - 1)) / denom;
    const ny = (wx + wy) / denom;
    const ping = el('div', 'hud-ping');
    ping.style.left = `${nx * W}px`;
    ping.style.top = `${ny * H}px`;
    ping.addEventListener('animationend', () => ping.remove());
    host.append(ping);
    while (host.childElementCount > 6) host.firstElementChild?.remove();
  }

  // ---- toasts + events + overlay ----

  private ingestEvents(events: GameEvent[], world: World): void {
    for (const e of events) {
      switch (e.type) {
        case 'ageAdvanced':
          if (e.player === this.localPlayer) {
            this.pushToast(`Advanced to the ${AGE_LABEL[e.age]} Age`, 'good');
            this.showAgeBanner(e.age);
          } else {
            this.pushToast(`Player ${e.player} has advanced to the ${AGE_LABEL[e.age]} Age`, 'info');
          }
          break;
        case 'researchComplete':
          if (e.player === this.localPlayer) this.pushToast(`Researched ${TECH_LABEL[e.tech]}`, 'good');
          break;
        case 'spawned':
          if (e.owner === this.localPlayer && e.kind === EntityKind.Unit && e.subtype !== UnitTypeEnum.Sheep) {
            this.stats.trained++;
          }
          break;
        case 'died':
          if (e.kind === EntityKind.Unit && e.owner === this.localPlayer) this.stats.lost++;
          if (e.kind === EntityKind.Unit && e.killer === this.localPlayer && e.owner !== this.localPlayer) this.stats.kills++;
          if (e.kind === EntityKind.Building && e.killer === this.localPlayer && e.owner !== this.localPlayer) this.stats.razed++;
          if (e.owner === this.localPlayer && e.killer !== this.localPlayer) this.raiseAlert(world, e.x, e.y, true);
          break;
        case 'constructionComplete':
          if (e.owner === this.localPlayer) {
            this.stats.built++;
            // Toast for meaningful buildings only (skip House/Farm spam), rate-limited.
            if (
              e.building !== BuildingTypeEnum.House &&
              e.building !== BuildingTypeEnum.Farm &&
              world.tick - this.lastBuiltToastTick >= 200
            ) {
              this.lastBuiltToastTick = world.tick;
              this.pushToast(`${BUILDING_LABEL[e.building]} complete`, 'good');
            }
          }
          break;
        case 'commandRejected':
          if (e.player === this.localPlayer && !this.autoPlay) this.pushToast(`Can't do that: ${e.reason}`, 'info');
          break;
        case 'playerDefeated':
          this.pushToast(
            e.player === this.localPlayer ? 'You have been defeated' : `Player ${e.player} was defeated`,
            e.player === this.localPlayer ? 'alert' : 'info',
          );
          break;
        case 'matchEnded':
          this.showOverlay(world, e.winner);
          break;
        default:
          break;
      }
    }
  }

  // Centered parchment "age advanced" ceremony banner. Idempotent: removes any prior banner and its
  // pending timer first so a rapid double age-up never accumulates nodes or leaks timers. Self-removes
  // on animationend (real browser) with a setTimeout fallback (jsdom fires no animation events).
  private showAgeBanner(age: Age): void {
    const prev = this.root.querySelector('.hud-age-banner');
    if (prev) prev.remove();
    if (this.ageBannerTimer !== null) {
      clearTimeout(this.ageBannerTimer);
      this.ageBannerTimer = null;
    }
    const banner = el('div', 'hud-age-banner');
    banner.append(
      el('div', 'hud-age-banner-title', `${AGE_LABEL[age]} Age`),
      el('div', 'hud-age-banner-sub', 'Your civilization has advanced'),
    );
    const remove = (): void => {
      banner.remove();
      if (this.ageBannerTimer !== null) {
        clearTimeout(this.ageBannerTimer);
        this.ageBannerTimer = null;
      }
    };
    banner.addEventListener('animationend', remove);
    this.ageBannerTimer = setTimeout(remove, 4200);
    this.root.append(banner);
  }

  private pushToast(text: string, kind: ToastKind = 'info', x?: number, y?: number): void {
    this.toasts.push({ text, ttl: TOAST_TTL, kind, x, y });
    while (this.toasts.length > 4) this.toasts.shift();
  }

  private renderToasts(): void {
    for (const t of this.toasts) t.ttl--;
    const before = this.toasts.length;
    this.toasts = this.toasts.filter((t) => t.ttl > 0);
    const changed = this.toasts.length !== before || this.toastEl.childElementCount !== this.toasts.length;
    if (!changed) return;
    this.toastEl.replaceChildren();
    // Newest at top.
    for (let k = this.toasts.length - 1; k >= 0; k--) {
      const t = this.toasts[k];
      const node = el('div', `hud-toast hud-toast-${t.kind} hud-toast-in`, t.text);
      if (t.kind === 'alert' && t.x !== undefined && t.y !== undefined) {
        node.classList.add('hud-toast-click');
        const tx = t.x;
        const ty = t.y;
        node.addEventListener('click', () => {
          this.view.camX = tx;
          this.view.camY = ty;
        });
      }
      this.toastEl.append(node);
    }
  }

  private showOverlay(world: World, winner: PlayerId): void {
    if (this.ended) return;
    this.ended = true;
    this.overlayEl.classList.remove('hud-hidden');
    let text: string;
    let cls: string;
    if (winner === this.localPlayer) {
      text = 'You are Victorious!';
      cls = 'hud-victory';
    } else if (winner < 0) {
      text = 'Draw';
      cls = 'hud-draw';
    } else {
      text = 'You have been defeated!';
      cls = 'hud-defeat';
    }
    this.overlayEl.classList.add(cls);

    const player = world.players[this.localPlayer];
    const panel = el('div', 'hud-over-panel');
    panel.append(el('div', 'hud-overlay-text', text));
    panel.append(el('div', 'hud-over-sub', `Match time ${formatClock(world.tick)} — ${AGE_LABEL[player.age]} Age`));
    const r = player.resources;
    const table = el('table', 'hud-over-stats');
    const rows: [string, string][] = [
      ['Units trained', String(this.stats.trained)],
      ['Units lost', String(this.stats.lost)],
      ['Enemies slain', String(this.stats.kills)],
      ['Buildings razed', String(this.stats.razed)],
      ['Buildings built', String(this.stats.built)],
      [
        'Stockpile',
        `${Math.floor(r[0])}F ${Math.floor(r[1])}W ${Math.floor(r[2])}G ${Math.floor(r[3])}S`,
      ],
    ];
    for (const [k, v] of rows) {
      const tr = el('tr');
      tr.append(el('td', undefined, k), el('td', undefined, v));
      table.append(tr);
    }
    panel.append(table);
    const again = el('button', 'hud-btn hud-over-again', 'Play Again');
    again.type = 'button';
    again.addEventListener('click', () => {
      if (typeof location !== 'undefined') location.reload();
    });
    panel.append(again);
    this.overlayEl.replaceChildren(panel);
  }

  // ---- help panel + HUD-level keyboard ----

  private toggleHelp(): void {
    this.helpOpen = !this.helpOpen;
    this.helpEl.classList.toggle('hud-hidden', !this.helpOpen);
  }

  private buildHelpPanel(): HTMLElement {
    const overlay = el('div', 'hud-help hud-hidden');
    const card = el('div', 'hud-help-card');
    card.append(el('div', 'hud-help-title', 'Hotkeys'));
    const dl = el('dl', 'hud-help-list');
    const entries: [string, string][] = [
      ['Q W E R T', 'Train (building selected)'],
      ['Z X C V B N M', 'Research (building selected)'],
      ['Q W E R T S D F G Z X', 'Build (villager selected)'],
      ['. / ,', 'Cycle idle villager / select all idle'],
      ['M', 'Select all military'],
      ['H', 'Go to Town Center (selects it in manual)'],
      ['A + Right-click', 'Attack-move (canvas & minimap)'],
      ['Right-click minimap', 'Move / attack-move / set rally'],
      ['Space', 'Jump to last attack alert'],
      ['1–9 / Ctrl+1–9', 'Recall / assign control group'],
      ['WASD / Arrows / Edge / Wheel', 'Pan / zoom'],
      ['Shift-click', 'Queue building placements'],
      ['Esc', 'Cancel placement / close help'],
      ['F1 or ?', 'Toggle this panel'],
    ];
    for (const [k, v] of entries) {
      dl.append(el('dt', 'hud-help-key', k), el('dd', 'hud-help-desc', v));
    }
    card.append(dl);
    const close = el('button', 'hud-btn hud-help-close', 'Close');
    close.type = 'button';
    close.addEventListener('click', () => this.toggleHelp());
    card.append(close);
    overlay.append(card);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.toggleHelp();
    });
    return overlay;
  }

  private readonly onHudKeyDown = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === 'f1' || k === '?') {
      this.toggleHelp();
      e.preventDefault();
      return;
    }
    if (k === ' ') {
      this.jumpToLastAlert();
      e.preventDefault();
      return;
    }
    if (k === 'escape' && this.helpOpen) {
      this.toggleHelp();
      e.preventDefault();
      return;
    }
    if (this.autoPlay || this.ended) return;
    const btn = this.hotkeyMap.get(k);
    if (btn && !btn.disabled) {
      btn.click();
      e.preventDefault();
    }
  };
}

function appendCostChips(wrap: HTMLElement, cost: Cost, out: CostChip[]): void {
  const defs: [Resource, number, string][] = [
    [Resource.Food, cost.food, 'hud-cost-food'],
    [Resource.Wood, cost.wood, 'hud-cost-wood'],
    [Resource.Gold, cost.gold, 'hud-cost-gold'],
    [Resource.Stone, cost.stone, 'hud-cost-stone'],
  ];
  let any = false;
  for (const [res, need, cls] of defs) {
    if (need > 0) {
      const s = el('span', `hud-cost ${cls}`, String(need));
      wrap.append(s);
      out.push({ res, el: s, need });
      any = true;
    }
  }
  if (!any) wrap.append(el('span', 'hud-cost', 'free'));
}

function clampSimSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return MIN_SIM_SPEED;
  const rounded = Math.floor(speed);
  if (rounded < MIN_SIM_SPEED) return MIN_SIM_SPEED;
  if (rounded > MAX_SIM_SPEED) return MAX_SIM_SPEED;
  return rounded;
}

export function createHud(
  root: HTMLElement,
  localPlayer: PlayerId,
  sink: CommandSink,
  view: ViewState,
  onControlChange?: (auto: boolean) => void,
  onSpeedChange?: (speed: number) => void,
): Hud {
  return new GameHud(root, localPlayer, sink, view, onControlChange, onSpeedChange);
}
