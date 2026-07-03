// src/main.ts
// Browser entry point. Builds the match from URL params (?seed= / ?ai= / ?size= / ?players=) on load,
// then exposes an in-UI setup panel (⚙ New Match) so every parameter — seed, map size, AI difficulty,
// player count, per-player civ and which slot you control — can be changed and relaunched without
// hand-editing the URL. Confirmed setups are mirrored back into the URL so matches stay shareable.
// A GitHub link to the source repo sits alongside the setup button.

import './ui/hud.css';
import { startGame, type GameHandle } from './app/game';
import { DEFAULT_MAP_SIZE } from './shared/constants';
import { CivId } from './shared/enums';
import type { MatchSetup, PlayerSetup } from './shared/interfaces';
import { createSetupPanel, type SetupValues, type Difficulty } from './ui/setup-panel';

const DEFAULT_SEED = 20260702;
const REPO_URL = 'https://github.com/tigercosmos/aoe-mini';

const CIV_BY_NAME: Record<string, CivId> = {
  britons: CivId.Britons,
  franks: CivId.Franks,
  mongols: CivId.Mongols,
};
const CIV_NAME: Record<CivId, string> = {
  [CivId.Britons]: 'britons',
  [CivId.Franks]: 'franks',
  [CivId.Mongols]: 'mongols',
};

const DEFAULT_PLAYERS: PlayerSetup[] = [
  { civ: CivId.Britons, isAI: false }, // PlayerId 1 — human
  { civ: CivId.Franks, isAI: true }, // PlayerId 2 — AI
  { civ: CivId.Mongols, isAI: true }, // PlayerId 3 — AI
];

function requireElement<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id} element in index.html`);
  return node as T;
}

// ---- URL <-> SetupValues ----

function parseInitialValues(): SetupValues {
  const q = new URLSearchParams(window.location.search);

  const rawSeed = q.get('seed');
  let seed = DEFAULT_SEED;
  if (rawSeed !== null) {
    const n = Number(rawSeed);
    if (Number.isFinite(n)) seed = n >>> 0;
  }

  const rawSize = q.get('size');
  let mapSize = DEFAULT_MAP_SIZE;
  if (rawSize !== null) {
    const n = Number(rawSize);
    if (Number.isFinite(n)) mapSize = n;
  }

  const rawAi = q.get('ai');
  const difficulty: Difficulty =
    rawAi === 'easy' || rawAi === 'medium' || rawAi === 'hard' ? rawAi : 'medium';

  // players=H:britons,A:franks,A:mongols  (controller H|A : civ). Falls back to the classic 3-player match.
  const players = parsePlayers(q.get('players')) ?? DEFAULT_PLAYERS.map((p) => ({ ...p }));

  return { seed, mapSize, difficulty, players };
}

function parsePlayers(raw: string | null): PlayerSetup[] | null {
  if (!raw) return null;
  const out: PlayerSetup[] = [];
  for (const part of raw.split(',')) {
    const [ctrl, civName] = part.split(':');
    const civ = CIV_BY_NAME[(civName ?? '').trim().toLowerCase()];
    if (civ === undefined) return null;
    out.push({ civ, isAI: (ctrl ?? '').trim().toUpperCase() !== 'H' });
  }
  if (out.length < 2 || out.length > 3) return null;
  return out;
}

function syncUrl(values: SetupValues): void {
  const q = new URLSearchParams(window.location.search);
  q.set('seed', String(values.seed));
  q.set('size', String(values.mapSize));
  q.set('ai', values.difficulty);
  q.set(
    'players',
    values.players.map((p) => `${p.isAI ? 'A' : 'H'}:${CIV_NAME[p.civ]}`).join(','),
  );
  const url = `${window.location.pathname}?${q.toString()}${window.location.hash}`;
  window.history.replaceState(null, '', url);
}

function toMatchSetup(values: SetupValues): MatchSetup {
  return {
    seed: values.seed,
    mapSize: values.mapSize,
    players: values.players.map((p) => ({ civ: p.civ, isAI: p.isAI })),
  };
}

// ---- Top-right control cluster (⚙ New Match + GitHub) ----

function createControls(app: HTMLElement, onOpenSetup: () => void): void {
  const controls = document.createElement('div');
  controls.className = 'setup-controls';

  const gear = document.createElement('button');
  gear.type = 'button';
  gear.className = 'setup-gear';
  gear.textContent = '⚙ New Match';
  gear.addEventListener('click', onOpenSetup);

  const gh = document.createElement('a');
  gh.className = 'setup-ghlink';
  gh.href = REPO_URL;
  gh.target = '_blank';
  gh.rel = 'noopener noreferrer';
  gh.title = 'View source on GitHub';
  gh.setAttribute('aria-label', 'View source on GitHub');
  gh.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

  controls.append(gh, gear);
  app.appendChild(controls);
}

// ---- Boot / lifecycle ----

function boot(): void {
  const app = requireElement<HTMLElement>('app');
  const canvas = requireElement<HTMLCanvasElement>('game');
  const minimap = requireElement<HTMLCanvasElement>('minimap');
  const hudRoot = requireElement<HTMLElement>('hud');

  let current: GameHandle | null = null;

  const launch = (values: SetupValues): void => {
    if (current) {
      current.stop();
      hudRoot.textContent = ''; // clear the previous match's HUD DOM before rebuilding
    }
    syncUrl(values);
    current = startGame(canvas, minimap, hudRoot, toMatchSetup(values), values.difficulty);
  };

  const initial = parseInitialValues();
  const panel = createSetupPanel(app, initial, launch);
  createControls(app, panel.open);

  // Auto-start the URL/default match so deep links (?seed=…) work unchanged; the ⚙ button reopens setup.
  launch(initial);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
