// src/main.ts
// Browser entry point. Reads ?seed= from the URL (default 20260702) and starts a 3-player match:
// human Britons vs AI Franks + AI Mongols on the default map size.
// Also reads ?ai=easy|medium|hard to pick the AI difficulty preset (default medium).

import './ui/hud.css';
import { startGame } from './app/game';
import { DEFAULT_MAP_SIZE } from './shared/constants';
import { CivId } from './shared/enums';
import type { MatchSetup } from './shared/interfaces';

const DEFAULT_SEED = 20260702;

function parseSeed(): number {
  const raw = new URLSearchParams(window.location.search).get('seed');
  if (raw === null) return DEFAULT_SEED;
  const n = Number(raw);
  return Number.isFinite(n) ? n >>> 0 : DEFAULT_SEED;
}

function parseDifficulty(): 'easy' | 'medium' | 'hard' | undefined {
  const raw = new URLSearchParams(window.location.search).get('ai');
  return raw === 'easy' || raw === 'medium' || raw === 'hard' ? raw : undefined;
}

function requireElement<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id} element in index.html`);
  return node as T;
}

function boot(): void {
  const canvas = requireElement<HTMLCanvasElement>('game');
  const minimap = requireElement<HTMLCanvasElement>('minimap');
  const hudRoot = requireElement<HTMLElement>('hud');

  const setup: MatchSetup = {
    seed: parseSeed(),
    mapSize: DEFAULT_MAP_SIZE,
    players: [
      { civ: CivId.Britons, isAI: false }, // PlayerId 1 — human
      { civ: CivId.Franks, isAI: true }, // PlayerId 2 — AI
      { civ: CivId.Mongols, isAI: true }, // PlayerId 3 — AI
    ],
  };

  startGame(canvas, minimap, hudRoot, setup, parseDifficulty());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
