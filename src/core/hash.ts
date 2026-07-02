import type { World } from '../shared/world';

/**
 * FNV-1a 32-bit world checksum (T1) — the deterministic regression oracle.
 *
 * Hashed, in this fixed order:
 *   - world.tick
 *   - per player (ascending, Gaia included): each resource (float32 bit pattern), age,
 *     population, then each researched byte
 *   - per ALIVE entity (ascending index): kind, subtype, owner, posX/posY/hp (float32 bit
 *     patterns), orderType
 *
 * Floats are hashed by their IEEE-754 single-precision bit pattern (they are already stored as
 * Float32Array elements), so two worlds with identical logical state hash identically and a
 * single flipped hp bit changes the digest. Integers are folded low-byte first.
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

// Scratch view for float32 -> uint32 bit extraction (module-level, reused; no per-call alloc).
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

function mixByte(h: number, b: number): number {
  return Math.imul(h ^ (b & 0xff), FNV_PRIME) >>> 0;
}

function mixU32(h: number, value: number): number {
  const v = value >>> 0;
  h = mixByte(h, v & 0xff);
  h = mixByte(h, (v >>> 8) & 0xff);
  h = mixByte(h, (v >>> 16) & 0xff);
  h = mixByte(h, (v >>> 24) & 0xff);
  return h;
}

function mixF32(h: number, value: number): number {
  f32[0] = value;
  return mixU32(h, u32[0]);
}

export function hashWorld(world: World): number {
  let h = FNV_OFFSET_BASIS;

  h = mixU32(h, world.tick);

  const players = world.players;
  for (let p = 0; p < players.length; p++) {
    const ps = players[p];
    const res = ps.resources;
    for (let r = 0; r < res.length; r++) h = mixF32(h, res[r]);
    h = mixU32(h, ps.age >>> 0);
    h = mixU32(h, ps.population >>> 0);
    const researched = ps.researched;
    for (let t = 0; t < researched.length; t++) h = mixByte(h, researched[t]);
  }

  const em = world.em;
  const comp = world.comp;
  const alive = em.alive;
  const cap = em.capacity;
  for (let i = 0; i < cap; i++) {
    if (alive[i] !== 1) continue;
    h = mixByte(h, comp.kind[i]);
    h = mixU32(h, comp.subtype[i]);
    h = mixByte(h, comp.owner[i]);
    h = mixF32(h, comp.posX[i]);
    h = mixF32(h, comp.posY[i]);
    h = mixF32(h, comp.hp[i]);
    h = mixByte(h, comp.orderType[i]);
  }

  return h >>> 0;
}
