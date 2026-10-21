// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import { World } from '@forgeax/engine-ecs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getTransparentSortConfig,
  setTransparentSortConfig,
} from '../../../render/src/systems/transparent-sort-config';

afterEach(() => vi.restoreAllMocks());
{
  // --- from transparent-sort-config-set.test.ts ---

  const EXPECTED_HINT = '0=layer-z, 1=layer-y, 2=layer-yz, 3=distance';
  // requirements AC-15 + plan-strategy D-4 lock the literal text. The math
  // symbol \u2208 is ASCII-safe via escape; the source file stays ASCII-only.
  const EXPECTED_EXPECTED = 'mode \u2208 {0, 1, 2, 3}';

  // \u2500\u2500\u2500 w2: mode=3 Distance mode acceptance (TDD red phase) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  // AC-04: setTransparentSortConfig must accept mode=3 and must reject
  // out-of-range modes with .expected text reflecting the {0,1,2,3} range.
  // Red assertion: VALID_MODES does not yet contain 3, so mode=3 returns
  // err here (red). mode=99 returns err but .expected still says {0,1,2}
  // instead of {0,1,2,3} (also red).

  describe('w2 - setTransparentSortConfig mode=3 / mode=99 (TDD red)', () => {
    it('mode=3 returns Result.ok (currently red: VALID_MODES missing 3)', () => {
      const world = new World();
      const r = setTransparentSortConfig(world, { mode: 3, yzAlpha: 1.0 });
      // Red: VALID_MODES is {0,1,2} so mode=3 is rejected.
      expect(r.ok).toBe(true);
    });

    it('mode=99 returns Result.err with .expected containing 3 (currently red: .expected says {0,1,2})', () => {
      const world = new World();
      const r = setTransparentSortConfig(world, { mode: 99, yzAlpha: 1.0 });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      const e = r.error;
      expect(e.code).toBe('resource-invalid-value');
      // Red: .expected currently says '{0, 1, 2}' not '{0, 1, 2, 3}'.
      expect(e.expected).toContain('3');
    });
  });

  describe('w10 - setTransparentSortConfig mode-invalid -> Result.err', () => {
    for (const mode of [-1, 4, 99] as const) {
      it(`mode = ${mode} returns Result.err with code/expected/hint/detail`, () => {
        const world = new World();
        const r = setTransparentSortConfig(world, { mode, yzAlpha: 1.0 });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        const e = r.error;
        expect(e.code).toBe('resource-invalid-value');
        expect(e.expected).toBe(EXPECTED_EXPECTED);
        expect(e.hint).toBe(EXPECTED_HINT);
        expect(e.detail.receivedMode).toBe(mode);
      });
    }
  });

  describe('w10 - setTransparentSortConfig mode-valid -> Result.ok', () => {
    for (const mode of [0, 1, 2] as const) {
      it(`mode = ${mode} returns Result.ok and persists the resource`, () => {
        const world = new World();
        const r = setTransparentSortConfig(world, { mode, yzAlpha: 1.0 });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const cfg = getTransparentSortConfig(world);
        expect(cfg.mode).toBe(mode);
        expect(cfg.yzAlpha).toBe(1.0);
      });
    }

    it('overwriting an existing config with a valid mode is idempotent', () => {
      const world = new World();
      expect(setTransparentSortConfig(world, { mode: 0, yzAlpha: 1.0 }).ok).toBe(true);
      expect(setTransparentSortConfig(world, { mode: 2, yzAlpha: 0.5 }).ok).toBe(true);
      const cfg = getTransparentSortConfig(world);
      expect(cfg.mode).toBe(2);
      expect(cfg.yzAlpha).toBeCloseTo(0.5, 5);
    });
  });
}
