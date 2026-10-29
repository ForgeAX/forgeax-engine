import { testPlatform } from './platform-fixture';
// create-app-plugin.test.ts -- createApp + Cordis integration.
//
// Covers:
//   - The canvas-form default plugin set registers the expected world systems.
//   - AC-02: physics + audio plugins register the expected world system set
//     (physics tick systems + 'PhysicsWorld' resource; audio-tick).
//   - A failing plugin activation surfaces as an AppError with its cause.
//   - physics3d's async apply completes BEFORE createApp resolves
//     (no post-resolve timing gap -- app.physics is populated immediately).
//
// Environment: the assemble form is driven with a renderer stub (no WebGPU),
// exercising the real createApp -> Context.plugin path. The rapier 3D WASM backend
// loads in dawn-node, so the physics path runs for real; if it ever becomes
// unavailable the physics-dependent cases skip with a reason (per plan-strategy
// section 5.4 no-skip-by-default).
//
// charter awareness:
//   P2 structured > prose: assertions read world.inspect().systems (a
//       machine-readable enumeration), not pixels.
//   P3 explicit failure: activation failures assert structured AppError detail.

import { animationPlugin } from '@forgeax/engine-animation';
import {
  AUDIO_ENGINE_RESOURCE_KEY,
  AUDIO_TICK_SYSTEM_NAME,
  audioBackendPlugin,
  audioPlugin,
  createAudioIntentBackend,
} from '@forgeax/engine-audio';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, inputBackendPlugin } from '@forgeax/engine-input';
import physics3d from '@forgeax/engine-physics-rapier3d';
import type { Context, Plugin } from '@forgeax/engine-plugin';
import type { Renderer } from '@forgeax/engine-render';
import { scenePlugin } from '@forgeax/engine-scene';
import { statePlugin } from '@forgeax/engine-state';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../create-app';
import { inputPlugin } from '../plugin-factories';

function makeRendererStub(): Renderer {
  const ready: Promise<{ ok: true; value: undefined }> = Promise.resolve({
    ok: true,
    value: undefined,
  });
  return {
    backend: 'webgpu' as const,
    ready,
    draw: (): { ok: true; value: undefined } => ({ ok: true, value: undefined }),
    onError: (): (() => void) => () => {},
    onLost: (): (() => void) => () => {},
    assets: {},
    dispose: (): void => {},
  } as unknown as Renderer;
}

function systemNames(world: World): string[] {
  return world.inspect().systems.map((s) => s.name);
}

// Probe whether the rapier 3D WASM backend loads in this environment.
// Physics-dependent cases skip explicitly (it.skipIf) when unavailable,
// rather than silently returning from the test body (charter P3: explicit
// failure > silent behaviour).
let rapierAvailable = false;
beforeAll(async () => {
  try {
    const m = await import('@forgeax/engine-physics-rapier3d');
    const rapier = await m.loadRapier3D();
    m.createRapier3DPhysicsWorld(rapier);
    rapierAvailable = true;
  } catch {
    rapierAvailable = false;
  }
});

describe('createApp plugin runner -- default set (AC-03)', () => {
  it('the canvas default set is transform/animation/state/input', async () => {
    // The canvas form's default set, run directly against a World (no renderer
    // needed). INPUT_BACKEND_KEY is pre-inserted so inputPlugin registers its
    // scan system (mirrors createApp's app-layer input attach).
    const world = new World();
    const defaultSet: Plugin[] = [
      inputBackendPlugin({ sample: () => ({}) } as never),
      scenePlugin(),
      animationPlugin(),
      statePlugin(),
      inputPlugin(),
    ];
    const ctx = await createWorldContext(world, defaultSet);
    expect([...ctx.registry.values()].map((runtime) => runtime.name)).toEqual([
      'world',
      'input-backend',
      'scene',
      'animation',
      'state',
      'input',
    ]);

    // World systems registered by the default set.
    const names = systemNames(world);
    expect(names).toContain('propagateTransforms');
    expect(names).toContain('advanceAnimationPlayer');
    expect(names).toContain('transitionStates');
    expect(names).toContain('input-frame-start-scan');
    expect(world.hasResource(INPUT_SNAPSHOT_RESOURCE_KEY)).toBe(true);

    await ctx.fiber.dispose();
    const disposedNames = systemNames(world);
    expect(disposedNames).not.toContain('propagateTransforms');
    expect(disposedNames).not.toContain('advanceAnimationPlayer');
    expect(disposedNames).not.toContain('transitionStates');
    expect(disposedNames).not.toContain('input-frame-start-scan');
    expect(world.hasResource(INPUT_SNAPSHOT_RESOURCE_KEY)).toBe(false);
  });

  it('inputPlugin remains pending while its backend service is unavailable', async () => {
    const world = new World();
    const ctx = await createWorldContext(world, [inputPlugin()]);
    expect(ctx.input).toBeUndefined();
    expect(systemNames(world)).not.toContain('input-frame-start-scan');
  });
});

describe('createApp plugin runner -- physics + audio system set (AC-02)', () => {
  it('audioPlugin registers the audio-tick system when the backend resource is present', async () => {
    const world = new World();
    const ctx = await createWorldContext(world, [
      audioBackendPlugin(createAudioIntentBackend({ emit: () => undefined })),
      audioPlugin(),
    ]);
    expect(systemNames(world)).toContain(AUDIO_TICK_SYSTEM_NAME);
    await ctx.fiber.dispose();
    expect(systemNames(world)).not.toContain(AUDIO_TICK_SYSTEM_NAME);
    expect(world.hasResource(AUDIO_ENGINE_RESOURCE_KEY)).toBe(false);
  });

  it('physics3d inserts PhysicsWorld + registers physics systems on success', {
    skip: !rapierAvailable,
  }, async () => {
    const world = new World();
    const ctx = await createWorldContext(world, [physics3d]);
    expect(world.hasResource('PhysicsWorld')).toBe(true);
    // AC-02: physics registers its three-phase tick systems. Assert the
    // expected system names are present (plan-strategy section 5.2
    // enumeration vs. old opts path system set).
    const names = systemNames(world);
    expect(names).toContain('physicsSyncBackend');
    expect(names).toContain('physicsStepSimulation');
    expect(names).toContain('physicsWriteback');
    await ctx.fiber.dispose();
    expect(world.hasResource('PhysicsWorld')).toBe(false);
    expect(systemNames(world)).not.toContain('physicsSyncBackend');
    expect(systemNames(world)).not.toContain('physicsStepSimulation');
    expect(systemNames(world)).not.toContain('physicsWriteback');
  });
});

describe('createApp Cordis registry identity', () => {
  it('permits separate fibers to share a diagnostic name', async () => {
    const result = await createApp({
      platform: testPlatform(),
      renderer: makeRendererStub(),
      world: new World(),
      plugins: [audioPlugin(), audioPlugin()],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      [...result.value.pluginContext.registry.values()].filter(
        (runtime) => runtime.name === 'audio',
      ),
    ).toHaveLength(2);
    await result.value.dispose();
  });
});

describe('createApp plugin runner -- build failure (AC-05)', () => {
  it('createApp(assemble) surfaces plugin-apply-failed with detail.cause', async () => {
    const failing: Plugin = {
      name: 'boom',
      apply() {
        throw new Error('simulated WASM failure');
      },
    };
    const result = await createApp({
      platform: testPlatform(),
      renderer: makeRendererStub(),
      world: new World(),
      plugins: [failing],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('app-plugin-activation-failed');
    if (result.error.code !== 'app-plugin-activation-failed') return;
    expect(result.error.detail.cause).toBeInstanceOf(Error);
    expect((result.error.detail.cause as Error).message).toBe('simulated WASM failure');
  });
});

describe('createApp plugin runner -- physics async timing (AC-06)', () => {
  it('exposes a dynamically installed physics provider only after activation', async () => {
    const app = (
      await createApp({
        platform: testPlatform(),
        renderer: makeRendererStub(),
        world: new World(),
      })
    ).unwrap();
    const physics = {} as Context['physics'];
    let finishActivation!: () => void;
    const activation = new Promise<void>((resolve) => {
      finishActivation = resolve;
    });
    let published!: () => void;
    const publication = new Promise<void>((resolve) => {
      published = resolve;
    });
    const fiber = app.pluginContext.plugin({
      name: 'delayed-physics-provider',
      provide: 'physics',
      async apply(ctx) {
        ctx.provide('physics', physics);
        published();
        await activation;
      },
    });
    try {
      await publication;
      expect(app.physics).toBeUndefined();
      finishActivation();
      await fiber.await();
      expect(app.physics).toBe(physics);
      await fiber.dispose();
      expect(app.physics).toBeUndefined();
    } finally {
      finishActivation();
      await app.dispose();
    }
  });

  it('app.physics is populated immediately after createApp resolves (no timing gap)', {
    skip: !rapierAvailable,
  }, async () => {
    const result = await createApp({
      platform: testPlatform(),
      renderer: makeRendererStub(),
      world: new World(),
      plugins: [physics3d],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Because Context.plugin awaits physics3d's async apply before createApp
    // resolves, the 'PhysicsWorld' resource is already present -- app.physics
    // reads it back synchronously with no post-resolve fire-and-forget gap.
    expect(result.value.physics).toBeDefined();
    // Verify the resource is present in the World (not just on the App handle,
    // confirming the physics3d build fully populated it before resolve).
    expect(result.value.world.hasResource('PhysicsWorld')).toBe(true);
    await result.value.dispose();
  });
});
