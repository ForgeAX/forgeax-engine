// Gen-slot codec unit tests — M1 w1 (TDD red phase).
//
// Plan-strategy anchors:
//   - D-1: codec is domain-agnostic pure bit ops -> no throw, mask + pack only
//   - D-7: pack MUST retain `>>> 0` to prevent gen>=128 ToInt32 negative trap
//   - AC-05: builtin invariant pack(slot, 0) === slot
//   - AC-06: first alloc gen=0 (verified via pack(slot, 0) === slot)
//   - AC-15: codec SSOT — these functions are the single definition point
//
// Imports from the package barrel (@forgeax/engine-types index.ts),
// which re-exports everything from ./handle.ts.

import { describe, expect, it } from 'vitest';
import { isRetiredSlot, MAX_GEN, MAX_SLOT, pack, unpackGen, unpackSlot } from '../index';

describe('MAX_SLOT', () => {
  it('equals (1 << 24) - 1 = 16_777_215', () => {
    expect(MAX_SLOT).toBe((1 << 24) - 1);
    expect(MAX_SLOT).toBe(16_777_215);
  });
});

describe('MAX_GEN', () => {
  it('equals 0xff = 255', () => {
    expect(MAX_GEN).toBe(0xff);
    expect(MAX_GEN).toBe(255);
  });
});

describe('pack', () => {
  it('pack(slot, 0) === slot — builtin invariant (AC-05)', () => {
    expect(pack(0, 0)).toBe(0);
    expect(pack(1, 0)).toBe(1);
    expect(pack(5, 0)).toBe(5);
    expect(pack(1024, 0)).toBe(1024);
    expect(pack(MAX_SLOT, 0)).toBe(MAX_SLOT);
  });

  it('packs gen into high 8 bits, slot into low 24 bits', () => {
    // gen=1, slot=0 => 1 << 24 = 16_777_216
    expect(pack(0, 1)).toBe(1 << 24);
    // gen=255, slot=0 => 0xff << 24
    expect(pack(0, 255)).toBe((0xff << 24) >>> 0);
    // gen=1, slot=1 => (1 << 24) | 1
    expect(pack(1, 1)).toBe(((1 << 24) | 1) >>> 0);
  });

  it('masks gen to 8 bits via gen & 0xff', () => {
    // gen=256 masked to 0
    expect(pack(0, 256)).toBe(0);
    // gen=257 masked to 1
    expect(pack(0, 257)).toBe(1 << 24);
    // gen=511 masked to 255
    expect(pack(0, 511)).toBe((0xff << 24) >>> 0);
  });

  it('masks slot to 24 bits via slot & 0xffffff', () => {
    // slot=16_777_216 masked to 0
    expect(pack(16_777_216, 0)).toBe(0);
    // slot=16_777_217 masked to 1
    expect(pack(16_777_217, 0)).toBe(1);
  });

  it('>>> 0 prevents ToInt32 negative for gen >= 128 (D-7 hard constraint)', () => {
    // Without >>> 0, (128 << 24) | 0 yields -2147483648 (signed ToInt32).
    // With >>> 0 it must be a positive u32: 2147483648.
    const result = pack(0, 128);
    expect(result).toBeGreaterThan(0);
    expect(result).toBe((128 << 24) >>> 0);
    // Verify round-trip correctness.
    expect(unpackGen(result)).toBe(128);
    expect(unpackSlot(result)).toBe(0);
  });

  it('gen=129 to gen=254 all produce positive u32 via >>> 0', () => {
    for (let gen = 129; gen <= 254; gen++) {
      const result = pack(0, gen);
      expect(result).toBeGreaterThan(0);
      expect(unpackGen(result)).toBe(gen);
    }
  });

  it('gen=255, slot=MAX_SLOT produces 0xffffffff (jagged max)', () => {
    const result = pack(MAX_SLOT, 255);
    // 0xffffffff as unsigned 32-bit.
    expect(result).toBe(0xffffffff >>> 0);
    expect(unpackSlot(result)).toBe(MAX_SLOT);
    expect(unpackGen(result)).toBe(255);
  });

  it('produces deterministic bit patterns (idempotent)', () => {
    const a = pack(42, 3);
    const b = pack(42, 3);
    expect(a).toBe(b);
    expect(a === b).toBe(true);
  });

  it('pack(x, 0) is identity for all slots in [0, 1024]', () => {
    for (let slot = 0; slot <= 1024; slot++) {
      expect(pack(slot, 0)).toBe(slot);
    }
  });
});

describe('unpackSlot', () => {
  it('extracts low 24 bits', () => {
    expect(unpackSlot(pack(0, 0))).toBe(0);
    expect(unpackSlot(pack(1, 0))).toBe(1);
    expect(unpackSlot(pack(42, 0))).toBe(42);
    expect(unpackSlot(pack(MAX_SLOT, 0))).toBe(MAX_SLOT);
  });

  it('round-trips through pack for key (slot, gen) pairs', () => {
    const cases: [number, number][] = [
      [0, 0],
      [1, 0],
      [42, 3],
      [1024, 7],
      [MAX_SLOT, 255],
      [0, 128],
      [100, 200],
      [65535, 15],
    ];
    for (const [slot, gen] of cases) {
      expect(unpackSlot(pack(slot, gen))).toBe(slot);
    }
  });
});

describe('unpackGen', () => {
  it('extracts high 8 bits', () => {
    expect(unpackGen(pack(0, 0))).toBe(0);
    expect(unpackGen(pack(0, 1))).toBe(1);
    expect(unpackGen(pack(0, 42))).toBe(42);
    expect(unpackGen(pack(0, 255))).toBe(255);
    expect(unpackGen(pack(0, 128))).toBe(128);
  });

  it('round-trips through pack for key (slot, gen) pairs', () => {
    const cases: [number, number][] = [
      [0, 0],
      [1, 1],
      [42, 7],
      [MAX_SLOT, 255],
      [0, 128],
      [1024, 200],
      [4096, 254],
    ];
    for (const [slot, gen] of cases) {
      expect(unpackGen(pack(slot, gen))).toBe(gen);
    }
  });
});

describe('isRetiredSlot', () => {
  it('returns false when gen <= MAX_GEN (255 is usable)', () => {
    expect(isRetiredSlot(MAX_GEN)).toBe(false);
    expect(isRetiredSlot(255)).toBe(false);
  });

  it('returns false for gen 0..254 (non-regression sweep)', () => {
    for (let gen = 0; gen <= 254; gen++) {
      expect(isRetiredSlot(gen)).toBe(false);
    }
  });

  it('returns true when gen > MAX_GEN (256+ is retired)', () => {
    expect(isRetiredSlot(256)).toBe(true);
    expect(isRetiredSlot(511)).toBe(true);
    expect(isRetiredSlot(512)).toBe(true);
  });
});

describe('round-trip', () => {
  it('pack then unpack returns original (slot, gen) for key pairs', () => {
    const cases: { slot: number; gen: number }[] = [
      { slot: 0, gen: 0 },
      { slot: 1, gen: 0 },
      { slot: 4096, gen: 1 },
      { slot: 65535, gen: 15 },
      { slot: 1048575, gen: 42 },
      { slot: MAX_SLOT, gen: 0 },
      { slot: MAX_SLOT, gen: 255 },
      { slot: 0, gen: 255 },
      { slot: 0, gen: 128 },
      { slot: 100, gen: 200 },
    ];
    for (const { slot, gen } of cases) {
      const v = pack(slot, gen);
      expect(unpackSlot(v), `slot mismatch: pack(${slot}, ${gen})`).toBe(slot);
      expect(unpackGen(v), `gen mismatch: pack(${slot}, ${gen})`).toBe(gen);
    }
  });
});
