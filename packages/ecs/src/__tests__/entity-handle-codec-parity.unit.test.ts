// Entity handle codec parity unit tests (w3).
//
// Runtime value assertions verifying bit-pattern equivalence between
// entity-handle functions and the shared codec in @forgeax/engine-types.
// These are the AC-14 regression baseline -- encodeEntity must produce
// identical u32 values to codec.pack, and decode/entityIndex/entityGeneration
// must match codec unpack results for all gen values including gen>=128
// (>>>0 anti-ToInt32 guard, R5 from plan-strategy).
//
// This file holds runtime assertions; the plan targetFiles listed
// .test-d.ts which are typecheck-only and cannot execute these checks.

import { MAX_GEN, MAX_SLOT, pack, unpackGen, unpackSlot } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  decodeEntity,
  ENTITY_MAX_GENERATION,
  ENTITY_MAX_INDEX,
  type EntityHandle,
  encodeEntity,
  entityGeneration,
  entityIndex,
} from '../entity-handle';

describe('[w3] Entity codec parity -- constants', () => {
  it('ENTITY_MAX_INDEX === MAX_SLOT', () => {
    expect(ENTITY_MAX_INDEX).toBe(MAX_SLOT);
  });

  it('ENTITY_MAX_GENERATION === MAX_GEN', () => {
    expect(ENTITY_MAX_GENERATION).toBe(MAX_GEN);
  });
});

describe('[w3] Entity codec parity -- encodeEntity equals codec.pack', () => {
  const SLOTS = [0, 1, 5, 42, 1023, 1024, 16777215] as const;

  // gen=0: pack(slot,0)===slot invariant (D-8)
  it('encodeEntity(i, 0) === pack(i, 0) for sampled slot values', () => {
    for (const slot of SLOTS) {
      expect(encodeEntity(slot, 0)).toBe(pack(slot, 0));
    }
  });

  // gen=128: the >>>0 guard is load-bearing (R5)
  it('encodeEntity(i, 128) === pack(i, 128) -- gen>=128 ToInt32 guard', () => {
    for (const slot of SLOTS) {
      expect(encodeEntity(slot, 128)).toBe(pack(slot, 128));
    }
  });

  // gen=255: edge case, max generation
  it('encodeEntity(i, 255) === pack(i, 255) -- max gen edge', () => {
    for (const slot of SLOTS) {
      expect(encodeEntity(slot, 255)).toBe(pack(slot, 255));
    }
  });

  // gen=64: mid-range smoke test
  it('encodeEntity(i, 64) === pack(i, 64) -- mid-range gen', () => {
    for (const slot of SLOTS) {
      expect(encodeEntity(slot, 64)).toBe(pack(slot, 64));
    }
  });

  // Mixed gen values across different slots
  it('encodeEntity(s, g) === pack(s, g) for cross-product of {0,1,42,1024,16777215} x {0,5,17,128,255}', () => {
    const slots = [0, 1, 42, 1024, 16777215];
    const gens = [0, 5, 17, 128, 255];
    for (const slot of slots) {
      for (const gen of gens) {
        expect(encodeEntity(slot, gen)).toBe(pack(slot, gen));
      }
    }
  });
});

describe('[w3] Entity codec parity -- decode functions', () => {
  const CASES: [number, number][] = [
    [0, 0],
    [1, 0],
    [42, 5],
    [1024, 128],
    [16777215, 255],
    [0, 64],
    [1, 255],
    [16777215, 0],
    [1023, 17],
  ];

  it('decodeEntity(pack(s, g)) returns { index: s, generation: g }', () => {
    for (const [slot, gen] of CASES) {
      const raw = pack(slot, gen) as EntityHandle;
      const { index, generation } = decodeEntity(raw);
      expect(index).toBe(slot);
      expect(generation).toBe(gen);
    }
  });

  it('entityIndex(pack(s, g)) === unpackSlot(pack(s, g))', () => {
    for (const [slot, gen] of CASES) {
      const raw = pack(slot, gen) as EntityHandle;
      expect(entityIndex(raw)).toBe(unpackSlot(raw));
    }
  });

  it('entityGeneration(pack(s, g)) === unpackGen(pack(s, g))', () => {
    for (const [slot, gen] of CASES) {
      const raw = pack(slot, gen) as EntityHandle;
      expect(entityGeneration(raw)).toBe(unpackGen(raw));
    }
  });

  // Full round-trip: encodeEntity -> entityIndex/entityGeneration
  it('entityIndex(encodeEntity(s, g)) === s', () => {
    for (const [slot, gen] of CASES) {
      expect(entityIndex(encodeEntity(slot, gen))).toBe(slot);
    }
  });

  it('entityGeneration(encodeEntity(s, g)) === g', () => {
    for (const [slot, gen] of CASES) {
      expect(entityGeneration(encodeEntity(slot, gen))).toBe(gen);
    }
  });
});
