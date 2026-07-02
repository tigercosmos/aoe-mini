import { describe, expect, it } from 'vitest';
import { EntityKind } from '../../src/shared/enums';
import type { World } from '../../src/shared/world';
import { createTileMap } from '../../src/map/tilemap';
import { updateVisibility } from '../../src/map/visibility';

// Minimal hand-rolled world fake exposing only the fields updateVisibility
// reads (keeps this test standalone — no dependency on T1 factories).
function fakeWorld(size: number, capacity: number): World {
  const map = createTileMap(size);
  const alive = new Uint8Array(capacity);
  const em = {
    capacity,
    aliveCount: 0,
    alive,
    generation: new Uint16Array(capacity),
    create: () => 0,
    destroy: () => {},
    isAlive: (i: number) => alive[i] === 1,
    handleFor: (i: number) => i,
  };
  const comp = {
    kind: new Uint8Array(capacity),
    owner: new Uint8Array(capacity),
    posX: new Float32Array(capacity),
    posY: new Float32Array(capacity),
    los: new Float32Array(capacity),
  };
  return { mapSize: size, map, em, comp } as unknown as World;
}

function setEntity(
  w: World,
  i: number,
  owner: number,
  x: number,
  y: number,
  los: number,
): void {
  w.em.alive[i] = 1;
  w.comp.kind[i] = EntityKind.Unit;
  w.comp.owner[i] = owner;
  w.comp.posX[i] = x + 0.5;
  w.comp.posY[i] = y + 0.5;
  w.comp.los[i] = los;
}

function bit(arr: Uint8Array, size: number, x: number, y: number): number {
  return arr[y * size + x];
}

describe('updateVisibility', () => {
  it('reveals a disc of the entity LOS radius', () => {
    const w = fakeWorld(64, 8);
    setEntity(w, 0, 1, 10, 10, 4);
    updateVisibility(w);
    const p1 = 1 << 1;
    // centre + within radius are visible & explored
    expect(bit(w.map.visible, 64, 10, 10) & p1).toBe(p1);
    expect(bit(w.map.visible, 64, 14, 10) & p1).toBe(p1); // dist 4
    expect(bit(w.map.explored, 64, 14, 10) & p1).toBe(p1);
    // beyond radius: neither
    expect(bit(w.map.visible, 64, 16, 10) & p1).toBe(0); // dist 6
    expect(bit(w.map.explored, 64, 16, 10) & p1).toBe(0);
  });

  it('drops visible but keeps explored after the entity moves', () => {
    const w = fakeWorld(64, 8);
    const p1 = 1 << 1;
    setEntity(w, 0, 1, 10, 10, 4);
    updateVisibility(w);
    // move away
    w.comp.posX[0] = 30 + 0.5;
    w.comp.posY[0] = 30 + 0.5;
    updateVisibility(w);
    // old tile: no longer visible, still explored
    expect(bit(w.map.visible, 64, 10, 10) & p1).toBe(0);
    expect(bit(w.map.explored, 64, 10, 10) & p1).toBe(p1);
    // new tile: visible + explored
    expect(bit(w.map.visible, 64, 30, 30) & p1).toBe(p1);
    expect(bit(w.map.explored, 64, 30, 30) & p1).toBe(p1);
  });

  it('keeps each player LOS bits independent', () => {
    const w = fakeWorld(64, 8);
    setEntity(w, 0, 1, 10, 10, 4);
    setEntity(w, 1, 2, 30, 30, 4);
    updateVisibility(w);
    const p1 = 1 << 1;
    const p2 = 1 << 2;
    expect(bit(w.map.visible, 64, 10, 10) & p1).toBe(p1);
    expect(bit(w.map.visible, 64, 10, 10) & p2).toBe(0);
    expect(bit(w.map.visible, 64, 30, 30) & p2).toBe(p2);
    expect(bit(w.map.visible, 64, 30, 30) & p1).toBe(0);
  });
});
