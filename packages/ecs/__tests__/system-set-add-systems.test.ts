import { Update } from '../src/schedule-token';
// @forgeax/engine-ecs — addSystems positive tests (w5, RED)
//
// TDD: world.addSystems API does not exist yet, so this file will fail to
// compile (RED). It becomes GREEN after w7 implements the addSystems entry point.
//
// Coverage: AC-02 batch register, multi-belong, dedup (registrationIndex
// unchanged), AC-09 generic inference (fn callback receives Float32Array
// without `as` assertions).

import { describe, expect, expectTypeOf, it } from 'vitest';
import { defineComponent } from '../src/component';
import { defineSystem, defineSystemSet } from '../src/schedule';
import { World } from '../src/world';

const Pos = defineComponent('Pos', { x: 'f32', y: 'f32' });
const Vel = defineComponent('Vel', { dx: 'f32', dy: 'f32' });

describe('system-set-add-systems.test.ts', () => {
  describe('AC-02 — batch register N systems to a set', () => {
    it('addSystems registers N systems and all belong to the set', () => {
      const set = defineSystemSet({ name: 'batch-set' });
      const world = new World();

      const sysA = defineSystem({
        name: 'batch-a',
        queries: [{ with: [Pos] }],
        fn: () => {},
      });
      const sysB = defineSystem({
        name: 'batch-b',
        queries: [{ with: [Vel] }],
        fn: () => {},
      });

      const result = world.addSystems(Update, set, [sysA, sysB]);
      expect(result.ok).toBe(true);

      const snap = world.inspect();
      const a = snap.systems.find((s) => s.name === 'batch-a');
      const b = snap.systems.find((s) => s.name === 'batch-b');
      expect(a).toBeDefined();
      expect(b).toBeDefined();
    });

    it('same system added to multiple sets via separate addSystems calls', () => {
      const setA = defineSystemSet({ name: 'multi-set-a' });
      const setB = defineSystemSet({ name: 'multi-set-b' });
      const world = new World();

      const sys = defineSystem({
        name: 'multi-sys',
        queries: [{ with: [Pos] }],
        fn: () => {},
      });

      const r1 = world.addSystems(Update, setA, [sys]);
      expect(r1.ok).toBe(true);
      const r2 = world.addSystems(Update, setB, [sys]);
      expect(r2.ok).toBe(true);
    });
  });

  describe('D-4 — dedup semantics', () => {
    it('already-registered system second addSystems only adds membership, registrationIndex unchanged', () => {
      const setA = defineSystemSet({ name: 'dedup-set-a' });
      const setB = defineSystemSet({ name: 'dedup-set-b' });
      const world = new World();

      const sys = defineSystem({
        name: 'dedup-sys',
        queries: [{ with: [Pos] }],
        fn: () => {},
      });

      world.addSystems(Update, setA, [sys]);
      // Second call adds to another set, does NOT re-register (no change to registrationIndex).
      world.addSystems(Update, setB, [sys]);

      const snap = world.inspect();
      expect(snap.systemCount).toBe(1);
    });
  });

  describe('AC-09 — generic inference not degraded', () => {
    it('fn callback receives Float32Array without as assertions', () => {
      defineSystem({
        name: 'inf-sys',
        queries: [{ with: [Pos] }],
        fn: (world, results) => {
          // AC-09: the first bundle's Pos.x should be Float32Array without `as` cast.
          const bundle = results[0]![0]!;
          const x: Float32Array = bundle.Pos.x;
          expectTypeOf(x).toEqualTypeOf<Float32Array>();
          void x;
          void world;
        },
      });
      // Define a set and call addSystems — the inference test is compile-time only.
      const set = defineSystemSet({ name: 'inf-set' });
      const world = new World();
      const sys = defineSystem({
        name: 'inf-sys-2',
        queries: [{ with: [Pos] }],
        fn: (world, results) => {
          const bundle = results[0]![0]!;
          const x: Float32Array = bundle.Pos.x;
          expectTypeOf(x).toEqualTypeOf<Float32Array>();
          void x;
          void world;
        },
      });
      const r = world.addSystems(Update, set, [sys]);
      expect(r.ok).toBe(true);
    });
  });
});
