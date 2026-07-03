/** @vitest-environment jsdom */
import { describe, it, expect } from 'vitest';
import { createSetupPanel, type SetupValues } from '../../src/ui/setup-panel';
import { CivId } from '../../src/shared/enums';

describe('setup panel smoke', () => {
  const initial: SetupValues = {
    seed: 123,
    mapSize: 96,
    difficulty: 'medium',
    players: [
      { civ: CivId.Britons, isAI: false },
      { civ: CivId.Franks, isAI: true },
      { civ: CivId.Mongols, isAI: true },
    ],
  };

  it('constructs, opens, and emits validated values on Start', () => {
    const host = document.createElement('div');
    let got: SetupValues | null = null;
    const panel = createSetupPanel(host, initial, (v) => (got = v));
    panel.open();

    // renders 3 player rows and difficulty/count segments
    expect(host.querySelectorAll('.setup-player').length).toBe(3);
    expect(host.querySelectorAll('.setup-seg').length).toBe(2); // difficulty + player count

    const startBtn = host.querySelector('.setup-btn-primary') as HTMLButtonElement;
    startBtn.click();

    expect(got).not.toBeNull();
    const v = got as unknown as SetupValues;
    expect(v.players.filter((p) => !p.isAI).length).toBe(1); // exactly one human
    expect(v.seed).toBe(123);
    expect(v.mapSize).toBe(96);
  });

  it('clamps a bad seed/size and keeps exactly one human when none given', () => {
    const host = document.createElement('div');
    let got: SetupValues | null = null;
    const bad: SetupValues = {
      seed: NaN as unknown as number,
      mapSize: 9999,
      difficulty: 'hard',
      players: [
        { civ: CivId.Britons, isAI: true },
        { civ: CivId.Franks, isAI: true },
      ],
    };
    const panel = createSetupPanel(host, bad, (v) => (got = v));
    panel.open();
    (host.querySelector('.setup-btn-primary') as HTMLButtonElement).click();

    const v = got as unknown as SetupValues;
    expect(Number.isFinite(v.seed)).toBe(true);
    expect(v.mapSize).toBeLessThanOrEqual(192);
    expect(v.players.filter((p) => !p.isAI).length).toBe(1);
  });
});
