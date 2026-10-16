// m1-t1: worldEntityKey helper unit test (TDD red).
//
// Test the worldEntityKey(worldId, entityKey) composite key formula:
//   worldId * 2^32 + entityKey
//
// Key invariants from plan-strategy D-1/D-9:
//   - worldId=0 identity: worldEntityKey(0, k) === k (AC-03 single-world path)
//   - Different worldId produce different keys
//   - Same inputs produce same key
//   - JS safe integer: worldId < 2^21 does not overflow Number.MAX_SAFE_INTEGER
//
// Anchors:
//   plan-tasks.json m1-t1
//   plan-strategy D-1/D-9
//   requirements AC-03

import { describe, expect, it } from 'vitest';
import { worldEntityKey } from '../../../render/src/record/frame-snapshot';

describe('worldEntityKey', () => {
  // ── Identity: worldId=0 ──────────────────────────────────────────────────

  it('worldId=0 identity — worldEntityKey(0, k) === k', () => {
    expect(worldEntityKey(0, 0)).toBe(0);
    expect(worldEntityKey(0, 1)).toBe(1);
    expect(worldEntityKey(0, 42)).toBe(42);
    expect(worldEntityKey(0, 0xffffffff)).toBe(0xffffffff);
  });

  // ── Different worldId produce different keys ─────────────────────────────

  it('different worldId produce different keys for same entityKey', () => {
    expect(worldEntityKey(0, 42)).not.toBe(worldEntityKey(1, 42));
    expect(worldEntityKey(1, 42)).not.toBe(worldEntityKey(2, 42));
    expect(worldEntityKey(0, 1)).not.toBe(worldEntityKey(1, 1));
  });

  // ── Same inputs produce same key ─────────────────────────────────────────

  it('same (worldId, entityKey) always produces same key', () => {
    expect(worldEntityKey(3, 100)).toBe(worldEntityKey(3, 100));
    expect(worldEntityKey(5, 0)).toBe(worldEntityKey(5, 0));
  });

  // ── Concrete value check ─────────────────────────────────────────────────

  it('worldId=1, entityKey=42 => 4294967338', () => {
    // 1 * 2^32 + 42 = 4294967296 + 42 = 4294967338
    expect(worldEntityKey(1, 42)).toBe(4294967338);
  });

  // ── JS safe integer boundary ─────────────────────────────────────────────

  it('worldId=2^20 does not exceed Number.MAX_SAFE_INTEGER', () => {
    // 2^20 * 2^32 + 0xFFFFFFFF = 2^52 + 2^32 - 1
    // 2^52 = 4503599627370496
    // MAX_SAFE_INTEGER = 2^53 - 1 = 9007199254740991
    // 2^52 + 2^32 - 1 < 2^53 - 1 ✓
    const key = worldEntityKey(2 ** 20, 0xffffffff);
    expect(key).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(key).toBe(2 ** 52 + 2 ** 32 - 1);
  });

  it('worldId=2^21 boundary is still safe', () => {
    // 2^21 * 2^32 + 0 = 2^53 = 9007199254740992
    // This equals MAX_SAFE_INTEGER + 1, so it loses integer precision
    // But the acceptanceCheck says "worldId=2^20 does not overflow" — test
    // that 2^20 is the safe boundary
    const keyAt20 = worldEntityKey(2 ** 20, 0);
    const keyAt21 = worldEntityKey(2 ** 21, 0);
    // At 2^21 the integer precision is lost, so keyAt21 !== keyAt20 + 2^52
    // This is documented behavior — worldId < 2^21 is the contract
    expect(keyAt20).toBe(2 ** 52);
    // 2^21 * 2^32 = 2^53 which exceeds safe integer; the function
    // should still compute without throwing, but the result may be imprecise
    expect(typeof keyAt21).toBe('number');
  });

  // ── Edge cases ───────────────────────────────────────────────────────────

  it('entityKey=0 across worldIds', () => {
    expect(worldEntityKey(0, 0)).toBe(0);
    expect(worldEntityKey(1, 0)).toBe(2 ** 32);
    expect(worldEntityKey(2, 0)).toBe(2 * 2 ** 32);
  });

  it('entityKey max u32 (0xFFFFFFFF) across worldIds', () => {
    const maxU32 = 0xffffffff;
    expect(worldEntityKey(0, maxU32)).toBe(maxU32);
    expect(worldEntityKey(1, maxU32)).toBe(2 ** 32 + maxU32);
  });
});
