import type { World } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';
import { scenePlugin } from '@forgeax/engine-scene';
import { registerPhysicsComponents } from './components.js';
import { PhysicsError } from './errors.js';
import { registerMobilityPhysicsConflict } from './mobility-conflict.js';
import type { PhysicsWorld, PhysicsWorld2D } from './physics-world.js';
import type { PhysicsOptions } from './solver-options.js';

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

/** Backend-owned operations; this contract imports no backend implementation. */
export interface PhysicsPluginBackend {
  readonly name: string;
  load(): Promise<unknown>;
  create(native: unknown, options: PhysicsOptions): PhysicsWorld | PhysicsWorld2D;
  registerSystems(world: World): () => void;
}

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    physics?: PhysicsWorld | PhysicsWorld2D;
  }
}

/** Share native lifetime and failure handling after the caller statically selects a backend. */
export function definePhysicsPlugin(
  backend: PhysicsPluginBackend,
): Plugin.Object<PhysicsOptions | undefined> {
  return {
    name: 'physics',
    inject: ['world'],
    provide: 'physics',
    async apply(ctx, options = {}) {
      await ctx.plugin(scenePlugin());
      const world = ctx.world;
      let native: unknown;
      try {
        native = await backend.load();
        if (native instanceof PhysicsError) throw native;
      } catch (cause) {
        if (cause instanceof PhysicsError && cause.code === 'wasm-load-failed') throw cause;
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new PhysicsError({
          code: 'wasm-load-failed',
          expected: `successful WASM initialization for ${backend.name}`,
          hint: `Physics backend activation failed: ${reason}`,
          detail: { code: 'wasm-load-failed', reason },
        });
      }
      const physics = backend.create(native, options);
      ctx.effect(() => registerPhysicsComponents(world), 'physics/components');
      ctx.effect(() => {
        world.insertResource('PhysicsWorld', physics);
        return () => {
          world.removeResource('PhysicsWorld');
          physics.dispose();
        };
      }, 'physics/resource');
      ctx.effect(() => backend.registerSystems(world), 'physics/systems');
      ctx.effect(() => registerMobilityPhysicsConflict(world), 'physics/mobility-conflict');
      ctx.provide('physics', physics);
    },
  };
}
