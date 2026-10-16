import { AssetRegistry, HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { defineComponent, type EntityHandle, World } from '@forgeax/engine-ecs';
import { createRenderReadLease, type RenderReadLease } from '@forgeax/engine-ecs/projection';
import { rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import type { ShaderRegistry } from '@forgeax/engine-shader';
import { Skin } from '@forgeax/engine-skinning';
import type { Handle, SkeletonAsset } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createSkinPaletteOwner } from '../assembly/skin-palette-owner';
import { MeshFilter, MeshRenderer } from '../components';
import { InstanceProjectionStore } from '../instances';
import { renderPublicationTransfers } from '../publication/contract';
import { preparePublicationGeometry } from '../publication/prepare-geometry';
import { createRenderPublisher } from '../publication/publisher';
import { RenderPublicationReceiver } from '../publication/receiver';
import type { ExtractedFrame } from '../render-system-extract';
import { extractFrames } from '../render-system-extract-tail';
import {
  type PersistentRenderCandidateRequest,
  PersistentRenderScene,
} from '../scene/render-scene';

type SkinWorld = {
  readonly world: World;
  readonly joint: EntityHandle;
  readonly renderable: EntityHandle;
};

function makeSkeleton(world: World): Handle<'SkeletonAsset', 'shared'> {
  const inverseBindMatrices = new Float32Array(16);
  inverseBindMatrices[0] = 1;
  inverseBindMatrices[5] = 1;
  inverseBindMatrices[10] = 1;
  inverseBindMatrices[15] = 1;
  return world.allocSharedRef<'SkeletonAsset', SkeletonAsset>('SkeletonAsset', {
    kind: 'skeleton',
    inverseBindMatrices,
    jointCount: 1,
  });
}

function makeSkinWorld(skinComponent: typeof Skin = Skin, registerSkin = false): SkinWorld {
  const world = new World();
  if (registerSkin) world.components.register(skinComponent).unwrap();
  registerPropagateTransforms(world);
  const skeleton = makeSkeleton(world);
  const joint = world.spawn({ component: Transform, data: {} }).unwrap() as EntityHandle;
  const renderable = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
      { component: skinComponent, data: { skeleton, joints: new Uint32Array([joint as number]) } },
    )
    .unwrap() as EntityHandle;
  world.update(0).unwrap();
  return { world, joint, renderable };
}

function skinFor(frame: ExtractedFrame, worldId: number, entity: EntityHandle) {
  return frame.renderables.find(
    (snapshot) => snapshot.worldId === worldId && snapshot.entityKey === entity,
  )?.skin;
}

describe('PersistentRenderScene skin palette lifecycle', () => {
  it('reads the World-owned Skin token supplied by a separately bundled Worker plugin', async () => {
    const workerSkin = defineComponent('Skin', {
      skeleton: { type: 'shared<SkeletonAsset>' },
      joints: { type: 'array<entity>' },
    }) as typeof Skin;
    const subject = makeSkinWorld(workerSkin, true);
    expect(subject.world.components.resolve('Skin')).toBe(workerSkin);
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const allocator = createSkinPaletteOwner(device, true);
    const assets = new AssetRegistry({} as unknown as ShaderRegistry);
    const worlds = [subject.world] as const;
    const leases = worlds.map((world) => createRenderReadLease(world));
    const owner = { cameraOwner: 0, resourceOwner: 0 } as const;
    const scene = new PersistentRenderScene();
    try {
      const frame = scene.extractComposition(
        worlds,
        owner,
        0,
        (request) =>
          extractFrames(
            worlds,
            owner,
            assets,
            { skinPaletteAllocator: allocator },
            scene.materialSnapshotCacheStore(),
            { cull: 'none', retainHidden: true, renderables: request },
          ),
        leases,
      );
      expect(skinFor(frame, 0, subject.renderable)).toBeDefined();
    } finally {
      for (const lease of leases) lease.dispose();
      scene.dispose();
      allocator.dispose();
    }
  });

  it('retains published CPU Skin facts after receiver palette assignment for device recovery', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const replacement = (await adapter.requestDevice()).unwrap();
    const allocator = createSkinPaletteOwner(device, true);
    const replacementAllocator = createSkinPaletteOwner(replacement, true);
    const fixture = makeSkinWorld();
    fixture.world.set(fixture.joint, Transform, { pos: [2, 0, 0] }).unwrap();
    fixture.world.update(0).unwrap();
    const assets = new AssetRegistry({} as unknown as ShaderRegistry);
    const identity = { source: 'skin-recovery-publication', epoch: 1 };
    const publisher = createRenderPublisher(fixture.world, assets, identity);
    const receiver = new RenderPublicationReceiver(identity);
    const scene = new PersistentRenderScene();
    const instances = new InstanceProjectionStore();
    try {
      const publication = publisher.prepare(0).unwrap();
      const packet = structuredClone(publication.packet, {
        transfer: renderPublicationTransfers(publication.packet),
      });
      publication.accept();
      const prepared = preparePublicationGeometry(
        receiver.accept(packet).unwrap(),
        scene,
        allocator,
        assets,
        instances,
      );
      const frame = scene.consumePublication(prepared);
      const prior = skinFor(frame, 0, fixture.renderable);
      expect(prior).toBeDefined();
      expect(frame.renderables[0]?.skinPose?.jointWorlds[0]?.[12]).toBe(2);
      const candidate = scene
        .prepareRecoveryGpuDrivenCandidate(replacement, replacementAllocator)
        .unwrap();
      try {
        for (const slot of candidate.state?.slots ?? []) {
          expect(
            candidate.state?.slotForEntity?.(slot.snapshot.worldId, slot.snapshot.entityKey),
          ).toBe(slot);
        }
        const restored = candidate.state?.slots[0]?.snapshot;
        expect(restored?.skin?.buffer).toBeDefined();
        expect(restored?.skin?.buffer).not.toBe(prior?.buffer);
        expect(restored?.skinPose?.jointWorlds[0]?.[12]).toBe(2);
        candidate.publish();
        expect(scene.compositionSlot(0, fixture.renderable)?.snapshot.skin?.buffer).toBe(
          restored?.skin?.buffer,
        );
      } finally {
        candidate.release();
      }
    } finally {
      scene.dispose();
      receiver.dispose();
      publisher.dispose();
      allocator.dispose();
      replacementAllocator.dispose();
    }
  });

  it.each([
    true,
    false,
  ])('rebuilds retained Skin before publication (storage: %s)', async (storage) => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const nativeReplacement = (await adapter.requestDevice()).unwrap();
    const replacement = new Proxy(nativeReplacement, {
      get(target, key) {
        if (key === 'caps') return { ...target.caps, storageBuffer: storage };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const writes = vi.spyOn(replacement.queue, 'writeBuffer');
    const buffers = vi.spyOn(nativeReplacement, 'createBuffer');
    const replacementAllocator = createSkinPaletteOwner(replacement, storage);
    let allocator = createSkinPaletteOwner(device, storage);
    const oldAllocator = allocator;
    const fixture = makeSkinWorld();
    fixture.world.set(fixture.joint, Transform, { pos: [3, 0, 0] }).unwrap();
    fixture.world.update(0).unwrap();
    const worlds = [fixture.world];
    const lease = createRenderReadLease(fixture.world);
    const assets = new AssetRegistry({} as unknown as ShaderRegistry);
    const owner = { cameraOwner: 0, resourceOwner: 0 } as const;
    const scene = new PersistentRenderScene({ getTemporalConsumerDemand: () => true });
    const requests: PersistentRenderCandidateRequest[] = [];
    const build = (request: PersistentRenderCandidateRequest) => {
      requests.push(request);
      return extractFrames(
        worlds,
        owner,
        assets,
        { skinPaletteAllocator: allocator },
        scene.materialSnapshotCacheStore(),
        { cull: 'none', retainHidden: true, renderables: request },
      );
    };
    try {
      const before = scene.extractComposition(worlds, owner, 0, build, [lease]);
      scene.prepareTemporalFrame(before.renderables);
      scene.commitTemporalFrame().unwrap();
      const prior = skinFor(before, 0, fixture.renderable);
      const identity = scene.compositionSlot(0, fixture.renderable);
      expect(prior).toBeDefined();
      expect(identity?.snapshot.skinPose?.jointWorlds[0]?.[12]).toBe(3);
      const discarded = scene
        .prepareRecoveryGpuDrivenCandidate(replacement, replacementAllocator)
        .unwrap();
      if (storage) {
        const slot = discarded.state?.slots.find((row) => row.entityKey === fixture.renderable);
        expect(slot?.snapshot.skin?.buffer).toBeDefined();
        if (slot !== undefined) {
          expect(
            discarded.state?.slotForEntity?.(slot.snapshot.worldId, slot.snapshot.entityKey),
          ).toBe(slot);
        }
        expect(slot?.snapshot.skin?.buffer).not.toBe(prior?.buffer);
        expect(discarded.state?.slotAt(slot?.slot ?? -1)?.snapshot.skin?.buffer).toBe(
          slot?.snapshot.skin?.buffer,
        );
      } else expect(discarded.state).toBeUndefined();
      discarded.discard();
      discarded.publish();
      expect(scene.compositionSlot(0, fixture.renderable)?.snapshot.skin?.buffer).toBe(
        prior?.buffer,
      );
      const candidate = scene
        .prepareRecoveryGpuDrivenCandidate(replacement, replacementAllocator)
        .unwrap();
      scene.resetGpuForRecover();
      candidate.publish();
      candidate.publish();
      const accepted = scene.compositionSlot(0, fixture.renderable);
      const receipt = accepted?.snapshot.skin;
      expect(receipt?.buffer).not.toBe(prior?.buffer);
      expect([accepted?.slot, accepted?.generation]).toEqual([
        identity?.slot,
        identity?.generation,
      ]);
      expect([receipt?.identity, receipt?.generation]).toEqual([
        prior?.identity,
        prior?.generation,
      ]);
      expect(
        buffers.mock.results.some(
          (result) =>
            result.type === 'return' && result.value.ok && result.value.value === receipt?.buffer,
        ),
      ).toBe(true);
      const upload = writes.mock.calls.find(([buffer]) => buffer === receipt?.buffer);
      expect(upload?.[1]).toBe(receipt?.byteOffset);
      expect(Array.from(upload?.[2] as Float32Array)).toEqual([
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 0, 0, 1,
      ]);
      allocator = replacementAllocator;
      requests.length = 0;
      const unchanged = scene.extractComposition(worlds, owner, 0, build, [lease]);
      expect(requests.every((request) => request === 'none')).toBe(true);
      expect(skinFor(unchanged, 0, fixture.renderable)?.buffer).toBe(receipt?.buffer);
      expect(unchanged.renderables[0]?.temporal?.previousSkin?.buffer).not.toBe(prior?.buffer);
      expect(fixture.world.get(fixture.joint, Transform).unwrap().pos[0]).toBe(3);
    } finally {
      writes.mockRestore();
      buffers.mockRestore();
      lease.dispose();
      scene.dispose();
      oldAllocator.dispose();
      replacementAllocator.dispose();
    }
  });

  it('preserves untouched partial palettes, none scope, reorder identity, and retires removed Skin', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const allocator = createSkinPaletteOwner(device, true);
    const assets = new AssetRegistry({} as unknown as ShaderRegistry);
    const first = makeSkinWorld();
    const second = makeSkinWorld();
    let worlds: readonly World[] = [first.world, second.world];
    let leases: readonly RenderReadLease[] = worlds.map((world) => createRenderReadLease(world));
    const owner = { cameraOwner: 0, resourceOwner: 0 } as const;
    const scene = new PersistentRenderScene();
    const requests: PersistentRenderCandidateRequest[] = [];
    const build = (request: PersistentRenderCandidateRequest): ExtractedFrame => {
      requests.push(request);
      return extractFrames(
        worlds,
        owner,
        assets,
        { skinPaletteAllocator: allocator },
        scene.materialSnapshotCacheStore(),
        { cull: 'none', retainHidden: true, renderables: request },
      );
    };
    const draw = (): ExtractedFrame => scene.extractComposition(worlds, owner, 0, build, leases);

    try {
      const initial = draw();
      const firstInitial = skinFor(initial, 0, first.renderable);
      const secondInitial = skinFor(initial, 1, second.renderable);
      expect(firstInitial).toBeDefined();
      expect(secondInitial).toBeDefined();
      expect(firstInitial?.identity).not.toBe(secondInitial?.identity);
      const firstBuffer = firstInitial?.buffer;
      const firstOffset = firstInitial?.byteOffset;
      const secondBuffer = secondInitial?.buffer;
      const secondOffset = secondInitial?.byteOffset;
      expect(firstBuffer).toBeDefined();
      expect(secondBuffer).toBeDefined();
      expect(firstOffset).toBe(0);
      expect(secondOffset).toBe(256);

      requests.length = 0;
      first.world.set(first.joint, Transform, { pos: [1, 0, 0] }).unwrap();
      first.world.update(0).unwrap();
      const firstPartial = draw();
      const firstPartialRequest = requests.find(
        (request): request is Extract<PersistentRenderCandidateRequest, { kind: 'partial' }> =>
          typeof request === 'object',
      );
      expect(firstPartialRequest).toBeDefined();
      expect(firstPartialRequest?.entitiesByWorld[0]?.has(first.renderable as number)).toBe(true);
      expect(
        firstPartialRequest?.entitiesByWorld[1]?.has(second.renderable as number) ?? false,
      ).toBe(false);
      expect(skinFor(firstPartial, 1, second.renderable)?.buffer).toBe(secondBuffer);
      expect(skinFor(firstPartial, 1, second.renderable)?.byteOffset).toBe(secondOffset);

      // Resource-only publication must not reconcile the identity set or
      // release either persistent palette.
      const none = extractFrames(
        worlds,
        owner,
        assets,
        { skinPaletteAllocator: allocator },
        scene.materialSnapshotCacheStore(),
        { cull: 'none', retainHidden: true, renderables: 'none' },
      );
      expect(none.renderables).toHaveLength(0);

      // Visit the previously untouched entity after the partial and none
      // scopes. Reusing its exact receipt proves its allocation survived both.
      second.world.set(second.joint, Transform, { pos: [2, 0, 0] }).unwrap();
      second.world.update(0).unwrap();
      const secondPartial = draw();
      expect(skinFor(secondPartial, 0, first.renderable)?.buffer).toBe(firstBuffer);
      expect(skinFor(secondPartial, 0, first.renderable)?.byteOffset).toBe(firstOffset);
      expect(skinFor(secondPartial, 1, second.renderable)?.buffer).toBe(secondBuffer);
      expect(skinFor(secondPartial, 1, second.renderable)?.byteOffset).toBe(secondOffset);

      // A full rebuild after worlds[] reorder must retain each World's palette
      // identity. Entity keys intentionally start at the same value in both
      // independent Worlds, so an index-derived key would alias or move them.
      worlds = [second.world, first.world];
      leases = [leases[1] as RenderReadLease, leases[0] as RenderReadLease];
      const reordered = draw();
      expect(skinFor(reordered, 0, second.renderable)?.buffer).toBe(secondBuffer);
      expect(skinFor(reordered, 0, second.renderable)?.byteOffset).toBe(secondOffset);
      expect(skinFor(reordered, 1, first.renderable)?.buffer).toBe(firstBuffer);
      expect(skinFor(reordered, 1, first.renderable)?.byteOffset).toBe(firstOffset);

      // Removing Skin leaves the renderable slot alive, but the producer must
      // retire its palette during the selected partial extraction.
      first.world.removeComponent(first.renderable, Skin).unwrap();
      first.world.update(0).unwrap();
      const afterSkinRemoval = draw();
      expect(skinFor(afterSkinRemoval, 1, first.renderable)).toBeUndefined();
      expect(skinFor(afterSkinRemoval, 0, second.renderable)?.buffer).toBe(secondBuffer);
      expect(skinFor(afterSkinRemoval, 0, second.renderable)?.byteOffset).toBe(secondOffset);

      await device.queue.onSubmittedWorkDone();
      const replacement = allocator.allocatePersistentSlice({
        identity: 'test-replacement',
        generation: 1,
        jointCount: 1,
      });
      expect(replacement.byteOffset).toBe(firstOffset);
    } finally {
      for (const lease of leases) lease.dispose();
      scene.dispose();
      allocator.dispose();
    }
  });
});
