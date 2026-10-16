// @forgeax/engine-physics -- physicsPlugin(backend) factory (M2 / w10, plan-strategy D-5 / D-7).
//
// physicsPlugin lives in @forgeax/engine-physics (the interface package, C-9)
// and accepts an interface->backend dependency inversion: its async apply
// dynamic-imports the rapier 2D / 3D backend on demand. The backends are
// optional peerDependencies in this package's package.json (a regular
// dependency would form a physics <-> rapier cycle since the backends depend on
// the interface package); the consuming app declares the selected runtime dep.
//
// charter awareness:
//   P3 explicit failure: WASM load failure rejects plugin activation and the
//       App boundary preserves the cause; it is never a silent skip.
//   P4 consistent abstraction: physicsPlugin shares the same Plugin shape as
//       transform / audio -- one mental model covers every wiring.

import type { Plugin } from '@forgeax/engine-plugin';
import { scenePlugin } from '@forgeax/engine-scene';
import { registerPhysicsComponents } from './components.js';
import { PhysicsError } from './errors.js';
import { loadRapier2DBackend, loadRapier3DBackend } from './load-rapier-backend.mjs';
import { registerMobilityPhysicsConflict } from './mobility-conflict.js';
import type { PhysicsWorld, PhysicsWorld2D } from './physics-world.js';

interface Rapier3DBackendModule {
  loadRapier3D(): Promise<unknown>;
  createRapier3DPhysicsWorld(rapier: unknown): PhysicsWorld;
  registerPhysicsSystems(world: import('@forgeax/engine-ecs').World): () => void;
}

interface Rapier2DBackendModule {
  loadRapier2D(): Promise<unknown>;
  createRapier2DPhysicsWorld(rapier: unknown): PhysicsWorld2D;
  registerPhysicsSystems2D(world: import('@forgeax/engine-ecs').World): () => void;
}

/** Rapier backend selector. */
export type PhysicsBackend = 'rapier-2d' | 'rapier-3d';

/**
 * Install the built-in physics component vocabulary without starting a
 * simulation backend. Resource previews use this narrow plugin so a valid
 * SceneAsset can be instantiated in a fresh World even when Rapier is not
 * part of that preview's execution assembly.
 */
export function physicsComponentsPlugin(): Plugin {
  return {
    name: 'physics-components',
    inject: ['world'],
    apply(ctx) {
      ctx.effect(() => registerPhysicsComponents(ctx.world), 'physics/components');
    },
  };
}

function normalizeWasmLoadFailure(backend: PhysicsBackend, cause: unknown): PhysicsError {
  if (cause instanceof PhysicsError && cause.code === 'wasm-load-failed') return cause;
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new PhysicsError({
    code: 'wasm-load-failed',
    expected: `successful import and WASM initialization for ${backend}`,
    hint: `Rapier backend activation failed: ${reason}`,
    detail: { code: 'wasm-load-failed', reason },
  });
}

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    physics?: PhysicsWorld | PhysicsWorld2D;
  }
}

/**
 * physicsPlugin(backend) dynamically imports the Rapier backend,
 * loads the WASM module, creates the PhysicsWorld, inserts it as the
 * 'PhysicsWorld' world resource, and registers the three-phase tick systems.
 *
 * The resource is inserted before registering systems so moveAndSlide resolves
 * `PhysicsWorld` on the first tick. Cordis owns rollback if any later effect
 * fails.
 *
 * @param backend 'rapier-2d' or 'rapier-3d'
 */
export function physicsPlugin(backend: PhysicsBackend): Plugin {
  return {
    name: 'physics',
    inject: ['world'],
    provide: 'physics',
    async apply(ctx) {
      await ctx.plugin(scenePlugin());
      const world = ctx.world;
      let physics: PhysicsWorld | PhysicsWorld2D;
      let registerSystems: () => () => void;
      if (backend === 'rapier-3d') {
        let module: Rapier3DBackendModule;
        let rapier: unknown;
        try {
          module = (await loadRapier3DBackend()) as Rapier3DBackendModule;
          rapier = await module.loadRapier3D();
        } catch (cause) {
          throw normalizeWasmLoadFailure(backend, cause);
        }
        if (rapier instanceof PhysicsError) throw normalizeWasmLoadFailure(backend, rapier);
        const { createRapier3DPhysicsWorld, registerPhysicsSystems } = module;
        physics = createRapier3DPhysicsWorld(rapier);
        registerSystems = () => registerPhysicsSystems(world);
      } else {
        let module: Rapier2DBackendModule;
        let rapier: unknown;
        try {
          module = (await loadRapier2DBackend()) as Rapier2DBackendModule;
          rapier = await module.loadRapier2D();
        } catch (cause) {
          throw normalizeWasmLoadFailure(backend, cause);
        }
        if (rapier instanceof PhysicsError) throw normalizeWasmLoadFailure(backend, rapier);
        const { createRapier2DPhysicsWorld, registerPhysicsSystems2D } = module;
        physics = createRapier2DPhysicsWorld(rapier);
        registerSystems = () => registerPhysicsSystems2D(world);
      }
      ctx.effect(() => registerPhysicsComponents(world), 'physics/components');
      ctx.effect(() => {
        world.insertResource('PhysicsWorld', physics);
        return () => {
          world.removeResource('PhysicsWorld');
          physics.dispose();
        };
      }, 'physics/resource');
      ctx.effect(() => {
        const unregister = registerSystems();
        return () => unregister();
      }, 'physics/systems');
      ctx.effect(() => registerMobilityPhysicsConflict(world), 'physics/mobility-conflict');
      ctx.provide('physics', physics);
    },
  };
}
