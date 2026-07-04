// src/ui/setup-panel.ts
// Pre-match setup overlay: lets the player tune every match parameter from the UI instead of
// editing the ?seed=/?ai= URL by hand — seed (+ randomize), map size, AI difficulty, player count,
// per-player civ, and which slot the human controls. Produces a MatchSetup + difficulty and hands it
// to a start callback; main.ts uses that to (re)launch the game. Framework-free DOM, no sim deps.

import './setup-panel.css';
import { CivId } from '../shared/enums';
import type { PlayerSetup } from '../shared/interfaces';
import { PLAYER_COLORS } from '../render/sprites';

export type Difficulty = 'easy' | 'medium' | 'hard';

export interface SetupValues {
  seed: number;
  mapSize: number;
  difficulty: Difficulty;
  /** players[0] -> PlayerId 1. Exactly one slot has isAI === false (the local human). */
  players: PlayerSetup[];
}

export interface SetupPanel {
  /** Show the overlay, seeded with the last-applied values. */
  open(): void;
  close(): void;
  readonly root: HTMLElement;
}

// Map-size guard rails: below ~48 there is no room for 3 fair starts; above ~192 gen/perf suffers.
const MAP_MIN = 48;
const MAP_MAX = 192;
const MAP_STEP = 8;
const MAX_SEED = 0xffffffff;

const CIV_OPTIONS: readonly { id: CivId; name: string }[] = [
  { id: CivId.Britons, name: 'Britons' },
  { id: CivId.Franks, name: 'Franks' },
  { id: CivId.Mongols, name: 'Mongols' },
];

const DIFFICULTIES: readonly Difficulty[] = ['easy', 'medium', 'hard'];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function clampSeed(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return (n >>> 0) as number; // unsigned 32-bit, matching the sim RNG seed domain
}

function clampMapSize(n: number): number {
  if (!Number.isFinite(n)) return 96;
  const snapped = Math.round(n / MAP_STEP) * MAP_STEP;
  return Math.min(MAP_MAX, Math.max(MAP_MIN, snapped));
}

/**
 * Build the setup overlay. `initial` seeds the first render; `onStart` fires when the player
 * confirms — it receives fully-validated values (exactly one human, sane seed/size).
 */
export function createSetupPanel(
  host: HTMLElement,
  initial: SetupValues,
  onStart: (values: SetupValues) => void,
): SetupPanel {
  // Working copy — mutated by the controls, cloned out on Start so callers keep a stable snapshot.
  const state: SetupValues = {
    seed: clampSeed(initial.seed),
    mapSize: clampMapSize(initial.mapSize),
    difficulty: initial.difficulty,
    players: initial.players.map((p) => ({ civ: p.civ, isAI: p.isAI })),
  };
  ensureSingleHuman(state.players);

  let gameStarted = false;

  const overlay = el('div', 'setup-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Match setup');

  const panel = el('div', 'setup-panel');
  overlay.appendChild(panel);

  panel.appendChild(el('h1', 'setup-title', 'New Match'));
  panel.appendChild(
    el('p', 'setup-subtitle', 'Configure the world and opponents, then launch. Same seed + settings = same match.'),
  );

  // ---- Seed ----
  const seedField = el('div', 'setup-field');
  seedField.appendChild(el('label', 'setup-label', 'Seed'));
  const seedRow = el('div', 'setup-row');
  const seedInput = el('input', 'setup-input');
  seedInput.type = 'number';
  seedInput.min = '0';
  seedInput.max = String(MAX_SEED);
  seedInput.step = '1';
  const randomBtn = el('button', 'setup-btn setup-btn-ghost', '🎲 Random');
  randomBtn.type = 'button';
  seedRow.append(seedInput, randomBtn);
  seedField.appendChild(seedRow);
  seedField.appendChild(el('div', 'setup-hint', 'Any integer 0–4294967295. The same seed reproduces the identical map and match.'));
  panel.appendChild(seedField);

  seedInput.addEventListener('input', () => {
    state.seed = clampSeed(Number(seedInput.value));
  });
  seedInput.addEventListener('blur', () => {
    seedInput.value = String(state.seed);
  });
  randomBtn.addEventListener('click', () => {
    state.seed = clampSeed(Math.floor(Math.random() * (MAX_SEED + 1)));
    seedInput.value = String(state.seed);
  });

  // ---- Map size ----
  const sizeField = el('div', 'setup-field');
  sizeField.appendChild(el('label', 'setup-label', 'Map size'));
  const sizeRow = el('div', 'setup-row');
  const sizeRange = el('input', 'setup-range');
  sizeRange.type = 'range';
  sizeRange.min = String(MAP_MIN);
  sizeRange.max = String(MAP_MAX);
  sizeRange.step = String(MAP_STEP);
  const sizeValue = el('span', 'setup-value');
  sizeRow.append(sizeRange, sizeValue);
  sizeField.appendChild(sizeRow);
  sizeField.appendChild(el('div', 'setup-hint', `Tiles per side (${MAP_MIN}–${MAP_MAX}). Bigger maps = longer walks and more resources.`));
  panel.appendChild(sizeField);

  const renderSize = (): void => {
    sizeRange.value = String(state.mapSize);
    sizeValue.textContent = `${state.mapSize}×${state.mapSize}`;
  };
  sizeRange.addEventListener('input', () => {
    state.mapSize = clampMapSize(Number(sizeRange.value));
    sizeValue.textContent = `${state.mapSize}×${state.mapSize}`;
  });

  // ---- AI difficulty ----
  const diffField = el('div', 'setup-field');
  diffField.appendChild(el('label', 'setup-label', 'AI difficulty'));
  const diffSeg = el('div', 'setup-seg');
  const diffButtons = new Map<Difficulty, HTMLButtonElement>();
  for (const d of DIFFICULTIES) {
    const b = el('button', undefined, d[0].toUpperCase() + d.slice(1));
    b.type = 'button';
    b.addEventListener('click', () => {
      state.difficulty = d;
      renderDifficulty();
    });
    diffButtons.set(d, b);
    diffSeg.appendChild(b);
  }
  diffField.appendChild(diffSeg);
  panel.appendChild(diffField);

  const renderDifficulty = (): void => {
    for (const [d, b] of diffButtons) b.setAttribute('aria-pressed', String(d === state.difficulty));
  };

  // ---- Player count ----
  const countField = el('div', 'setup-field');
  countField.appendChild(el('label', 'setup-label', 'Players'));
  const countSeg = el('div', 'setup-seg');
  const countButtons = new Map<number, HTMLButtonElement>();
  for (const n of [2, 3]) {
    const b = el('button', undefined, `${n} players`);
    b.type = 'button';
    b.addEventListener('click', () => {
      setPlayerCount(n);
    });
    countButtons.set(n, b);
    countSeg.appendChild(b);
  }
  countField.appendChild(countSeg);
  panel.appendChild(countField);

  // ---- Per-player rows ----
  const playersField = el('div', 'setup-field');
  playersField.appendChild(el('label', 'setup-label', 'Slots'));
  const playersList = el('div', 'setup-players');
  playersField.appendChild(playersList);
  playersField.appendChild(el('div', 'setup-hint', 'Pick each slot’s civ, and which one you control. Exactly one slot is You; the rest are AI.'));
  panel.appendChild(playersField);

  function setPlayerCount(n: number): void {
    if (state.players.length === n) return;
    if (n < state.players.length) {
      state.players.length = n;
    } else {
      while (state.players.length < n) {
        // New slots default to AI with the next unused civ (falls back to cycling).
        const civ = CIV_OPTIONS[state.players.length % CIV_OPTIONS.length].id;
        state.players.push({ civ, isAI: true });
      }
    }
    ensureSingleHuman(state.players);
    renderPlayerCount();
    renderPlayers();
  }

  function renderPlayerCount(): void {
    for (const [n, b] of countButtons) b.setAttribute('aria-pressed', String(n === state.players.length));
  }

  function renderPlayers(): void {
    playersList.textContent = '';
    state.players.forEach((p, i) => {
      const playerId = i + 1; // players[0] -> PlayerId 1
      const row = el('div', 'setup-player');

      const dot = el('span', 'setup-player-dot');
      dot.style.background = PLAYER_COLORS[playerId] ?? PLAYER_COLORS[0];
      row.appendChild(dot);

      row.appendChild(el('span', 'setup-player-name', `Player ${playerId}`));

      const civSelect = el('select', 'setup-select');
      for (const c of CIV_OPTIONS) {
        const opt = el('option', undefined, c.name);
        opt.value = String(c.id);
        if (c.id === p.civ) opt.selected = true;
        civSelect.appendChild(opt);
      }
      civSelect.addEventListener('change', () => {
        p.civ = Number(civSelect.value) as CivId;
      });
      row.appendChild(civSelect);

      const ctrlSelect = el('select', 'setup-select');
      const youOpt = el('option', undefined, 'You');
      youOpt.value = 'human';
      const aiOpt = el('option', undefined, 'AI');
      aiOpt.value = 'ai';
      if (p.isAI) aiOpt.selected = true;
      else youOpt.selected = true;
      ctrlSelect.append(youOpt, aiOpt);
      ctrlSelect.addEventListener('change', () => {
        if (ctrlSelect.value === 'human') {
          // Radio semantics: exactly one human. This slot becomes You; all others become AI.
          state.players.forEach((q, j) => {
            q.isAI = j !== i;
          });
        } else {
          p.isAI = true;
          ensureSingleHuman(state.players); // never leave zero humans
        }
        renderPlayers();
      });
      row.appendChild(ctrlSelect);

      playersList.appendChild(row);
    });
  }

  // ---- Action buttons ----
  const btns = el('div', 'setup-btns');
  const startBtn = el('button', 'setup-btn setup-btn-primary', 'Start Match');
  startBtn.type = 'button';
  const cancelBtn = el('button', 'setup-btn setup-btn-ghost', 'Cancel');
  cancelBtn.type = 'button';
  btns.append(startBtn, cancelBtn);
  panel.appendChild(btns);

  startBtn.addEventListener('click', () => {
    ensureSingleHuman(state.players);
    gameStarted = true;
    hide();
    onStart({
      seed: clampSeed(state.seed),
      mapSize: clampMapSize(state.mapSize),
      difficulty: state.difficulty,
      players: state.players.map((p) => ({ civ: p.civ, isAI: p.isAI })),
    });
  });
  cancelBtn.addEventListener('click', hide);

  function renderAll(): void {
    seedInput.value = String(state.seed);
    renderSize();
    renderDifficulty();
    renderPlayerCount();
    renderPlayers();
    // Cancel is only meaningful once a game is on screen to return to.
    cancelBtn.style.display = gameStarted ? '' : 'none';
  }

  function show(): void {
    renderAll();
    overlay.hidden = false;
  }
  function hide(): void {
    overlay.hidden = true;
  }

  overlay.hidden = true;
  host.appendChild(overlay);

  return {
    open: show,
    close: hide,
    root: overlay,
  };
}

/** Guarantee exactly one non-AI slot. If none is human, slot 1 becomes human; extra humans -> AI. */
function ensureSingleHuman(players: PlayerSetup[]): void {
  const firstHuman = players.findIndex((p) => !p.isAI);
  if (firstHuman === -1) {
    if (players.length > 0) players[0].isAI = false;
    return;
  }
  players.forEach((p, i) => {
    if (i !== firstHuman) p.isAI = true;
  });
}
