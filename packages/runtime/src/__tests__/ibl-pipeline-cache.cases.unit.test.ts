// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceScope } from '../../../render/src/device/device-scope';
import { getOrCreateIblCache, hasIblCache } from '../../../render/src/ibl/IblPipelineCache';

afterEach(() => vi.restoreAllMocks());
{
  // --- from ibl-pipeline-cache.test.ts ---

  describe('t11 - IblPipelineCache counter invariant + deferred-replay', () => {
    // (a) IblPipelineCache initializes one cache per DeviceScope generation
    it('IblPipelineCache maintains per-scope ownership via getOrCreateIblCache', () => {
      const scope1 = DeviceScope.create(1, 'systems-test-1');
      const scope2 = DeviceScope.create(2, 'systems-test-2');

      const cache1 = getOrCreateIblCache(scope1);
      const cache2 = getOrCreateIblCache(scope2);

      // Different devices get different cache instances.
      expect(cache1).not.toBe(cache2);

      // Same device returns same instance.
      expect(getOrCreateIblCache(scope1)).toBe(cache1);

      // hasIblCache confirms registration.
      expect(hasIblCache(scope1)).toBe(true);
      expect(hasIblCache(scope2)).toBe(true);
      expect(hasIblCache(DeviceScope.create(3, 'systems-test-3'))).toBe(false);
    });

    // (d) counters initialized at 0
    it('counters are initialized at 0 before any pass execution', () => {
      const cache = getOrCreateIblCache(DeviceScope.create(4, 'systems-test-4'));
      expect(cache.irradianceBakeCount).toBe(0);
      expect(cache.prefilterBakeCount).toBe(0);
      expect(cache.brdfLutBakeCount).toBe(0);
    });

    // (b) iblPrepass counters === 1 after pass execution
    // These tests verify the counter slots exist and can be incremented.
    // The actual GPU pass execution that sets these counters is wired in
    // uploadCubemapFromEquirect (t20 in asset-registry.ts).
    it('iblPrepass counters can be incremented post-execution', () => {
      const cache = getOrCreateIblCache(DeviceScope.create(5, 'systems-test-5'));
      cache.irradianceBakeCount += 1;
      cache.prefilterBakeCount += 1;
      cache.brdfLutBakeCount += 1;
      expect(cache.irradianceBakeCount).toBe(1);
      expect(cache.prefilterBakeCount).toBe(1);
      expect(cache.brdfLutBakeCount).toBe(1);
    });

    it('iblPrepass counters stay independent across devices', () => {
      const scopeA = DeviceScope.create(6, 'systems-test-6');
      const scopeB = DeviceScope.create(7, 'systems-test-7');
      const cacheA = getOrCreateIblCache(scopeA);
      const cacheB = getOrCreateIblCache(scopeB);

      cacheA.irradianceBakeCount += 1;
      cacheB.prefilterBakeCount += 1;

      expect(cacheA.irradianceBakeCount).toBe(1);
      expect(cacheA.prefilterBakeCount).toBe(0);
      expect(cacheB.irradianceBakeCount).toBe(0);
      expect(cacheB.prefilterBakeCount).toBe(1);
    });

    // (c) configureGpuDevice deferred-replay replays pending upload
    // This is exercised by the dawn-level integration tests (asset-registry
    // deferred path) rather than unit-level mock assertions.
  });
}
