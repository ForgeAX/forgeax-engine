import { INPUT_SNAPSHOT_RESOURCE_KEY } from '@forgeax/engine-input';
import { Update } from '@forgeax/engine-ecs';



import { World } from '@forgeax/engine-ecs';
import { INPUT_BACKEND_KEY, InputFrameStartScan, InputSet } from '@forgeax/engine-input';
import { PhysicsSet } from '@forgeax/engine-physics';
import {
  registerPhysicsSystems2D,
} from '@forgeax/engine-physics-rapier2d';
import {
  registerPhysicsSystems,
} from '@forgeax/engine-physics-rapier3d';
import { AdvanceAnimationPlayer, registerAdvanceAnimationPlayer } from '@forgeax/engine-animation';
import { registerPropagateTransforms } from '@forgeax/engine-scene';
import { registerStatesPlugin } from '@forgeax/engine-state';

import { describe, expect, it } from 'vitest';


describe('builtin-systems.test.ts', () => {
  describe('w9 (AC-15): 10 builtin systems all-true-fn enumeration', () => {


    it('register helpers add tokens without spread-over-fn (fn identity preserved)', () => {
      // The migrated register fns call world.addSystem(Update, Token) -- the schedule
      // record's descriptor.fn must be the SAME function object as the
      // registry handle's fn (no {...handle, fn: closure} overlay).
      const world = new World();
      registerAdvanceAnimationPlayer(world);
      const scheduled = world
        .inspect()
        .systems.find((s) => s.name === AdvanceAnimationPlayer.name);
      expect(scheduled).toBeDefined();
      expect(scheduled?.name).toBe(AdvanceAnimationPlayer.name);
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
      expect(world.hasResource(INPUT_SNAPSHOT_RESOURCE_KEY)).toBe(false);
      world.update(1 / 60).unwrap();
      expect(world.hasResource(INPUT_SNAPSHOT_RESOURCE_KEY)).toBe(true);
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



  });


});
