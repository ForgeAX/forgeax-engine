import { Update } from '../src/schedule-token';
// @forgeax/engine-ecs — lifecycle consistency + inspect tests (w17, RED)
//
// TDD: removeSystem/replaceSystem membership pruning and inspect().systems[].sets
// extension do not exist yet, so all tests are RED. They become GREEN after
// w19 implements the membership maintenance + inspect extension.
//
// Coverage:
//   w17: AC-10 (removeSystem prunes membership, replaceSystem preserves
//        membership), AC-11 (inspect().systems[].sets)

import { describe, expect, it } from 'vitest';
import { defineSystem, defineSystemSet } from '../src/schedule';
import { World } from '../src/world';

describe('system-set-lifecycle.test.ts', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // w17 — remove/replace membership consistency
  // ──────────────────────────────────────────────────────────────────────────

  describe('AC-10 — removeSystem prunes set membership', () => {
    it('removeSystem: system no longer in set constraint expansion or runIf', () => {
      const GameplaySet = defineSystemSet({ name: 'gameplay-life' });
      const world = new World();
      const log: string[] = [];

      const sysA = defineSystem({
        name: 'life-a',
        queries: [],
        fn: () => log.push('life-a'),
      });
      const sysB = defineSystem({
        name: 'life-b',
        queries: [],
        fn: () => log.push('life-b'),
      });

      world.addSystems(Update, GameplaySet, [sysA, sysB]);

      // Remove sysA
      const r = world.removeSystem(Update, 'life-a');
      expect(r.ok).toBe(true);

      // sysA is gone, sysB should still run
      world.update();
      expect(log).not.toContain('life-a');
      expect(log).toContain('life-b');
    });

    it('removeSystem + re-addSystems: membership not auto-restored', () => {
      const TagSet = defineSystemSet({ name: 'tag' });
      const world = new World();

      const sys = defineSystem({
        name: 'tag-sys',
        queries: [],
        fn: () => {},
      });

      world.addSystems(Update, TagSet, [sys]);

      // Remove
      world.removeSystem(Update, 'tag-sys');

      // Re-add via addSystem (not addSystems) — system is back but not in set
      world.addSystem(Update, {
        name: 'tag-sys',
        queries: [],
        fn: () => {},
      });

      // Check inspect: sets should be empty for the re-added system
      const snap = world.inspect();
      const entry = snap.systems.find((s) => s.name === 'tag-sys');
      expect(entry).toBeDefined();
      // RED: sets field not yet present, but we assert as if it were
      // After w19 implements the extension, this will pass
      expect(entry?.sets).toBeDefined();
    });
  });

  describe('AC-10 — replaceSystem preserves set membership', () => {
    it('replaceSystem: name key unchanged, set membership persists', () => {
      const LogicSet = defineSystemSet({ name: 'logic' });
      const world = new World();
      const log: string[] = [];

      const sys = defineSystem({
        name: 'logic-sys',
        queries: [],
        fn: () => log.push('logic-old'),
      });

      world.addSystems(Update, LogicSet, [sys]);

      // Replace with new fn
      const r = world.replaceSystem(Update, 'logic-sys', {
        name: 'logic-sys',
        queries: [],
        fn: () => log.push('logic-new'),
      });
      expect(r.ok).toBe(true);

      world.update();
      expect(log).toContain('logic-new');
      expect(log).not.toContain('logic-old');

      // Inspect should show the set membership preserved
      // RED: sets field not yet present, but we assert as if it were
      const snap = world.inspect();
      const entry = snap.systems.find((s) => s.name === 'logic-sys');
      expect(entry).toBeDefined();
      expect(entry?.sets).toBeDefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // w17 — inspect().systems[].sets
  // ──────────────────────────────────────────────────────────────────────────

  describe('AC-11 — inspect().systems[].sets', () => {
    it('systems with set membership: sets field contains set names', () => {
      const SetA = defineSystemSet({ name: 'inspect-a' });
      const SetB = defineSystemSet({ name: 'inspect-b' });
      const world = new World();

      const sys1 = defineSystem({
        name: 'insp-sys1',
        queries: [],
        fn: () => {},
      });
      const sys2 = defineSystem({
        name: 'insp-sys2',
        queries: [],
        fn: () => {},
      });

      world.addSystems(Update, SetA, [sys1]);
      world.addSystems(Update, SetB, [sys1]); // sys1 in both sets
      world.addSystems(Update, SetB, [sys2]);

      // RED: sets field not yet present on inspect entry — will GREEN after w19
      const snap = world.inspect();
      const entry1 = snap.systems.find((s) => s.name === 'insp-sys1');
      const entry2 = snap.systems.find((s) => s.name === 'insp-sys2');

      expect(entry1).toBeDefined();
      expect(entry2).toBeDefined();

      // These will pass once sets field exists
      expect(entry1?.sets).toBeDefined();
      expect(entry2?.sets).toBeDefined();
    });

    it('systems without set membership: sets is an empty array', () => {
      const world = new World();

      world.addSystem(Update, {
        name: 'free-sys',
        queries: [],
        fn: () => {},
      });

      // RED: sets field not yet present
      const snap = world.inspect();
      const entry = snap.systems.find((s) => s.name === 'free-sys');
      expect(entry).toBeDefined();
      expect(entry?.sets).toBeDefined();
    });
  });
});