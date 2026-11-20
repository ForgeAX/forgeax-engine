import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { Disabled } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import {
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import physics3d, { RapierPhysicsWorld3D } from '@forgeax/engine-physics-rapier3d';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { Transform } from '@forgeax/engine-scene';
import type { SceneAsset } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import {
  levelNativeResourcesFixture,
  levelShaderManifestFixture,
} from '../../../render/src/__tests__/level-native-resources-fixture';
import { loadRhiPack } from '../../../render/src/assembly/backend-contract';
import { DirectionalLight } from '../../../render/src/components/directional-light';
import { createApp } from '../create-app';
import { type AppLevelCandidate, appLevelOwner } from '../levels/app-level-owner';
import { testPlatform } from './platform-fixture';

vi.mock('@forgeax/engine-render', () => import('../../../render/src/index'));
vi.mock('@forgeax/engine-render/internal', () => import('../../../render/src/internal'));
vi.mock('@forgeax/engine-physics-rapier3d', () => import('../../../physics-rapier3d/src/index'));

const shaders = await levelShaderManifestFixture();

function levelScene(
  colliderOnly: boolean,
  mesh: Awaited<ReturnType<typeof levelNativeResourcesFixture>>['meshHandle'],
  material: Awaited<ReturnType<typeof levelNativeResourcesFixture>>['materialHandle'],
): SceneAsset {
  return {
    kind: 'scene',
    entities: {
      member: {
        components: {
          Transform: {},
          ...(colliderOnly
            ? {}
            : {
                MeshFilter: { assetHandle: mesh },
                MeshRenderer: { materials: [material] },
              }),
          Collider: { shape: ColliderShapeValue.cuboid, halfExtents: [1, 1, 1] },
        },
      },
      disabled: {
        components: {
          Transform: { pos: [5, 0, 0] },
          Disabled: {},
          Collider: { shape: ColliderShapeValue.sphere, radius: 1 },
        },
      },
    },
  };
}

async function prepareBesideDormantLevel(
  physics: RapierPhysicsWorld3D,
  prepare: (levels: readonly AppLevelCandidate[]) => Promise<void>,
  frame: () => Promise<void>,
  first: AppLevelCandidate,
  createSecond: () => AppLevelCandidate,
): Promise<AppLevelCandidate> {
  const beginResidency = vi.spyOn(physics, '_beginStaticResidency');
  try {
    await prepare([first]);
    const result = beginResidency.mock.results[0];
    assert(result?.type === 'return' && result.value.ok);
    const second = createSecond();
    const readiness = vi.spyOn(result.value.value, 'isCurrent');
    try {
      await frame();
      await frame();
      expect(second.inspect().phase).not.toBe('prepared');
      expect(readiness).not.toHaveBeenCalled();
    } finally {
      readiness.mockRestore();
    }
    await prepare([first, second]);
    return second;
  } finally {
    beginResidency.mockRestore();
  }
}

async function appLifecycle(
  mode: 'cycle' | 'two' | 'cancel' | 'interleave' | 'collider-only' | 'accept-failure',
) {
  let native: GPUDevice | undefined, texture: GPUTexture | undefined;
  const errors: unknown[] = [];
  const context = {
    configure(config: GPUCanvasConfiguration) {
      native = config.device;
      native.addEventListener('uncapturederror', (event) => errors.push(event.error));
      texture?.destroy();
      texture = native.createTexture({
        size: [64, 64],
        format: config.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        viewFormats: config.viewFormats ?? [],
      });
    },
    getCurrentTexture() {
      assert(texture);
      return texture;
    },
    unconfigure() {},
  };
  const f = await levelNativeResourcesFixture(false, 1, true, false, {
    ...shaders,
    canvas: { width: 64, height: 64, getContext: () => context },
    backend: loadRhiPack(webgpu),
  });
  assert(native);
  const composition = f.internals.sceneComposition;
  assert(composition);
  const begin = composition.beginStagedGroup.bind(composition);
  let staged: ReturnType<typeof begin> | undefined;
  const capture = vi.spyOn(composition, 'beginStagedGroup').mockImplementation((...args) => {
    staged = begin(...args);
    return staged;
  });
  let unconfirmedWorld = false;
  const receipts: Promise<unknown>[] = [];
  const original = f.renderer.draw.bind(f.renderer);
  const draws = vi.spyOn(f.renderer, 'draw').mockImplementation((...args) => {
    const result = original(...args);
    if (result.ok) receipts.push(result.value.completed.then((done) => done.unwrap()));
    return result;
  });
  const app = (
    await createApp({
      world: f.world,
      renderer: f.renderer,
      assets: f.assets,
      platform: testPlatform(),
      plugins: [physics3d],
    })
  ).unwrap();
  const run = async () => {
    f.world
      .spawn({ component: DirectionalLight, data: { direction: [0, 0, -1], intensity: 10000 } })
      .unwrap();
    app.start().unwrap();
    app.pause().unwrap();
    const frame = async () => {
      app.stepFrame(1 / 60).unwrap();
      await Promise.all(receipts.splice(0));
    };
    await frame();
    const owner = appLevelOwner(app);
    const scene = f.assets
      .create<SceneAsset>(levelScene(mode === 'collider-only', f.meshHandle, f.materialHandle))
      .unwrap();
    const level = owner.create(scene).unwrap();
    const prepare = async (targets: readonly (typeof level)[]) => {
      for (
        let step = 0;
        step < 1000 &&
        !targets.every(
          (target) => target.inspect().phase === 'prepared' && target.inspect().current,
        );
        step++
      ) {
        await frame();
        for (const target of targets) {
          const status = target.inspect();
          if (status.failure !== undefined) throw status.failure;
          if (status.pending !== undefined && status.pending !== undefined) await status.pending;
        }
      }
      for (const target of targets)
        expect(target.inspect()).toMatchObject({ phase: 'prepared', current: true });
    };
    const cancelDuringNative = async () => {
      for (let step = 0; step < 1000 && level.inspect().phase !== 'native'; step++) {
        await frame();
        const status = level.inspect();
        if (status.failure !== undefined) throw status.failure;
        if (status.pending !== undefined && status.pending !== undefined) await status.pending;
      }
      expect(level.inspect().phase).toBe('native');
      (await app.dispose()).unwrap();
      expect(level.inspect().phase).toBe('retired');
      expect(runtimeAssets(f.assets).inspect().snapshots).toBe(0);
    };
    if (mode === 'cancel') {
      await cancelDuringNative();
      return;
    }
    assert(app.physics instanceof RapierPhysicsWorld3D);
    const physics = app.physics;
    let second: typeof level | undefined;
    if (mode === 'two')
      second = await prepareBesideDormantLevel(physics, prepare, frame, level, () =>
        owner.create(scene).unwrap(),
      );
    else await prepare([level]);
    const partialAcceptFailure = async () => {
      assert(staged?.ok);
      const injected = new Error('injected Source acceptance failure after roster publication');
      const accept = vi.spyOn(staged.value, 'acceptSource').mockImplementationOnce(() => {
        throw injected;
      });
      try {
        level.target('active').unwrap();
        const failed = app.stepFrame(1 / 60);
        expect(failed.ok).toBe(false);
        expect(level.inspect().phase).toBe('failed');
        expect(level.inspect().failure).toBeDefined();
        expect(app.execution.report().engine.health).toBe('faulted');
        expect(f.world.execution.health).toBe('poisoned');
        expect(f.world.update(1 / 60).ok).toBe(false);
      } finally {
        accept.mockRestore();
      }
      const despawn = vi.spyOn(f.world, 'despawn');
      try {
        const closed = await app.dispose();
        unconfirmedWorld = !closed.ok;
        expect(closed.ok).toBe(false);
        const status = level.inspect();
        expect(status.phase).toBe('retire-scene');
        expect(status.cleanupFailure?.detail).toEqual({
          reason: 'world-faulted',
          phase: 'retire-scene',
          world: f.world.identity,
          retainedMembers: 3,
        });
        assert(!closed.ok && closed.error.detail.cause instanceof AggregateError);
        expect(closed.error.detail.cause.errors).toContain(status.cleanupFailure);
        expect(staged.value.inspect().phase).toBe('retired');
        assert(app.physics instanceof RapierPhysicsWorld3D);
        expect(app.physics.getBodyCount()).toBe(0);
        expect(runtimeAssets(f.assets).inspect().snapshots).toBeGreaterThan(0);
        expect(level.members).toHaveLength(3);
        expect(despawn).not.toHaveBeenCalled();
      } finally {
        despawn.mockRestore();
      }
    };
    if (mode === 'accept-failure') {
      await partialAcceptFailure();
      return;
    }
    if (mode === 'interleave') {
      level.target('active').unwrap();
      await frame();
      expect(level.inspect().phase).toBe('active');
      const nativeBegins = vi.spyOn(f.manager, 'prepareInitialSourceViews');
      try {
        second = owner.create(scene).unwrap();
        for (let step = 0; step < 1000 && nativeBegins.mock.calls.length === 0; step++) {
          await frame();
          if (second.inspect().failure !== undefined) throw second.inspect().failure;
        }
        expect(nativeBegins).toHaveBeenCalled();
        expect(second.inspect().phase).toBe('native');
        level.target('prepared').unwrap();
        await frame();
        expect(level.inspect().phase).toBe('prepared');
      } finally {
        nativeBegins.mockRestore();
      }
      await prepare([level, second]);
    }
    expect(level.inspect()).toMatchObject({ phase: 'prepared', current: true, members: 3 });
    const hit = (x = 0) =>
      physics.raycast(vec3.create(x + 0.7, 5, 0), vec3.create(0, -1, 0), 10)?.entity;
    expect(hit()).toBeUndefined();
    expect(hit(5)).toBeUndefined();
    const colliders = level.members.filter((entity) => f.world.hasComponent(entity, Collider));
    expect(colliders).toHaveLength(2);
    const solid = colliders.find(
      (entity) => f.world.get(entity, Collider).unwrap().shape === ColliderShapeValue.cuboid,
    );
    const authored = colliders.find(
      (entity) => f.world.get(entity, Collider).unwrap().shape === ColliderShapeValue.sphere,
    );
    assert(solid !== undefined && authored !== undefined);
    const bodies = colliders.map((entity) => physics.getBodyHandle(entity));
    expect(bodies.every((body) => body !== undefined)).toBe(true);
    const dynamic = f.world
      .spawn(
        { component: Transform, data: { pos: [0, 1.2, 0] } },
        { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic } },
        { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: 0.3 } },
      )
      .unwrap();
    await frame();
    expect(physics.hasBody(dynamic)).toBe(true);
    expect(physics.getCollisionPairs().get(solid)?.has(dynamic) ?? false).toBe(false);
    const creates = vi.spyOn(f.internals.device, 'createBuffer');
    const groups = vi.spyOn(f.internals.device, 'createBindGroup');
    const bundles = vi.spyOn(f.internals.device, 'createRenderBundleEncoder');
    const pipelines = vi.spyOn(f.internals.device, 'createRenderPipeline');
    const asyncPipelines = vi.spyOn(f.internals.device, 'createRenderPipelineAsync');
    try {
      for (const target of ['active', 'prepared', 'active'] as const) {
        level.target(target).unwrap();
        await frame();
        expect(level.inspect()).toMatchObject({ phase: target, current: true });
        expect(hit()).toBe(target === 'active' ? solid : undefined);
        expect(hit(5)).toBeUndefined();
        expect(physics.getCollisionPairs().get(solid)?.has(dynamic) ?? false).toBe(
          target === 'active',
        );
        expect(colliders.map((entity) => physics.getBodyHandle(entity))).toEqual(bodies);
        expect(creates).not.toHaveBeenCalled();
        expect(groups).not.toHaveBeenCalled();
        expect(bundles).not.toHaveBeenCalled();
        expect(pipelines).not.toHaveBeenCalled();
        expect(asyncPipelines).not.toHaveBeenCalled();
      }
    } finally {
      creates.mockRestore();
      groups.mockRestore();
      bundles.mockRestore();
      pipelines.mockRestore();
      asyncPipelines.mockRestore();
    }
    if (second !== undefined) {
      level.target('prepared').unwrap();
      second.target('active').unwrap();
      await frame();
      expect(level.inspect()).toMatchObject({ phase: 'prepared', current: true });
      expect(second.inspect()).toMatchObject({ phase: 'prepared', current: true });
      expect(hit()).toBeUndefined();
      await frame();
      expect(second.inspect()).toMatchObject({ phase: 'active', current: true });
      const secondSolid = second.members.find(
        (entity) =>
          f.world.hasComponent(entity, Collider) &&
          f.world.get(entity, Collider).unwrap().shape === ColliderShapeValue.cuboid,
      );
      assert(secondSolid !== undefined);
      expect(hit()).toBe(secondSolid);
      level.target('unloaded').unwrap();
      for (let step = 0; step < 1000 && level.inspect().phase !== 'retired'; step++) {
        await frame();
        const status = level.inspect();
        if (status.cleanupFailure !== undefined) throw status.cleanupFailure;
        if (status.pending !== undefined) await status.pending;
      }
      expect(level.inspect().phase).toBe('retired');
      expect(hit()).toBe(secondSolid);
    }
    if (second === undefined) expect(f.world.hasComponent(authored, Disabled)).toBe(true);
    // A real stopped App boundary; disposal drains these owners without another update/draw.
    (await app.dispose()).unwrap();
    expect(level.inspect().phase).toBe('retired');
    expect(physics.getBodyCount()).toBe(0);
    expect(runtimeAssets(f.assets).inspect().snapshots).toBe(0);
    expect(errors).toEqual([]);
  };
  const failures: unknown[] = [];
  const attempt = async (work: () => unknown | Promise<unknown>) => {
    try {
      await work();
    } catch (cause) {
      failures.push(cause);
    }
  };
  try {
    await run();
  } catch (cause) {
    failures.push(cause);
  } finally {
    draws.mockRestore();
    capture.mockRestore();
    if (!unconfirmedWorld && app.execution.report().engine.health !== 'stopped')
      await attempt(async () => (await app.dispose()).unwrap());
    await attempt(async () => (await f.close()).unwrap());
    await attempt(() => texture?.destroy());
    await attempt(() => native.destroy());
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Actual App Level lifecycle failed');
}

it.each(['cycle', 'two', 'cancel', 'interleave', 'collider-only', 'accept-failure'] as const)(
  'runs the actual App Level lifecycle (%s)',
  appLifecycle,
  30000,
);
