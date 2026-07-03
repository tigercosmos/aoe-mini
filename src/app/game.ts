// src/app/game.ts
// startGame bootstrap: builds the world, wires an AIPlayer per AI slot, the Canvas2D renderer, the human
// input controller, the DOM HUD and the fixed-timestep loop, plus canvas/minimap resize handling.

import type { MatchSetup, AIPlayer } from '../shared/interfaces';
import { EntityKind, BuildingType } from '../shared/enums';
import { createWorld } from '../sim/world';
import { createAIPlayer } from '../ai/ai';
import { createCanvas2DRenderer } from '../render/canvas2d';
import { createInputController } from '../ui/input';
import { createHud } from '../ui/hud';
import { createGameLoop } from './loop';

export interface GameHandle {
  stop(): void;
}

export function startGame(
  canvas: HTMLCanvasElement,
  minimap: HTMLCanvasElement,
  hudRoot: HTMLElement,
  setup: MatchSetup,
  aiDifficulty?: 'easy' | 'medium' | 'hard',
): GameHandle {
  const world = createWorld(setup);

  // setup.players[0] -> PlayerId 1, players[1] -> PlayerId 2, ... . The human is the first non-AI slot
  // (falls back to PlayerId 1). Each AI slot gets one createAIPlayer, seeded off the match seed.
  //
  // The AI now banks resources for age-up (see src/ai), so the default preset economy reaches Feudal
  // and beyond on its own — no crippled villager cap needed. Difficulty selects the tuning preset
  // (Easy/Medium/Hard); createAIPlayer fills maxVillagers/attackArmySize/thinkInterval from it.
  const AI_CONFIG = { difficulty: aiDifficulty ?? 'medium' } as const;
  let localPlayer = 1;
  const ais: AIPlayer[] = [];
  for (let i = 0; i < setup.players.length; i++) {
    const playerId = i + 1;
    if (setup.players[i].isAI) ais.push(createAIPlayer(playerId, setup.seed, AI_CONFIG));
    else localPlayer = playerId;
  }

  const input = createInputController(localPlayer);
  input.manualControl = false;

  const localAI = createAIPlayer(localPlayer, setup.seed, AI_CONFIG);

  let autoPlay = true;
  let simSpeed = 1;
  const hud = createHud(
    hudRoot,
    localPlayer,
    (cmd) => input.enqueueCommand(cmd),
    input.view,
    (auto) => {
      autoPlay = auto;
      input.manualControl = !auto;
    },
    (speed) => {
      simSpeed = speed;
    },
  );

  const renderer = createCanvas2DRenderer();
  renderer.init(canvas);
  input.attach(canvas, minimap);

  const minimapCtx = minimap.getContext('2d');
  if (!minimapCtx) throw new Error('minimap 2d context unavailable');

  centerOnTownCenter(world, input, localPlayer);

  const resize = (): void => {
    const w = canvas.clientWidth || canvas.parentElement?.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || canvas.parentElement?.clientHeight || window.innerHeight;
    renderer.resize(w, h);
    input.view.viewportW = w;
    input.view.viewportH = h;
  };
  resize();
  window.addEventListener('resize', resize);

  const loop = createGameLoop({
    world,
    ais,
    localAI,
    autoPlay: () => autoPlay,
    simSpeed: () => simSpeed,
    input,
    renderer,
    minimapCtx,
    hud,
  });
  loop.start();

  return {
    stop(): void {
      loop.stop();
      window.removeEventListener('resize', resize);
      input.detach();
      renderer.dispose();
    },
  };
}

function centerOnTownCenter(world: ReturnType<typeof createWorld>, input: ReturnType<typeof createInputController>, localPlayer: number): void {
  const comp = world.comp;
  const em = world.em;
  for (let i = 0; i < comp.capacity; i++) {
    if (em.alive[i] !== 1) continue;
    if (comp.owner[i] !== localPlayer) continue;
    if (comp.kind[i] !== EntityKind.Building) continue;
    if (comp.subtype[i] !== BuildingType.TownCenter) continue;
    input.view.camX = comp.posX[i];
    input.view.camY = comp.posY[i];
    return;
  }
}
