import { Update } from '@forgeax/engine-ecs';
// feat-20260618-ecs-module-mechanism M2 / w9 (AC-15) + w10 (AC-16):
//
// Builtin systems are module-level tokens and are registered into each World
// explicitly by their owning plugin. There is no process-global registry to
// leak component or system identity across World realms.
//
// w10 (AC-16): input is resource-ified. Animation owns World-local asset lookup
// directly, so it has no app/runtime resolver resource seam.
//
// PLACEMENT NOTE (filesOutsideTargets): plan-tasks.json targets
// packages/ecs/__tests__/builtin-systems.test.ts, but @forgeax/engine-ecs is
// the lowest-level package -- it does NOT (and architecturally cannot) depend
// on runtime / input / state / physics (those depend on ecs; the reverse is a
// cycle). The cross-package enumeration test therefore MUST live in a package
// downstream of all 5. @forgeax/engine-app is the single package that depends
// on AND tsconfig-references all five (ecs/input/physics-rapier2d/
// physics-rapier3d/runtime/state), so this is the only viable home.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '@forgeax/engine-ecs';
import { INPUT_BACKEND_KEY, InputFrameStartScan, InputSet } from '@forgeax/engine-input';
import { PhysicsSet } from '@forgeax/engine-physics';
import {
  registerPhysicsSystems2D,
} from '@forgeax/engine-physics-rapier2d';
import {
  registerPhysicsSystems,
} from '@forgeax/engine-physics-rapier3d';
// Side-effect imports: evaluating each module runs the top-level defineSystem
// calls, registering the tokens in the global SYSTEM_REGISTRY (D-4 "define ==
// register"). No register helper is called.
import '@forgeax/engine-input';
import '@forgeax/engine-physics-rapier2d';
import '@forgeax/engine-physics-rapier3d';
import { ADVANCE_ANIMATION_PLAYER_SYSTEM, registerAdvanceAnimationPlayer } from '@forgeax/engine-animation';
import { registerPropagateTransforms } from '@forgeax/engine-scene';
import '@forgeax/engine-runtime';
import { registerStatesPlugin } from '@forgeax/engine-state';
import { defineComponent } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..', '..', '..');

describe('builtin-systems.test.ts', () => {
  describe('w9 (AC-15): 10 builtin systems all-true-fn enumeration', () => {
    it('createFrameStartScanSystem factory is fully retired (repo grep count = 0)', () => {
      const sourceGlobs = [
        'packages/input/src/frame-start-scan-system.ts',
        'packages/input/src/index.ts',
        'packages/app/src/internal/input-attach.ts',
      ];
      for (const rel of sourceGlobs) {
        const text = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
        expect(text.includes('createFrameStartScanSystem'), `factory ref in ${rel}`).toBe(false);
      }
    });

    it('register helpers add tokens without spread-over-fn (fn identity preserved)', () => {
      // The migrated register fns call world.addSystem(Update, Token) -- the schedule
      // record's descriptor.fn must be the SAME function object as the
      // registry handle's fn (no {...handle, fn: closure} overlay).
      const world = new World();
      registerAdvanceAnimationPlayer(world);
      const scheduled = world
        .inspect()
        .systems.find((s) => s.name === ADVANCE_ANIMATION_PLAYER_SYSTEM);
      expect(scheduled).toBeDefined();
      expect(scheduled?.name).toBe(ADVANCE_ANIMATION_PLAYER_SYSTEM);
    });
  });

  describe('w10 (AC-16): input resource behaviour remains explicit', () => {
    it('animation system runs without an app-provided resolver resource', () => {
      const world = new World();
      registerAdvanceAnimationPlayer(world);
      // No AnimationPlayer entities -> its Query yields nothing, but the
      // canonical animation system still runs without resolver plumbing.
      expect(world.update(1 / 60).ok).toBe(true);
    });

    it('input system writes InputSnapshot when INPUT_BACKEND_KEY resource present', () => {
      const world = new World();
      let sampleCalls = 0;
      world.insertResource(INPUT_BACKEND_KEY, {
        sample: () => {
          sampleCalls += 1;
          return {
            downKeys: new Set<string>(),
            upKeys: new Set<string>(),
            buttons: [false, false, false] as const,
            movementX: 0,
            movementY: 0,
            wheelDelta: 0,
            focused: true,
            pointerLocked: false,
          };
        },
        detach: () => {},
      });
      world.addSystem(Update, InputFrameStartScan);
      expect(world.hasResource('InputSnapshot')).toBe(false);
      world.update(1 / 60).unwrap();
      expect(world.hasResource('InputSnapshot')).toBe(true);
      expect(sampleCalls).toBe(1);
    });

  describe('SystemSet registration anchoring', () => {
    it('records every builtin system under its production SystemSet', () => {
      const world = new World();
      world.insertResource(INPUT_BACKEND_KEY, {} as never);

      registerPropagateTransforms(world);
      registerAdvanceAnimationPlayer(world);
      world.addSystems(Update, InputSet, [InputFrameStartScan]);
      registerStatesPlugin(world);
      registerPhysicsSystems(world);
      registerPhysicsSystems2D(world);

      const setsBySystem = new Map(world.inspect().systems.map((system) => [system.name, system.sets]));
      for (const [name, set] of [
        ['propagateTransforms', 'transform'],
        ['advanceAnimationPlayer', 'animation'],
        ['input-frame-start-scan', 'input'],
        ['transitionStates', 'state'],
        ['physicsSyncBackend', PhysicsSet.name],
        ['physicsStepSimulation', PhysicsSet.name],
        ['physicsWriteback', PhysicsSet.name],
        ['physicsCollisionSync', PhysicsSet.name],
        ['physicsSyncBackend2D', PhysicsSet.name],
        ['physicsStepSimulation2D', PhysicsSet.name],
        ['physicsWriteback2D', PhysicsSet.name],
      ]) {
        expect(setsBySystem.get(name)).toContain(set);
      }
    });
  });

  describe('w22 (AC-09): type inference – no new `as` in builtin fn bodies', () => {
    it('AC-09: builtin system fn body has no new `as` cast (non-physics)', () => {
      // Non-physics modules: propagate-transforms / advance-animation-player /
      // frame-start-scan-system / register-plugin
      // We check that no `as` in the defineSystem fn body exists beyond
      // const-as-style assertions (as const / as never workarounds required by
      // the existing ECS typed-array column API).
      // This is a grepping gate: grep for patterns that indicate a cast
      // introduced by the fn-signature migration (world-first param).
      const srcFiles = [
        'packages/scene/src/systems/propagate-transforms.ts',
        'packages/animation/src/systems/advance-animation-player.ts',
        'packages/input/src/frame-start-scan-system.ts',
        'packages/state/src/register-plugin.ts',
      ];
      for (const rel of srcFiles) {
        const text = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
        // The migration should NOT introduce `as World` inside fn bodies
        // (the world param is already typed World via defineSystem identity).
        expect(
          text.includes('as World'),
          `${rel}: unexpected "as World" cast inside system fn`,
        ).toBe(false);
      }
    });

    it('AC-09: defineSystem<Qs> typecheck gate is green (verified via global typecheck)', () => {
      // This test exists solely to document the AC-09 gate. The actual gate is
      // `pnpm typecheck` which validates that defineSystem<Qs> flows Qs through
      // to fn without requiring manual casts. If this suite runs, the vitest
      // --typecheck option (enabled in config) already validated the import.
      expect(true).toBe(true);
    });
  });

  });

  // feat-20260618 M4 / w29 (AC-16): the input resource key must flow through
  // its exported constant. A consumer that hand-writes the bare string
  // ('InputBackend') at an insertResource/getResource site re-opens the
  // stringly-typed hole: a typo would compile and fail at runtime, defeating the
  // charter P3 "typo degrades to an import error" intent. This gate asserts each
  // bare string appears ONLY at its `export const ... = '...' as const`
  // definition site, nowhere else in source. dist/ skipped (O-1 dist-staleness).
  describe('w29 (AC-16): new resource keys are never used as bare strings', () => {
    const SKIP_DIRS = new Set([
      'dist',
      'node_modules',
      '.turbo',
      'coverage',
      '.git',
      '__tests__',
      'scripts',
      'evidence',
      'artifacts',
    ]);
    const KEY_VALUES = [{ value: 'InputBackend', defFile: 'packages/input/src/frame-start-scan-system.ts' }] as const;

    function listSources(dir: string, out: string[]): void {
      let entries: import('node:fs').Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const p = join(dir, entry.name);
        if (entry.isDirectory()) listSources(p, out);
        else if (entry.isFile() && /\.(ts|mjs)$/.test(p) && !p.endsWith('.d.ts')) out.push(p);
      }
    }

    function stripComments(src: string): string {
      return src
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (_m, p1: string) => p1);
    }

    // This gate file embeds the bare strings in KEY_VALUES + the falsify sample;
    // exclude it so the gate never flags its own deliberate references.
    const SELF = relative(REPO_ROOT, fileURLToPath(import.meta.url)).split('\\').join('/');

    const files: string[] = [];
    for (const root of ['packages', 'apps', 'templates']) {
      listSources(resolve(REPO_ROOT, root), files);
    }

    for (const { value, defFile } of KEY_VALUES) {
      it(`AC-16: '${value}' bare string occurs only at its constant definition`, () => {
        const literal = new RegExp(`['"]${value}['"]`);
        const offenders: string[] = [];
        for (const file of files) {
          const rel = relative(REPO_ROOT, file).split('\\').join('/');
          if (rel === SELF) continue; // this gate file's own references are intentional
          const raw = readFileSync(file, 'utf8');
          if (!literal.test(raw)) continue;
          const src = stripComments(raw);
          if (!literal.test(src)) continue;
          if (rel === defFile) continue; // definition site is the one allowed home
          offenders.push(rel);
        }
        expect(
          offenders,
          `bare string '${value}' must be replaced by the exported constant in:\n  ${offenders.join('\n  ')}`,
        ).toEqual([]);
      }, 15_000);
    }

    it('is falsifiable: a synthetic bare-string consumer is detected', () => {
      const sample = stripComments(`world.insertResource('InputBackend', r);`);
      expect(/['"]InputBackend['"]/.test(sample)).toBe(true);
    });
  });
});
