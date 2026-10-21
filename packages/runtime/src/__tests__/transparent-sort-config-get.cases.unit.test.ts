// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import { World } from '@forgeax/engine-ecs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getTransparentSortConfig,
  TRANSPARENT_SORT_CONFIG_KEY,
} from '../../../render/src/systems/transparent-sort-config';

afterEach(() => vi.restoreAllMocks());
{
  // --- from transparent-sort-config-get.test.ts ---

  let warnSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy?.mockRestore();
    warnSpy = undefined;
    vi.restoreAllMocks();
  });

  describe('w09 - getTransparentSortConfig KV-missing returns default + silent', () => {
    it('KV missing returns { mode: 0, yzAlpha: 1.0 } (horizontal-z default)', () => {
      const world = new World();
      const cfg = getTransparentSortConfig(world);
      expect(cfg.mode).toBe(0);
      expect(cfg.yzAlpha).toBe(1.0);
    });

    it('KV missing does NOT call console.warn (legal default, not error)', () => {
      const world = new World();
      getTransparentSortConfig(world);
      expect(warnSpy?.mock.calls.length).toBe(0);
    });

    it('KV-present path returns inserted value unchanged', () => {
      const world = new World();
      const inserted: TransparentSortConfig = { mode: 1, yzAlpha: 0.5 };
      world.insertResource(TRANSPARENT_SORT_CONFIG_KEY, inserted);
      const cfg = getTransparentSortConfig(world);
      expect(cfg.mode).toBe(1);
      expect(cfg.yzAlpha).toBeCloseTo(0.5, 5);
    });

    it('KV-present read does NOT call console.warn', () => {
      const world = new World();
      world.insertResource(TRANSPARENT_SORT_CONFIG_KEY, { mode: 2, yzAlpha: 0.5 });
      getTransparentSortConfig(world);
      expect(warnSpy?.mock.calls.length).toBe(0);
    });
  });
}
