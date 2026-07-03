// src/audio/index.ts
// createGameAudio() — the single entry point game.ts consumes. It owns the engine + dispatcher, injects
// a self-contained mute button into the HUD (without editing hud.ts or index.html) and returns the
// loop-facing { onTick, onCommands } plus lifecycle controls. The constructor NEVER throws: every DOM
// touch is guarded so a missing HUD / no-WebAudio environment degrades to silence, not a crash.

import type { World } from '../shared/world';
import type { ViewState } from '../shared/interfaces';
import type { Command } from '../shared/commands';
import type { GameEvent } from '../shared/events';
import { createSfxEngine, type GameAudioEngine } from './engine';
import { createDispatcher, type Dispatcher } from './dispatcher';

export interface GameAudio {
  onTick(evs: readonly GameEvent[], world: World, view: ViewState, ticksThisFrame: number): void;
  onCommands(cmds: readonly Command[]): void;
  resume(): void;
  toggleMuted(): void;
  setMuted(muted: boolean): void;
  dispose(): void;
}

export function createGameAudio(hudRoot: HTMLElement | null | undefined, isAutoPlay: () => boolean): GameAudio {
  let engine: GameAudioEngine;
  let dispatcher: Dispatcher;
  try {
    engine = createSfxEngine();
    dispatcher = createDispatcher(engine, { isAutoPlay });
  } catch {
    // Total failure — hand back an inert object so game.ts wiring is byte-safe.
    return {
      onTick(): void {}, onCommands(): void {}, resume(): void {},
      toggleMuted(): void {}, setMuted(): void {}, dispose(): void {},
    };
  }

  let btn: HTMLButtonElement | null = null;
  let onPointerDown: ((e: Event) => void) | null = null;

  const syncButton = (): void => {
    if (!btn) return;
    const muted = engine.getMuted();
    btn.textContent = muted ? 'Muted' : 'Sound';
    btn.setAttribute('aria-pressed', String(muted));
    btn.classList.toggle('hud-audio-muted', muted);
  };

  // ---- inject the mute control + a zero-coupling UI-click listener ----
  try {
    if (hudRoot && typeof document !== 'undefined') {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hud-control hud-audio-btn';
      btn.title = 'Mute (M)';
      btn.addEventListener('click', () => {
        engine.resume(); // the click is a user gesture — unlock if still suspended
        engine.toggleMuted();
        syncButton();
      });

      const host = hudRoot.querySelector('.hud-topbar-right');
      if (host) {
        host.appendChild(btn);
      } else {
        // Fallback: pin it top-right so it works even if the HUD skin has no top bar.
        btn.style.position = 'absolute';
        btn.style.top = '8px';
        btn.style.right = '8px';
        btn.style.zIndex = '50';
        hudRoot.appendChild(btn);
      }
      syncButton();

      // A soft click on any HUD button — captured so it fires before the button's own handler and
      // never depends on hud.ts internals.
      onPointerDown = (e: Event): void => {
        const t = e.target as HTMLElement | null;
        if (t && typeof t.closest === 'function' && t.closest('button')) dispatcher.uiClick();
      };
      hudRoot.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
    }
  } catch {
    // HUD injection is best-effort; audio still works via the 'M' key.
  }

  return {
    onTick(evs, world, view, ticksThisFrame): void {
      dispatcher.onTick(evs, world, view, ticksThisFrame);
    },
    onCommands(cmds): void {
      dispatcher.onCommands(cmds);
    },
    resume(): void {
      engine.resume();
    },
    toggleMuted(): void {
      engine.toggleMuted();
      syncButton();
    },
    setMuted(muted: boolean): void {
      engine.setMuted(muted);
      syncButton();
    },
    dispose(): void {
      try {
        if (hudRoot && onPointerDown) hudRoot.removeEventListener('pointerdown', onPointerDown, { capture: true } as EventListenerOptions);
        if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
      } catch {
        // ignore
      }
      engine.dispose();
    },
  };
}
