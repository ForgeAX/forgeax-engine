import { FixedTime, FixedUpdate, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createDynamicGeometrySourceHost } from '../assembly/dynamic-geometry-host';
import { MeshFilter, MeshRenderer } from '../components';
import { ResidencyLifetime } from '../device/residency-lifetime';
import { createDynamicGeometryLifecycle, type DynamicGeometryCandidate } from '../dynamic-geometry';

function fixture(maxCandidates = 32) {
  const world = new World();
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  const previous = world.allocSharedRef('MeshAsset', mesh);
  const lifecycle = createDynamicGeometryLifecycle(maxCandidates);
  const consumed = new Set<number>();
  const destroyed: number[] = [];
  const lifetimes = new Map<number, ResidencyLifetime>();
  let admission: readonly DynamicGeometryCandidate[] | undefined;
  let accepted: readonly DynamicGeometryCandidate[] = [];
  const host = createDynamicGeometrySourceHost({
    lifecycle,
    attachedWorlds: new Set([world]),
    currentGeneration: () => 1,
    residency: {
      maxConcurrentPreparations: 1,
      prepare: async (input) => {
        const handle = Number(input.meshHandle);
        const lifetime = new ResidencyLifetime(() => destroyed.push(handle));
        lifetimes.set(handle, lifetime);
        const lease = lifetime.retain(() => lifetime.retire());
        return ok({ isCurrent: () => !destroyed.includes(handle), release: lease.release });
      },
    },
    isConsumedByRenderFrame: (candidate) => consumed.has(candidate.entity ?? -1),
    recordStageLane: (candidate) => (consumed.has(candidate.entity ?? -1) ? 'cpu' : undefined),
    publishedFixedStep: () => world.getResource(FixedTime).tick,
  });
  world
    .addSystem(FixedUpdate, {
      name: 'admit-dynamic-geometry',
      queries: [],
      fn: () => {
        if (admission === undefined) return;
        accepted = host
          .acceptDynamicGeometryCandidates(admission, {
            world,
            fixedStep: world.getResource(FixedTime).tick,
          })
          .unwrap();
        admission = undefined;
      },
    })
    .unwrap();
  const entity = () =>
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: previous } },
        { component: MeshRenderer, data: {} },
      )
      .unwrap();
  const prepare = async (targets: readonly ReturnType<typeof entity>[], revision = 1) => {
    const inputs = targets.map((target) => ({
      world,
      entity: target,
      mesh,
      meshHandle: world.allocSharedRef('MeshAsset', mesh),
      revision,
    }));
    try {
      return (await host.prepareDynamicGeometryCandidates(inputs)).unwrap();
    } finally {
      for (const input of inputs) world.sharedRefs.release(input.meshHandle).unwrap();
    }
  };
  const accept = (candidates: readonly DynamicGeometryCandidate[]) => {
    admission = candidates;
    world.update(1 / 60).unwrap();
    return accepted;
  };
  const publish = () =>
    host.publishDynamicGeometry({
      frameId: world.getResource(FixedTime).tick,
      deviceGeneration: 1,
    });
  return {
    world,
    previous,
    lifecycle,
    host,
    consumed,
    destroyed,
    lifetimes,
    entity,
    prepare,
    accept,
    publish,
  };
}

it('admits 33 serial World transactions while CPU-culled residents wait for real draw receipts', async () => {
  const f = fixture();
  const accepted: DynamicGeometryCandidate[] = [];
  const entities: ReturnType<typeof f.entity>[] = [];
  for (let index = 0; index < 33; index++) {
    const visible = f.entity();
    const culled = f.entity();
    entities.push(visible, culled);
    accepted.push(...f.accept(await f.prepare([visible, culled])));
    f.consumed.add(visible);
    f.publish();
  }
  expect(f.lifecycle.inspect()).toMatchObject({ prepared: 0, accepted: 33, published: 33 });
  expect(f.lifecycle.inspect().meshBytes).toBe(
    accepted.reduce((sum, item) => sum + item.meshBytes, 0),
  );
  for (const [index, candidate] of accepted.entries()) {
    const entity = entities[index];
    if (entity === undefined || candidate.meshHandle === undefined)
      throw new Error('missing binding');
    const receipt = f.host.dynamicGeometryReceipt(candidate);
    if (index % 2 === 0) expect(receipt?.recordStageLane).toBe('cpu');
    else expect(receipt).toBeUndefined();
    expect(f.world.get(entity, MeshFilter).unwrap().assetHandle).toBe(candidate.meshHandle);
    if (index % 2 === 0) {
      f.world.despawn(entity).unwrap();
      f.host.retireDynamicGeometry(candidate).unwrap();
    } else {
      f.host.cancelDynamicGeometry(candidate).unwrap();
      f.world.despawn(entity).unwrap();
    }
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.lifecycle.inspect().meshBytes).toBe(0);
  expect(f.destroyed).toHaveLength(66);
  for (const candidate of accepted) {
    if (candidate.meshHandle === undefined) throw new Error('missing handle');
    expect(f.world.sharedRefs.resolve(candidate.meshHandle).ok).toBe(false);
  }
  expect(f.world.sharedRefs.refcount(f.previous)).toBe(1);
});

it('reclaims replaced unpublished residents only after their physical release fence', async () => {
  const f = fixture(1);
  const entity = f.entity();
  const [first] = f.accept(await f.prepare([entity]));
  if (first?.meshHandle === undefined) throw new Error('missing first candidate');
  const bytes = first.meshBytes;
  let complete!: () => void;
  const fence = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const lifetime = f.lifetimes.get(Number(first.meshHandle));
  if (lifetime === undefined) throw new Error('missing residency');
  lifetime.track(fence);
  const [second] = f.accept(await f.prepare([entity], 2));
  if (second?.meshHandle === undefined) throw new Error('missing second candidate');
  expect(f.host.dynamicGeometryReceipt(first)).toBeUndefined();
  expect(f.host.dynamicGeometryReceipt(second)).toBeUndefined();
  expect(f.world.get(entity, MeshFilter).unwrap().assetHandle).toBe(second.meshHandle);
  expect(f.lifecycle.inspect()).toMatchObject({ accepted: 1, prepared: 0, meshBytes: 2 * bytes });
  expect(f.destroyed).toEqual([]);
  const other = f.entity();
  await expect(f.prepare([other])).rejects.toMatchObject({
    code: 'dynamic-geometry-budget-exceeded',
    detail: { reason: 'retained-count', used: 1, limit: 1, pendingFenceCandidates: 1 },
  });
  complete();
  await fence;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.destroyed).toEqual([Number(first.meshHandle)]);
  expect(f.lifecycle.inspect().meshBytes).toBe(bytes);
  expect(f.world.get(entity, MeshFilter).unwrap().assetHandle).toBe(second.meshHandle);
  const [prepared] = await f.prepare([other]);
  if (prepared === undefined) throw new Error('missing prepared candidate');
  f.host.cancelDynamicGeometry(prepared).unwrap();
  f.host.cancelDynamicGeometry(second).unwrap();
  f.world.despawn(entity).unwrap();
  f.world.despawn(other).unwrap();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.lifecycle.inspect()).toMatchObject({ accepted: 0, prepared: 0, meshBytes: 0 });
  expect(f.destroyed).toContain(Number(second.meshHandle));
  expect(f.world.sharedRefs.resolve(first.meshHandle).ok).toBe(false);
  expect(f.world.sharedRefs.resolve(second.meshHandle).ok).toBe(false);
  expect(f.world.sharedRefs.refcount(f.previous)).toBe(1);
});
