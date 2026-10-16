import { Update } from '../src/schedule-token';
// @forgeax/engine-ecs — set-level runIf tests (w15, w16, RED)
//
// TDD: set-level runIf cache AND gate in runSchedule() does not exist yet, so all
// runIf tests that rely on set-level condition evaluation will fail (RED). They
// become GREEN after w18 implements the frame-cached AND gate.
//
// Coverage:
//   w15: AC-05 set-level runIf basic behavior (true/false dual-state, eval order,
//        both-set-and-system-runIf-false)
//   w16: AC-05 multi-belong AND, per-frame per-set single eval, cross-frame cache
//        isolation

import { describe, expect, it } from 'vitest';
import { defineSystem, defineSystemSet } from '../src/schedule';
import { World } from '../src/world';

describe('system-set-runif.test.ts', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // w15 — set-level runIf basic behavior
  // ──────────────────────────────────────────────────────────────────────────

  describe('AC-05 — set-level runIf basic behavior', () => {
    it('set runIf false: all systems in set are skipped before query iteration', () => {
      const world = new World();
      const log: string[] = [];
      let conditionValue = false;

      const GameplaySet = defineSystemSet({
        name: 'gameplay',
        runIf: () => conditionValue,
      });

      const sysA = defineSystem({
        name: 'gameplay-a',
        queries: [],
        fn: () => log.push('gameplay-a'),
      });
      const sysB = defineSystem({
        name: 'gameplay-b',
        queries: [],
        fn: () => log.push('gameplay-b'),
      });

      world.addSystems(Update, GameplaySet, [sysA, sysB]);

      // Frame 1: condition is false — systems should not run
      conditionValue = false;
      world.update();
      expect(log).not.toContain('gameplay-a');
      expect(log).not.toContain('gameplay-b');

      // Frame 2: condition is true — systems should run (dual-state guard)
      conditionValue = true;
      world.update();
      expect(log).toContain('gameplay-a');
      expect(log).toContain('gameplay-b');
    });

    it('set runIf evaluated before system-level runIf (order assertion)', () => {
      const world = new World();
      const order: string[] = [];
      let setCondition = true;

      const CheckSet = defineSystemSet({
        name: 'check',
        runIf: () => {
          order.push('set-runIf');
          return setCondition;
        },
      });

      const sys = defineSystem({
        name: 'check-sys',
        queries: [],
        fn: () => order.push('fn'),
        runIf: () => {
          order.push('system-runIf');
          return true;
        },
      });

      world.addSystems(Update, CheckSet, [sys]);
      world.update();

      // set runIf must fire before system runIf
      const setIdx = order.indexOf('set-runIf');
      const sysIdx = order.indexOf('system-runIf');
      expect(setIdx).toBeLessThan(sysIdx);
    });

    it('both set runIf and system runIf false: fn not executed', () => {
      const world = new World();
      let setCondition = false;

      const OffSet = defineSystemSet({
        name: 'off',
        runIf: () => setCondition,
      });

      const sys = defineSystem({
        name: 'off-sys',
        queries: [],
        fn: () => {
          throw new Error('should not be called');
        },
        runIf: () => false,
      });

      world.addSystems(Update, OffSet, [sys]);
      world.update(); // should not throw — both conditions are false, fn skipped
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // w16 — set-level runIf multi-belong AND + eval frequency
  // ──────────────────────────────────────────────────────────────────────────

  describe('AC-05 — multi-belong AND and eval frequency', () => {
    it('system in multiple sets: all set conditions AND, any false skips system', () => {
      const world = new World();
      let condA = true;
      let condB = true;

      const SetA = defineSystemSet({ name: 'multi-a', runIf: () => condA });
      const SetB = defineSystemSet({ name: 'multi-b', runIf: () => condB });
      const log: string[] = [];

      const sys = defineSystem({
        name: 'multi-sys',
        queries: [],
        fn: () => log.push('multi-sys'),
      });

      world.addSystems(Update, SetA, [sys]);
      world.addSystems(Update, SetB, [sys]);

      // Both true: system runs
      condA = true;
      condB = true;
      world.update();
      expect(log).toContain('multi-sys');

      // A true, B false: system skipped
      log.length = 0;
      condA = true;
      condB = false;
      world.update();
      expect(log).not.toContain('multi-sys');

      // A false, B true: system skipped
      log.length = 0;
      condA = false;
      condB = true;
      world.update();
      expect(log).not.toContain('multi-sys');

      // Both false: system skipped
      log.length = 0;
      condA = false;
      condB = false;
      world.update();
      expect(log).not.toContain('multi-sys');
    });

    it('per-frame per-set runIf evaluated at most once (eval count spy)', () => {
      const world = new World();
      let evalCount = 0;

      const SpiedSet = defineSystemSet({
        name: 'spied',
        runIf: () => {
          evalCount++;
          return true;
        },
      });

      const sys1 = defineSystem({
        name: 'spied-sys1',
        queries: [],
        fn: () => {},
      });
      const sys2 = defineSystem({
        name: 'spied-sys2',
        queries: [],
        fn: () => {},
      });

      world.addSystems(Update, SpiedSet, [sys1, sys2]);

      evalCount = 0;
      world.update();
      // Both systems share the same set — runIf should fire exactly once
      expect(evalCount).toBe(1);
    });

    it('cross-frame cache does not leak: condition changes between frames', () => {
      const world = new World();
      let conditionValue = true;

      const ToggleSet = defineSystemSet({
        name: 'toggle',
        runIf: () => conditionValue,
      });
      const log: string[] = [];

      const sys = defineSystem({
        name: 'toggle-sys',
        queries: [],
        fn: () => log.push('toggle-sys'),
      });

      world.addSystems(Update, ToggleSet, [sys]);

      // Frame 1: true
      conditionValue = true;
      world.update();
      expect(log).toContain('toggle-sys');

      // Frame 2: false — cache from frame 1 must NOT leak
      log.length = 0;
      conditionValue = false;
      world.update();
      expect(log).not.toContain('toggle-sys');

      // Frame 3: true again — cache from frame 2 must NOT leak
      log.length = 0;
      conditionValue = true;
      world.update();
      expect(log).toContain('toggle-sys');
    });
  });
});
