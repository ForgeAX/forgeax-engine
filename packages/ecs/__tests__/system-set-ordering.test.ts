import { Update } from '../src/schedule-token';

import { describe, expect, it } from 'vitest';
import { defineSystem, defineSystemSet } from '../src/schedule';
import { World } from '../src/world';

describe('system-set-ordering.test.ts', () => {
  describe('AC-06 — chain serial execution', () => {
    it('chain set members execute in strict registration order', () => {
      const chainSet = defineSystemSet({ name: 'chained', chained: true });
      const world = new World();
      const log: string[] = [];

      const c1 = defineSystem({ name: 'ch1', queries: [], fn: () => log.push('ch1') });
      const c2 = defineSystem({ name: 'ch2', queries: [], fn: () => log.push('ch2') });
      const c3 = defineSystem({ name: 'ch3', queries: [], fn: () => log.push('ch3') });

      world.addSystems(Update, chainSet, [c1, c2, c3]);
      world.update();

      expect(log).toEqual(['ch1', 'ch2', 'ch3']);
    });

    it('chain order accumulates across multiple addSystems calls', () => {
      const chainSet = defineSystemSet({ name: 'chained-acc', chained: true });
      const world = new World();
      const log: string[] = [];

      const c1 = defineSystem({ name: 'ca1', queries: [], fn: () => log.push('ca1') });
      const c2 = defineSystem({ name: 'ca2', queries: [], fn: () => log.push('ca2') });
      const c3 = defineSystem({ name: 'ca3', queries: [], fn: () => log.push('ca3') });
      const c4 = defineSystem({ name: 'ca4', queries: [], fn: () => log.push('ca4') });

      world.addSystems(Update, chainSet, [c1, c2]);
      world.addSystems(Update, chainSet, [c3, c4]);
      world.update();

      // Members accumulate in insertion order: c1, c2, c3, c4
      expect(log).toEqual(['ca1', 'ca2', 'ca3', 'ca4']);
    });

    it('chain with single member executes normally', () => {
      const chainSet = defineSystemSet({ name: 'chained-single', chained: true });
      const world = new World();
      const log: string[] = [];

      const c1 = defineSystem({ name: 'cs1', queries: [], fn: () => log.push('cs1') });
      world.addSystems(Update, chainSet, [c1]);
      world.update();

      expect(log).toEqual(['cs1']);
    });

    it('chain + explicit member before/after conflict → fail-fast CyclicDependencyError', () => {
      const chainSet = defineSystemSet({ name: 'chained-conflict', chained: true });
      const world = new World();

      const c1 = defineSystem({
        name: 'cc1',
        queries: [],
        fn: () => {},
        after: ['cc2'], // c1 after c2, but chain makes c1 before c2 → cycle
      });
      const c2 = defineSystem({ name: 'cc2', queries: [], fn: () => {} });

      world.addSystems(Update, chainSet, [c1, c2]);
      const result = world.update();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('cyclic-dependency');
    });

  });

  describe('AC-04 — structured detail.cycle', () => {
    it('pure system-level cycle (no sets) → detail.cycle is string[]', () => {
      const world = new World();

      world.addSystem(Update, { name: 'pure-a', queries: [], fn: () => {}, after: ['pure-c'] });
      world.addSystem(Update, { name: 'pure-b', queries: [], fn: () => {}, after: ['pure-a'] });
      world.addSystem(Update, { name: 'pure-c', queries: [], fn: () => {}, after: ['pure-b'] });

      const result = world.update();
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.code === 'cyclic-dependency') {
        expect(result.error.detail.cycle).toBeInstanceOf(Array);
        expect(result.error.detail.cycle.length).toBeGreaterThanOrEqual(2);
        expect(result.error.detail.cycle).toContain('pure-a');
        expect(result.error.detail.cycle).toContain('pure-b');
        expect(result.error.detail.cycle).toContain('pure-c');
      }
    });

    it('detail.cycle is accessible as readonly property without message parsing', () => {
      const world = new World();

      world.addSystem(Update, { name: 'nomsg-a', queries: [], fn: () => {}, after: ['nomsg-b'] });
      world.addSystem(Update, { name: 'nomsg-b', queries: [], fn: () => {}, after: ['nomsg-a'] });

      const result = world.update();
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.code === 'cyclic-dependency') {
        const cycle = result.error.detail.cycle;
        // Direct array access — no string parsing needed
        const first = cycle[0];
        expect(typeof first).toBe('string');
        expect(cycle.length).toBeGreaterThanOrEqual(2);
      }
    });
  });
});
