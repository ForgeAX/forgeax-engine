import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { defineComponent, type EntityHandle, World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import { rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import type { ShaderRegistry } from '@forgeax/engine-shader';
import { Skin } from '@forgeax/engine-skinning';
import type { AssetHandle } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { MeshFilter, MeshRenderer } from '../components';
import { InstanceProjectionStore } from '../instances';
import { preparePublicationGeometry } from '../publication/prepare-geometry';
import { createRenderPublisher } from '../publication/publisher';
import { RenderPublicationReceiver } from '../publication/receiver';
import { encodeRenderPublication, renderPublicationTransfers } from '../publication/record';
import { SkinTasks } from '../record/skin-tasks';
import type { ExtractedFrame } from '../render-system-extract';
import { extractSource } from '../render-system-extract-tail';
import {
  type PersistentRenderCandidateRequest,
  PersistentRenderScene,
} from '../scene/render-scene';
import { testAssets } from './helpers/runtime-assets';

type SkinWorld = {
  readonly world: World;
  readonly joint: EntityHandle;
  readonly renderable: EntityHandle;
};

function makeSkeleton(world: World): AssetHandle<'skeleton'> {
  const inverseBindMatrices = new Float32Array(16);
  inverseBindMatrices[0] = 1;
  inverseBindMatrices[5] = 1;
  inverseBindMatrices[10] = 1;
  inverseBindMatrices[15] = 1;
  return testAssets(world)
    .create({
      kind: 'skeleton',
      inverseBindMatrices,
      jointCount: 1,
    })
    .unwrap();
}

function makeSkinWorld(
  skinComponent: typeof Skin = Skin,
  registerSkin = false,
  source?: World,
): SkinWorld {
  const world = source ?? new World();
  if (registerSkin) world.components.register(skinComponent).unwrap();
  if (source === undefined) registerPropagateTransforms(world);
  const skeleton = makeSkeleton(world);
  const joint = world.spawn({ component: Transform, data: {} }).unwrap() as EntityHandle;
  const renderable = world
    .spawn(
      { component: Transform, data: {} },
      {
        component: MeshFilter,
        data: {
          assetHandle: testAssets(world).create(createPrimitiveMesh('cube').unwrap()).unwrap(),
        },
      },
      { component: MeshRenderer, data: {} },
      { component: skinComponent, data: { skeleton, joints: new Uint32Array([joint as number]) } },
    )
    .unwrap() as EntityHandle;
  world.update(0).unwrap();
  return { world, joint, renderable };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing accepted Skin lifecycle fact');
  return value;
}
function skinFor(frame: ExtractedFrame, entity: EntityHandle) {
  return frame.renderables.find((snapshot) => snapshot.entityKey === entity)?.skinBinding;
}
function position(scene: PersistentRenderScene, entity: EntityHandle): number {
  const frame = required(scene.skinRecordingFrame()),
    slot = required(scene.compositionSlot(entity));
  const matrix = mat4.create();
  expect(frame.current.matrix(slot.slot, 0, matrix, mat4.create())).toBe(true);
  return matrix[12] as number;
}

describe('PersistentRenderScene shared Skin lifecycle', () => {
  it('reads the World-owned Skin token supplied by a separately bundled Worker plugin', () => {
    const workerSkin = defineComponent('Skin', {
      skeleton: { type: 'asset<skeleton>' },
      joints: { type: 'array<entity>' },
    }) as typeof Skin;
    const subject = makeSkinWorld(workerSkin, true);
    expect(subject.world.components.resolve('Skin')).toBe(workerSkin);
    const assets = testAssets(subject.world),
      lease = createRenderReadLease(subject.world);
    const scene = new PersistentRenderScene();
    try {
      const frame = scene.extractComposition(
        subject.world,
        assets,
        (renderables) =>
          extractSource(subject.world, assets, scene.materialSnapshotCacheStore(), {
            cull: 'none',
            retainHidden: true,
            renderables,
          }),
        lease,
      );
      expect(skinFor(frame, subject.renderable)?.joints).toEqual([Number(subject.joint)]);
      expect(position(scene, subject.renderable)).toBe(0);
    } finally {
      lease.dispose();
      scene.dispose();
    }
  });

  it('retains published static membership and shared pose through replacement-device recovery', () => {
    const f = makeSkinWorld();
    f.world.set(f.joint, Transform, { pos: [2, 0, 0] }).unwrap();
    f.world.update(0).unwrap();
    const assets = testAssets(f.world),
      identity = { source: 'skin-recovery-publication', epoch: 1 };
    const publisher = createRenderPublisher(f.world, assets, identity),
      receiver = new RenderPublicationReceiver(identity);
    const scene = new PersistentRenderScene(),
      instances = new InstanceProjectionStore();
    const publish = () => {
      const candidate = publisher.prepare(0).unwrap();
      const packet = structuredClone(candidate.packet, {
        transfer: renderPublicationTransfers(candidate.message),
      });
      candidate.accept();
      return scene.consumePublication(
        preparePublicationGeometry(
          receiver.accept(encodeRenderPublication(packet)).unwrap(),
          assets,
          instances,
        ),
      );
    };
    try {
      const before = publish(),
        binding = required(skinFor(before, f.renderable));
      expect(position(scene, f.renderable)).toBe(2);
      // Recovery clears device-derived state; the next ordinary publication
      // rebuilds it from the retained rows.
      scene.resetGpuForRecover();
      const next = publish();
      expect(skinFor(next, f.renderable)).toEqual(binding);
      expect(position(scene, f.renderable)).toBe(2);
    } finally {
      scene.dispose();
      instances.dispose();
      receiver.dispose();
      publisher.dispose();
    }
  });

  it.each([
    true,
    false,
  ])('rebinds actual task buffers after recovery without changing source membership (storage=%s)', async (storage) => {
    const adapter = (await rhi.requestAdapter()).unwrap(),
      device = (await adapter.requestDevice()).unwrap();
    const nativeReplacement = (await adapter.requestDevice()).unwrap();
    const replacement = new Proxy(nativeReplacement, {
      get(target, key) {
        if (key === 'caps') return { ...target.caps, storageBuffer: storage };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const f = makeSkinWorld(),
      assets = testAssets(f.world),
      lease = createRenderReadLease(f.world);
    f.world.set(f.joint, Transform, { pos: [3, 0, 0] }).unwrap();
    f.world.update(0).unwrap();
    const scene = new PersistentRenderScene();
    const oldTasks = new SkinTasks(device, storage),
      newTasks = new SkinTasks(replacement, storage);
    const requests: PersistentRenderCandidateRequest[] = [];
    const draw = () =>
      scene.extractComposition(
        f.world,
        assets,
        (request) => {
          requests.push(request);
          return extractSource(f.world, assets, scene.materialSnapshotCacheStore(), {
            cull: 'none',
            retainHidden: true,
            renderables: request,
          });
        },
        lease,
      );
    try {
      const before = draw(),
        binding = required(skinFor(before, f.renderable));
      const identity = required(scene.compositionSlot(f.renderable));
      oldTasks.begin(required(scene.skinRecordingFrame()));
      const prior = required(oldTasks.demand(identity));
      await oldTasks.complete();
      scene.resetGpuForRecover();
      expect(scene.compositionSlot(f.renderable)).toBe(identity);
      requests.length = 0;
      const unchanged = draw();
      expect(requests.every((request) => request === 'none')).toBe(true);
      expect(skinFor(unchanged, f.renderable)).toEqual(binding);
      expect(position(scene, f.renderable)).toBe(3);
      const accepted = required(scene.compositionSlot(f.renderable));
      expect([accepted.slot, accepted.generation]).toEqual([identity.slot, identity.generation]);
      const writes = vi.spyOn(replacement.queue, 'writeBuffer');
      newTasks.begin(required(scene.skinRecordingFrame()));
      const task = required(newTasks.demand(accepted));
      expect(task.data).not.toBe(prior.data);
      expect(task.auxiliary).not.toBe(prior.auxiliary);
      expect(newTasks.paletteUploadBytes).toBe(128);
      const upload = required(
        writes.mock.calls.find(
          ([buffer, offset]) => buffer === task.data && offset === task.dataOffset,
        ),
      );
      expect(
        new Float32Array(upload[2] as ArrayBuffer, (upload[3] ?? 0) + (storage ? 32 : 0), 16)[12],
      ).toBe(3);
      await newTasks.complete();
      writes.mockRestore();
    } finally {
      await oldTasks.dispose();
      await newTasks.dispose();
      lease.dispose();
      scene.dispose();
    }
  });

  it('updates only shared joint facts through quiet/none scopes and repeated frames, then removes static membership', () => {
    const first = makeSkinWorld(),
      second = makeSkinWorld(Skin, false, first.world);
    const lease = createRenderReadLease(first.world);
    const assets = new AssetRegistry({ shaderRegistry: {} as unknown as ShaderRegistry });
    const scene = new PersistentRenderScene();
    const requests: PersistentRenderCandidateRequest[] = [];
    const draw = () =>
      scene.extractComposition(
        first.world,
        assets,
        (request) => {
          requests.push(request);
          return extractSource(first.world, assets, scene.materialSnapshotCacheStore(), {
            cull: 'none',
            retainHidden: true,
            renderables: request,
          });
        },
        lease,
      );
    try {
      const initial = draw(),
        firstBinding = required(skinFor(initial, first.renderable)),
        secondBinding = required(skinFor(initial, second.renderable));
      requests.length = 0;
      first.world.set(first.joint, Transform, { pos: [1, 0, 0] }).unwrap();
      first.world.update(0).unwrap();
      const moved = draw();
      expect(requests.every((request) => request === 'none')).toBe(true);
      expect(skinFor(moved, first.renderable)).toBe(firstBinding);
      expect(skinFor(moved, second.renderable)).toBe(secondBinding);
      expect(position(scene, first.renderable)).toBe(1);
      expect(position(scene, second.renderable)).toBe(0);
      expect(
        extractSource(first.world, assets, scene.materialSnapshotCacheStore(), {
          cull: 'none',
          retainHidden: true,
          renderables: 'none',
        }).renderables,
      ).toHaveLength(0);
      second.world.set(second.joint, Transform, { pos: [2, 0, 0] }).unwrap();
      second.world.update(0).unwrap();
      draw();
      expect(position(scene, first.renderable)).toBe(1);
      expect(position(scene, second.renderable)).toBe(2);
      draw();
      expect(position(scene, second.renderable)).toBe(2);
      expect(position(scene, first.renderable)).toBe(1);
      first.world.removeComponent(first.renderable, Skin).unwrap();
      first.world.update(0).unwrap();
      const removed = draw();
      expect(skinFor(removed, first.renderable)).toBeUndefined();
      expect(position(scene, second.renderable)).toBe(2);
    } finally {
      lease.dispose();
      scene.dispose();
    }
  });
});
