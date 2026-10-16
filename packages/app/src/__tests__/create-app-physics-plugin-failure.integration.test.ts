import { World } from '@forgeax/engine-ecs';
import { PhysicsError, physicsPlugin } from '@forgeax/engine-physics';
import type { Renderer } from '@forgeax/engine-render';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../create-app';
import { testPlatform } from './platform-fixture';

const rapier3d = vi.hoisted(() => ({
  load: vi.fn(),
  createWorld: vi.fn(),
  registerSystems: vi.fn(),
}));

const rapier2d = vi.hoisted(() => ({
  load: vi.fn(),
  createWorld: vi.fn(),
  registerSystems: vi.fn(),
}));

vi.mock('@forgeax/engine-physics-rapier3d', () => ({
  loadRapier3D: rapier3d.load,
  createRapier3DPhysicsWorld: rapier3d.createWorld,
  registerPhysicsSystems: rapier3d.registerSystems,
}));

vi.mock('@forgeax/engine-physics-rapier2d', () => ({
  loadRapier2D: rapier2d.load,
  createRapier2DPhysicsWorld: rapier2d.createWorld,
  registerPhysicsSystems2D: rapier2d.registerSystems,
}));

function rendererStub(): Renderer {
  return {
    backend: 'webgpu',
    ready: Promise.resolve({ ok: true, value: undefined }),
    draw: () => ({ ok: true, value: undefined }),
    onError: () => () => {},
    onLost: () => () => {},
    assets: {},
    dispose: () => {},
  } as unknown as Renderer;
}

function injectedWasmFailure(backend: '2D' | '3D', reason: string): PhysicsError {
  return new PhysicsError({
    code: 'wasm-load-failed',
    expected: `the injected Rapier ${backend} loader to become ready`,
    hint: `injected failure: ${reason}`,
    detail: { code: 'wasm-load-failed', reason },
  });
}

describe('createApp Rapier 3D activation failure', () => {
  beforeEach(() => {
    rapier3d.load.mockReset();
    rapier3d.createWorld.mockReset();
    rapier3d.registerSystems.mockReset();
  });

  it.each([
    {
      phase: 'loader return',
      inject: () => rapier3d.load.mockResolvedValue(injectedWasmFailure('3D', 'loader return')),
    },
    {
      phase: 'compat import',
      inject: () => rapier3d.load.mockRejectedValue(new Error('injected compat import rejection')),
    },
    {
      phase: 'WASM init',
      inject: () => rapier3d.load.mockRejectedValue(new Error('injected WASM init rejection')),
    },
  ])('normalizes $phase before PhysicsWorld creation', async ({ inject }) => {
    inject();
    const world = new World();

    const result = await createApp({
      platform: testPlatform(),
      renderer: rendererStub(),
      world,
      plugins: [physicsPlugin('rapier-3d')],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('app-plugin-activation-failed');
    if (result.error.code !== 'app-plugin-activation-failed') return;
    expect(result.error.detail.cause).toMatchObject({
      name: 'PhysicsError',
      code: 'wasm-load-failed',
      detail: { code: 'wasm-load-failed' },
    });
    expect(rapier3d.createWorld).not.toHaveBeenCalled();
    expect(rapier3d.registerSystems).not.toHaveBeenCalled();
    expect(world.hasResource('PhysicsWorld')).toBe(false);
    expect(world.update(0)).toMatchObject({ ok: true });
  });
});

describe('createApp Rapier 2D activation failure', () => {
  beforeEach(() => {
    rapier2d.load.mockReset();
    rapier2d.createWorld.mockReset();
    rapier2d.registerSystems.mockReset();
  });

  it.each([
    {
      phase: 'loader return',
      inject: () => rapier2d.load.mockResolvedValue(injectedWasmFailure('2D', 'loader return')),
    },
    {
      phase: 'compat import',
      inject: () => rapier2d.load.mockRejectedValue(new Error('injected compat import rejection')),
    },
    {
      phase: 'WASM init',
      inject: () => rapier2d.load.mockRejectedValue(new Error('injected WASM init rejection')),
    },
  ])('normalizes $phase before PhysicsWorld creation', async ({ inject }) => {
    inject();
    const world = new World();

    const result = await createApp({
      platform: testPlatform(),
      renderer: rendererStub(),
      world,
      plugins: [physicsPlugin('rapier-2d')],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('app-plugin-activation-failed');
    if (result.error.code !== 'app-plugin-activation-failed') return;
    expect(result.error.detail.cause).toMatchObject({
      name: 'PhysicsError',
      code: 'wasm-load-failed',
      detail: { code: 'wasm-load-failed' },
    });
    expect(rapier2d.createWorld).not.toHaveBeenCalled();
    expect(rapier2d.registerSystems).not.toHaveBeenCalled();
    expect(world.hasResource('PhysicsWorld')).toBe(false);
    expect(world.update(0)).toMatchObject({ ok: true });
  });
});
