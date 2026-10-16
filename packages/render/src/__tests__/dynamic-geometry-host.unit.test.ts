import { type ComponentData, FixedUpdate, World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import type { Handle, MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createDynamicGeometryHost } from '../assembly/dynamic-geometry-host';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import { GpuResidencyCache } from '../device/gpu-residency';
import { ResidencyLifetime } from '../device/residency-lifetime';

function residencyLease(handle: number, invalidated: number[]) {
  const lifetime = new ResidencyLifetime(() => invalidated.push(handle));
  return lifetime.retain(() => lifetime.retire());
}

import { createDynamicGeometryLifecycle } from '../dynamic-geometry';

const mesh = (): MeshAsset => ({
  kind: 'mesh',
  vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: new Uint16Array([0, 1, 2]),
  attributes: { position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) },
  aabb: new Float32Array([0, 0, 0, 1, 1, 0]),
  submeshes: [
    { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list', materialSlot: 0 },
  ],
  materialSlots: [{ slotName: 'default', sourceKey: 'default' }],
});

describe('dynamic geometry ECS publication host', () => {
  it.each([
    false,
    true,
  ])('releases cancelled candidate capacity with later submissions (unbind: %s)', async (unbind) => {
    const world = new World();
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const store = new GpuResidencyCache();
    store.configureGpuDevice(
      device,
      undefined,
      () => {
        throw new Error('unused cubemap');
      },
      device.caps,
    );
    const lifecycle = createDynamicGeometryLifecycle();
    const host = createDynamicGeometryHost({
      lifecycle,
      attachedWorlds: new Set([world]),
      getGpuStore: () => store,
      currentGeneration: () => 1,
      isConsumedByRenderFrame: () => false,
    });
    const source = mesh();
    const handle = world.allocSharedRef('MeshAsset', source);
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: handle } },
        { component: MeshRenderer, data: { materials: [] } },
      )
      .unwrap();
    const candidate = host
      .prepareDynamicGeometry({ world, entity, mesh: source, meshHandle: handle, revision: 1 })
      .unwrap();
    const allocation = store.getMeshGpuHandles(handle, world);
    if (allocation === undefined) throw new Error('candidate allocation missing');
    let finishExisting!: () => void, finishLater!: () => void;
    const existing = new Promise<void>((resolve) => {
      finishExisting = resolve;
    });
    const later = new Promise<void>((resolve) => {
      finishLater = resolve;
    });
    store.trackMeshSubmission(existing);
    if (unbind) world.despawn(entity).unwrap();
    world.sharedRefs.release(handle).unwrap();
    host.cancelDynamicGeometry(candidate).unwrap();
    expect(lifecycle.inspect().meshBytes).toBeGreaterThan(0);
    store.trackMeshSubmission(later);
    try {
      finishExisting();
      await existing;
      // These are promise fences, not a wall-clock performance contract.
      // Drain their bounded completion reactions while the later fence remains unresolved.
      for (let turn = 0; turn < 16 && lifecycle.inspect().meshBytes !== 0; turn += 1)
        await Promise.resolve();
      expect(lifecycle.inspect().meshBytes).toBe(0);
      expect(world.sharedRefs.resolve(handle).ok).toBe(!unbind);
      expect(allocation.vertexBuffer.isDestroyed).toBe(false);
      expect(allocation.indexBuffer?.isDestroyed).toBe(false);
      if (unbind) {
        expect(store.getMeshGpuHandles(handle, world)).toBeUndefined();
        // Ordinary later frames cannot retain the allocation after cache retirement.
        store.trackMeshSubmission(new Promise<void>(() => {}));
      } else {
        expect(store.getMeshGpuHandles(handle, world)).toBe(allocation);
      }
    } finally {
      finishLater();
      await later;
      if (!unbind) world.despawn(entity).unwrap();
      if (unbind) {
        expect(allocation.vertexBuffer.isDestroyed).toBe(true);
        expect(allocation.indexBuffer?.isDestroyed).toBe(true);
      }
      store.destroyAll();
    }
  });

  it('prepares a streamed MeshAsset before publication and supports cancellation or commit', async () => {
    const world = new World();
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const store = new GpuResidencyCache();
    store.configureGpuDevice(
      device,
      undefined,
      () => {
        throw new Error('unused cubemap');
      },
      device.caps,
    );
    const host = createDynamicGeometryHost({
      lifecycle: createDynamicGeometryLifecycle(),
      attachedWorlds: new Set([world]),
      getGpuStore: () => store,
      currentGeneration: () => 1,
      isConsumedByRenderFrame: () => false,
    });
    const cancelledHandle = world.allocSharedRef('MeshAsset', mesh());
    const cancelled = host.prepareMeshResidency(world, cancelledHandle).unwrap();
    expect(cancelled.isCurrent()).toBe(true);
    cancelled.cancel();
    expect(store.getMeshGpuHandles(cancelledHandle, world)).toBeUndefined();
    expect(cancelled.commit()).toBe(false);
    world.sharedRefs.release(cancelledHandle).unwrap();

    const committedHandle = world.allocSharedRef('MeshAsset', mesh());
    const committed = host.prepareMeshResidency(world, committedHandle).unwrap();
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: committedHandle } },
        { component: MeshRenderer, data: { materials: [] } },
      )
      .unwrap();
    expect(committed.commit()).toBe(true);
    committed.cancel();
    expect(store.getMeshGpuHandles(committedHandle, world)).toBeDefined();
    world.despawn(entity).unwrap();
    store.invalidateMesh(committedHandle, world);
    world.sharedRefs.release(committedHandle).unwrap();
    store.destroyAll();
  });

  it.each([
    'supersession',
    'cancel',
    'duplicate-cancel',
    'detach',
  ] as const)('keeps unpublished submitted allocations bounded through %s', async (mode) => {
    const world = new World();
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const store = new GpuResidencyCache();
    store.configureGpuDevice(
      device,
      undefined,
      () => {
        throw new Error('unused cubemap');
      },
      device.caps,
    );
    const lifecycle = createDynamicGeometryLifecycle();
    const host = createDynamicGeometryHost({
      lifecycle,
      attachedWorlds: new Set([world]),
      getGpuStore: () => store,
      currentGeneration: () => 1,
      isConsumedByRenderFrame: () => false,
    });
    const original = world.allocSharedRef('MeshAsset', mesh());
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: original } },
        { component: MeshRenderer, data: { materials: [] } },
      )
      .unwrap();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const handles: Handle<'MeshAsset', 'shared'>[] = [];
    let latest: import('../dynamic-geometry').DynamicGeometryCandidate | undefined;
    // Supersession retains one current World resident beside 32 fenced releases.
    const residentCount = mode === 'supersession' ? 1 : 0;
    for (let revision = 1; revision <= 40; revision++) {
      const source = mesh();
      const handle = world.allocSharedRef('MeshAsset', source);
      const prepared = host.prepareDynamicGeometry({
        world,
        entity,
        mesh: source,
        meshHandle: handle,
        revision,
      });
      if (!prepared.ok) {
        expect(revision).toBe(33 + residentCount);
        expect(prepared.error.code).toBe('dynamic-geometry-budget-exceeded');
        expect(prepared.error.detail).toMatchObject({
          reason: 'retained-count',
          used: 32,
          limit: 32,
          pendingFenceCandidates: 32,
        });
        world.sharedRefs.release(handle).unwrap();
        break;
      }
      latest = host.acceptDynamicGeometry(prepared.value, { world, fixedStep: 0 }).unwrap();
      handles.push(handle);
      store.trackMeshSubmission(pending);
      world.sharedRefs.release(handle).unwrap();
      if (mode === 'cancel' || mode === 'duplicate-cancel') {
        host.cancelDynamicGeometry(latest).unwrap();
        if (mode === 'duplicate-cancel') expect(host.cancelDynamicGeometry(latest).ok).toBe(false);
      } else if (mode === 'detach') {
        host.invalidateDynamicGeometryWorld(world);
        host.invalidateDynamicGeometryWorld(world);
        world.set(entity, MeshFilter, { assetHandle: original }).unwrap();
      }
    }
    expect(handles).toHaveLength(32 + residentCount);
    expect(lifecycle.inspect().accepted).toBe(residentCount);
    expect(lifecycle.inspect().meshBytes).toBeGreaterThan(0);
    expect(handles.every((handle) => world.sharedRefs.resolve(handle).ok)).toBe(true);
    if (mode === 'supersession' && latest !== undefined)
      host.cancelDynamicGeometry(latest).unwrap();
    finish();
    await pending;
    await vi.waitFor(() => expect(lifecycle.inspect().meshBytes).toBe(0));
    store.destroyAll();
  });

  it('keeps the old ECS binding visible while staging and restores it on cancellation', () => {
    const world = new World();
    const oldMesh = mesh();
    const oldHandle = world.allocSharedRef('MeshAsset', oldMesh);
    const nextMesh = mesh();
    nextMesh.vertices[0] = 4;
    const nextHandle = world.allocSharedRef('MeshAsset', nextMesh);
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: oldHandle } },
        { component: MeshRenderer, data: { materials: [] } },
      )
      .unwrap();
    // Simulate an asset producer releasing its allocation while the ECS
    // component remains the only visible binding. Candidate preparation must
    // retain that old binding before the ECS swap so cancellation can restore
    // a live handle instead of reporting success with a stale MeshFilter.
    expect(world.sharedRefs.release(oldHandle).ok).toBe(true);
    const invalidated: number[] = [];
    const host = createDynamicGeometryHost({
      lifecycle: createDynamicGeometryLifecycle(),
      attachedWorlds: new Set([world]),
      getGpuStore: () =>
        ({
          ensureResident: () => ({ ok: true as const, value: {} }),
          retainMeshResidency: (handle: number) => residencyLease(handle, invalidated),
          invalidateMesh: (handle: number) => invalidated.push(handle),
        }) as unknown as GpuResidencyCache,
      currentGeneration: () => 1,
      isConsumedByRenderFrame: () => true,
    });

    const prepared = host.prepareDynamicGeometry({
      world,
      entity,
      mesh: nextMesh,
      meshHandle: nextHandle,
      revision: 2,
    });
    expect(prepared.ok).toBe(true);
    expect(world.sharedRefs.refcount(nextHandle)).toBe(2);
    expect(world.sharedRefs.resolve(oldHandle).ok).toBe(true);
    expect(world.get(entity, MeshFilter).unwrap().assetHandle).toBe(oldHandle);
    if (!prepared.ok) return;

    const accepted = host.acceptDynamicGeometry(prepared.value, { world, fixedStep: 0 });
    expect(accepted.ok).toBe(true);
    expect(world.sharedRefs.refcount(nextHandle)).toBe(3);
    expect(world.get(entity, MeshFilter).unwrap().assetHandle).toBe(nextHandle);
    if (!accepted.ok) return;

    expect(host.cancelDynamicGeometry(accepted.value).ok).toBe(true);
    expect(world.sharedRefs.refcount(nextHandle)).toBe(1);
    expect(world.sharedRefs.resolve(oldHandle).ok).toBe(true);
    expect(world.get(entity, MeshFilter).unwrap().assetHandle).toBe(oldHandle);
    expect(invalidated).toEqual([nextHandle]);
  });

  it('refuses an external binding change instead of clobbering the live ECS state', () => {
    const world = new World();
    const oldHandle = world.allocSharedRef('MeshAsset', mesh());
    const nextMesh = mesh();
    const nextHandle = world.allocSharedRef('MeshAsset', nextMesh);
    const externalHandle = world.allocSharedRef('MeshAsset', mesh());
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: oldHandle } },
        { component: MeshRenderer, data: { materials: [] } },
      )
      .unwrap();
    const invalidated: number[] = [];
    const host = createDynamicGeometryHost({
      lifecycle: createDynamicGeometryLifecycle(),
      attachedWorlds: new Set([world]),
      getGpuStore: () =>
        ({
          ensureResident: () => ({ ok: true as const, value: {} }),
          retainMeshResidency: (handle: number) => residencyLease(handle, invalidated),
          invalidateMesh: (handle: number) => invalidated.push(handle),
        }) as unknown as GpuResidencyCache,
      currentGeneration: () => 1,
      isConsumedByRenderFrame: () => true,
    });
    const prepared = host.prepareDynamicGeometry({
      world,
      entity,
      mesh: nextMesh,
      meshHandle: nextHandle,
      revision: 2,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    world.set(entity, MeshFilter, { assetHandle: externalHandle }).unwrap();
    const accepted = host.acceptDynamicGeometry(prepared.value, { world, fixedStep: 0 });
    expect(accepted).toMatchObject({ ok: false, error: { code: 'dynamic-geometry-invalid' } });
    expect(world.get(entity, MeshFilter).unwrap().assetHandle).toBe(externalHandle);
    expect(host.cancelDynamicGeometry(prepared.value).ok).toBe(true);
    expect(invalidated).toEqual([nextHandle]);
  });

  it('refuses cancellation after an accepted candidate is replaced by a foreign binding', () => {
    const world = new World();
    const oldHandle = world.allocSharedRef('MeshAsset', mesh());
    const nextMesh = mesh();
    nextMesh.vertices[0] = 9;
    const nextHandle = world.allocSharedRef('MeshAsset', nextMesh);
    const foreignHandle = world.allocSharedRef('MeshAsset', mesh());
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: oldHandle } },
        { component: MeshRenderer, data: { materials: [] } },
      )
      .unwrap();
    const invalidated: number[] = [];
    const host = createDynamicGeometryHost({
      lifecycle: createDynamicGeometryLifecycle(),
      attachedWorlds: new Set([world]),
      getGpuStore: () =>
        ({
          ensureResident: () => ({ ok: true as const, value: {} }),
          retainMeshResidency: (handle: number) => residencyLease(handle, invalidated),
          invalidateMesh: (handle: number) => invalidated.push(handle),
        }) as unknown as GpuResidencyCache,
      currentGeneration: () => 1,
      isConsumedByRenderFrame: () => true,
    });
    const prepared = host.prepareDynamicGeometry({
      world,
      entity,
      mesh: nextMesh,
      meshHandle: nextHandle,
      revision: 2,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const accepted = host.acceptDynamicGeometry(prepared.value, { world, fixedStep: 0 });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;

    expect(world.set(entity, MeshFilter, { assetHandle: foreignHandle }).ok).toBe(true);
    expect(host.cancelDynamicGeometry(accepted.value)).toMatchObject({
      ok: false,
      error: { code: 'dynamic-geometry-invalid' },
    });
    expect(world.get(entity, MeshFilter).unwrap().assetHandle).toBe(foreignHandle);
    // The old binding remains retained while cancellation is refused, so the
    // host can restore it after the foreign owner reconciles the entity.
    expect(world.sharedRefs.resolve(oldHandle).ok).toBe(true);
    expect(invalidated).toEqual([]);

    expect(world.set(entity, MeshFilter, { assetHandle: nextHandle }).ok).toBe(true);
    expect(host.cancelDynamicGeometry(accepted.value).ok).toBe(true);
    expect(world.get(entity, MeshFilter).unwrap().assetHandle).toBe(oldHandle);
    expect(invalidated).toEqual([nextHandle]);
  });

  it('rejects forged owner credentials before cancellation or retirement can touch ECS', () => {
    const world = new World();
    const oldHandle = world.allocSharedRef('MeshAsset', mesh());
    const nextMesh = mesh();
    nextMesh.vertices[0] = 8;
    const nextHandle = world.allocSharedRef('MeshAsset', nextMesh);
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: oldHandle } },
        { component: MeshRenderer, data: { materials: [] } },
      )
      .unwrap();
    const invalidated: number[] = [];
    const lifecycle = createDynamicGeometryLifecycle();
    const host = createDynamicGeometryHost({
      lifecycle,
      attachedWorlds: new Set([world]),
      getGpuStore: () =>
        ({
          ensureResident: () => ({ ok: true as const, value: {} }),
          retainMeshResidency: (handle: number) => residencyLease(handle, invalidated),
          invalidateMesh: (handle: number) => invalidated.push(handle),
        }) as unknown as GpuResidencyCache,
      currentGeneration: () => 1,
      isConsumedByRenderFrame: () => true,
    });
    const prepared = host.prepareDynamicGeometry({
      world,
      entity,
      mesh: nextMesh,
      meshHandle: nextHandle,
      revision: 1,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const accepted = host.acceptDynamicGeometry(prepared.value, { world, fixedStep: 0 });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    const forged = Object.freeze({ ...accepted.value, owner: {} });

    expect(host.cancelDynamicGeometry(forged)).toMatchObject({
      ok: false,
      error: { code: 'dynamic-geometry-receipt-mismatch' },
    });
    expect(host.retireDynamicGeometry(forged)).toMatchObject({
      ok: false,
      error: { code: 'dynamic-geometry-receipt-mismatch' },
    });
    expect(world.get(entity, MeshFilter).unwrap().assetHandle).toBe(nextHandle);
    expect(host.dynamicGeometryReceipt(accepted.value)).toBeUndefined();
    expect(lifecycle.inspect()).toMatchObject({ accepted: 1, published: 0 });
    expect(host.cancelDynamicGeometry(accepted.value).ok).toBe(true);
    expect(invalidated).toEqual([nextHandle]);
  });

  it('derives an omitted publication tick from the attached World FixedTime', () => {
    const invalidated: number[] = [];
    const world = new World();
    expect(
      world.addSystem(FixedUpdate, { name: 'advance-fixed-time', queries: [], fn: () => {} }).ok,
    ).toBe(true);
    expect(world.update(1 / 60).ok).toBe(true);
    const oldHandle = world.allocSharedRef('MeshAsset', mesh());
    const nextMesh = mesh();
    nextMesh.vertices[0] = 7;
    const nextHandle = world.allocSharedRef('MeshAsset', nextMesh);
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: oldHandle } },
        { component: MeshRenderer, data: { materials: [] } },
      )
      .unwrap();
    const host = createDynamicGeometryHost({
      lifecycle: createDynamicGeometryLifecycle(),
      attachedWorlds: new Set([world]),
      getGpuStore: () =>
        ({
          ensureResident: () => ({ ok: true as const, value: {} }),
          retainMeshResidency: (handle: number) => residencyLease(handle, invalidated),
        }) as unknown as GpuResidencyCache,
      currentGeneration: () => 1,
      isConsumedByRenderFrame: () => true,
    });
    const prepared = host.prepareDynamicGeometry({
      world,
      entity,
      mesh: nextMesh,
      meshHandle: nextHandle,
      revision: 1,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const accepted = host.acceptDynamicGeometry(prepared.value, { world, fixedStep: 1 });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;

    const receipts = host.publishDynamicGeometry({ frameId: 1, deviceGeneration: 1 }, [world]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ fixedStep: 1, publicationFixedStep: 1 });
  });

  it('keeps real RhiNull residency behind a pending receipt across topology replacement', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const store = new GpuResidencyCache();
    store.configureGpuDevice(
      device,
      undefined,
      () => {
        throw new Error('cubemap registration is not part of this test');
      },
      device.caps,
    );
    const invalidated: number[] = [];
    const invalidateMesh = store.invalidateMesh.bind(store);
    vi.spyOn(store, 'invalidateMesh').mockImplementation((handle, worldId = 0) => {
      invalidated.push(handle);
      invalidateMesh(handle, worldId);
    });
    const world = new World();
    const oldHandle = world.allocSharedRef('MeshAsset', mesh());
    const firstMesh = mesh();
    firstMesh.vertices[0] = 2;
    const firstHandle = world.allocSharedRef('MeshAsset', firstMesh);
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: oldHandle } },
        { component: MeshRenderer, data: { materials: [] } },
      )
      .unwrap();
    const host = createDynamicGeometryHost({
      lifecycle: createDynamicGeometryLifecycle(),
      attachedWorlds: new Set([world]),
      getGpuStore: () => store,
      currentGeneration: () => 1,
      isConsumedByRenderFrame: () => true,
    });
    const first = host.prepareDynamicGeometry({
      world,
      entity,
      mesh: firstMesh,
      meshHandle: firstHandle,
      revision: 1,
      topologyRevision: 1,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstAccepted = host.acceptDynamicGeometry(first.value, { world, fixedStep: 0 });
    expect(firstAccepted.ok).toBe(true);
    if (!firstAccepted.ok) return;
    let completeFirst!: () => void;
    const firstCompleted = new Promise<void>((resolve) => {
      completeFirst = resolve;
    });
    expect(
      host.publishDynamicGeometry(
        { frameId: 1, deviceGeneration: 1, completed: firstCompleted },
        [world],
        0,
      ),
    ).toHaveLength(1);
    expect(store.getMeshGpuHandles(firstHandle, world)).toBeDefined();
    let completeSecond!: () => void;
    const secondCompleted = new Promise<void>((resolve) => {
      completeSecond = resolve;
    });
    expect(
      host.publishDynamicGeometry(
        { frameId: 2, deviceGeneration: 1, completed: secondCompleted },
        [world],
        0,
      ),
    ).toHaveLength(1);
    expect(host.dynamicGeometryReceipt(firstAccepted.value)).toMatchObject({ frameId: 2 });
    expect(host.retireDynamicGeometry(firstAccepted.value)).toMatchObject({
      ok: false,
      error: { code: 'dynamic-geometry-invalid' },
    });
    expect(host.dynamicGeometryReceipt(firstAccepted.value)).toBeDefined();

    const secondMesh = mesh();
    secondMesh.vertices[0] = 3;
    const secondHandle = world.allocSharedRef('MeshAsset', secondMesh);
    const second = host.prepareDynamicGeometry({
      world,
      entity,
      mesh: secondMesh,
      meshHandle: secondHandle,
      revision: 2,
      topologyRevision: 2,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const secondAccepted = host.acceptDynamicGeometry(second.value, { world, fixedStep: 0 });
    expect(secondAccepted.ok).toBe(true);
    if (!secondAccepted.ok) return;
    expect(host.dynamicGeometryReceipt(firstAccepted.value)).toBeDefined();

    expect(host.retireDynamicGeometry(firstAccepted.value).ok).toBe(true);
    expect(invalidated).toEqual([]);
    completeFirst();
    await Promise.resolve();
    expect(invalidated).toEqual([]);
    completeSecond();
    await Promise.resolve();
    expect(invalidated).toEqual([firstHandle]);
    expect(host.cancelDynamicGeometry(secondAccepted.value).ok).toBe(true);
  });

  it('tracks a live entity after another entity advances topology', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const store = new GpuResidencyCache();
    store.configureGpuDevice(
      device,
      undefined,
      () => {
        throw new Error('cubemap registration is not part of this test');
      },
      device.caps,
    );
    const invalidated: number[] = [];
    const invalidateMesh = store.invalidateMesh.bind(store);
    vi.spyOn(store, 'invalidateMesh').mockImplementation((handle, worldId = 0) => {
      invalidated.push(handle);
      invalidateMesh(handle, worldId);
    });
    const world = new World();
    const oldA = world.allocSharedRef('MeshAsset', mesh());
    const candidateAMesh = mesh();
    candidateAMesh.vertices[0] = 10;
    const candidateA = world.allocSharedRef('MeshAsset', candidateAMesh);
    const oldB = world.allocSharedRef('MeshAsset', mesh());
    const candidateBMesh = mesh();
    candidateBMesh.vertices[0] = 11;
    const candidateB = world.allocSharedRef('MeshAsset', candidateBMesh);
    const entityA = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: oldA } },
        { component: MeshRenderer, data: { materials: [] } },
      )
      .unwrap();
    const entityB = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: oldB } },
        { component: MeshRenderer, data: { materials: [] } },
      )
      .unwrap();
    const host = createDynamicGeometryHost({
      lifecycle: createDynamicGeometryLifecycle(),
      attachedWorlds: new Set([world]),
      getGpuStore: () => store,
      currentGeneration: () => 1,
      isConsumedByRenderFrame: () => true,
    });
    const preparedA = host.prepareDynamicGeometry({
      world,
      entity: entityA,
      mesh: candidateAMesh,
      meshHandle: candidateA,
      revision: 1,
      topologyRevision: 1,
    });
    expect(preparedA.ok).toBe(true);
    if (!preparedA.ok) return;
    const acceptedA = host.acceptDynamicGeometry(preparedA.value, { world, fixedStep: 0 });
    expect(acceptedA.ok).toBe(true);
    if (!acceptedA.ok) return;

    let completeFirst!: () => void;
    const firstCompleted = new Promise<void>((resolve) => {
      completeFirst = resolve;
    });
    expect(
      host.publishDynamicGeometry(
        { frameId: 1, deviceGeneration: 1, completed: firstCompleted },
        [world],
        0,
      ),
    ).toHaveLength(1);

    const preparedB = host.prepareDynamicGeometry({
      world,
      entity: entityB,
      mesh: candidateBMesh,
      meshHandle: candidateB,
      revision: 2,
      topologyRevision: 2,
    });
    expect(preparedB.ok).toBe(true);
    if (!preparedB.ok) return;
    const acceptedB = host.acceptDynamicGeometry(preparedB.value, { world, fixedStep: 0 });
    expect(acceptedB.ok).toBe(true);
    if (!acceptedB.ok) return;

    let completeSecond!: () => void;
    const secondCompleted = new Promise<void>((resolve) => {
      completeSecond = resolve;
    });
    const frameTwoReceipts = host.publishDynamicGeometry(
      { frameId: 2, deviceGeneration: 1, completed: secondCompleted },
      [world],
      0,
    );
    expect(frameTwoReceipts.map((receipt) => receipt.candidateId)).toEqual(
      expect.arrayContaining([acceptedA.value.candidateId, acceptedB.value.candidateId]),
    );
    expect(host.dynamicGeometryReceipt(acceptedA.value)).toMatchObject({ frameId: 2 });
    expect(store.getMeshGpuHandles(candidateA, world)).toBeDefined();

    expect(world.set(entityA, MeshFilter, { assetHandle: oldA }).ok).toBe(true);
    expect(host.retireDynamicGeometry(acceptedA.value).ok).toBe(true);
    expect(invalidated).toEqual([]);
    completeFirst();
    await Promise.resolve();
    expect(invalidated).toEqual([]);
    completeSecond();
    await Promise.resolve();
    expect(invalidated).toContain(candidateA);

    expect(world.set(entityB, MeshFilter, { assetHandle: oldB }).ok).toBe(true);
    expect(host.retireDynamicGeometry(acceptedB.value).ok).toBe(true);
    expect(invalidated).toContain(candidateB);
  });

  it('keeps shared residency for another candidate while a receipt is pending', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const store = new GpuResidencyCache();
    store.configureGpuDevice(
      device,
      undefined,
      () => {
        throw new Error('cubemap registration is not part of this test');
      },
      device.caps,
    );
    const invalidated: number[] = [];
    const invalidateMesh = store.invalidateMesh.bind(store);
    vi.spyOn(store, 'invalidateMesh').mockImplementation((handle, worldId = 0) => {
      invalidated.push(handle);
      invalidateMesh(handle, worldId);
    });
    const world = new World();
    const oldA = world.allocSharedRef('MeshAsset', mesh());
    const oldB = world.allocSharedRef('MeshAsset', mesh());
    const sharedMesh = mesh();
    sharedMesh.vertices[0] = 12;
    const sharedHandle = world.allocSharedRef('MeshAsset', sharedMesh);
    const entityA = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: oldA } },
        { component: MeshRenderer, data: { materials: [] } },
      )
      .unwrap();
    const entityB = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: oldB } },
        { component: MeshRenderer, data: { materials: [] } },
      )
      .unwrap();
    const host = createDynamicGeometryHost({
      lifecycle: createDynamicGeometryLifecycle(),
      attachedWorlds: new Set([world]),
      getGpuStore: () => store,
      currentGeneration: () => 1,
      isConsumedByRenderFrame: () => true,
    });
    const preparedA = host.prepareDynamicGeometry({
      world,
      entity: entityA,
      mesh: sharedMesh,
      meshHandle: sharedHandle,
      revision: 1,
    });
    expect(preparedA.ok).toBe(true);
    if (!preparedA.ok) return;
    const acceptedA = host.acceptDynamicGeometry(preparedA.value, { world, fixedStep: 0 });
    expect(acceptedA.ok).toBe(true);
    if (!acceptedA.ok) return;
    let completeA!: () => void;
    const pendingA = new Promise<void>((resolve) => {
      completeA = resolve;
    });
    expect(
      host.publishDynamicGeometry(
        { frameId: 1, deviceGeneration: 1, completed: pendingA },
        [world],
        0,
      ),
    ).toHaveLength(1);

    const preparedB = host.prepareDynamicGeometry({
      world,
      entity: entityB,
      mesh: sharedMesh,
      meshHandle: sharedHandle,
      revision: 2,
    });
    expect(preparedB.ok).toBe(true);
    if (!preparedB.ok) return;
    expect(world.set(entityA, MeshFilter, { assetHandle: oldA }).ok).toBe(true);
    expect(host.retireDynamicGeometry(acceptedA.value).ok).toBe(true);

    // B only owns a prepared candidate. Cancelling it releases B's lease but
    // cannot evict H while A's submitted frame still owns the cache entry.
    expect(host.cancelDynamicGeometry(preparedB.value).ok).toBe(true);
    expect(store.getMeshGpuHandles(sharedHandle, world)).toBeDefined();
    expect(invalidated).toEqual([]);

    completeA();
    await Promise.resolve();
    expect(store.getMeshGpuHandles(sharedHandle, world)).toBeUndefined();
    expect(invalidated).toEqual([sharedHandle]);
  });

  it('keeps pending retirements inside the count and byte budget', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const store = new GpuResidencyCache();
    store.configureGpuDevice(
      device,
      undefined,
      () => {
        throw new Error('cubemap registration is not part of this test');
      },
      device.caps,
    );
    const invalidated: number[] = [];
    const invalidateMesh = store.invalidateMesh.bind(store);
    vi.spyOn(store, 'invalidateMesh').mockImplementation((handle, worldId = 0) => {
      invalidated.push(handle);
      invalidateMesh(handle, worldId);
    });
    const lifecycle = createDynamicGeometryLifecycle();
    const world = new World();
    const liveHandle = world.allocSharedRef('MeshAsset', mesh());
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: liveHandle } },
        { component: MeshRenderer, data: { materials: [] } },
      )
      .unwrap();
    const host = createDynamicGeometryHost({
      lifecycle,
      attachedWorlds: new Set([world]),
      getGpuStore: () => store,
      currentGeneration: () => 1,
      isConsumedByRenderFrame: () => true,
    });
    const completions: Array<() => void> = [];
    const handles: Handle<'MeshAsset', 'shared'>[] = [];
    let candidateBytes = 0;
    for (let revision = 1; revision <= 32; revision += 1) {
      const candidateMesh = mesh();
      candidateMesh.vertices[0] = revision;
      const handle = world.allocSharedRef('MeshAsset', candidateMesh);
      const prepared = host.prepareDynamicGeometry({
        world,
        entity,
        mesh: candidateMesh,
        meshHandle: handle,
        revision,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      candidateBytes = prepared.value.meshBytes;
      const accepted = host.acceptDynamicGeometry(prepared.value, { world, fixedStep: 0 });
      expect(accepted.ok).toBe(true);
      if (!accepted.ok) return;
      let complete!: () => void;
      const pending = new Promise<void>((resolve) => {
        complete = resolve;
      });
      completions.push(complete);
      expect(
        host.publishDynamicGeometry(
          { frameId: revision, deviceGeneration: 1, completed: pending },
          [world],
          0,
        ),
      ).toHaveLength(1);
      expect(world.set(entity, MeshFilter, { assetHandle: liveHandle }).ok).toBe(true);
      expect(host.retireDynamicGeometry(accepted.value).ok).toBe(true);
      handles.push(handle);
    }

    const blockedMesh = mesh();
    const blockedHandle = world.allocSharedRef('MeshAsset', blockedMesh);
    expect(
      host.prepareDynamicGeometry({
        world,
        entity,
        mesh: blockedMesh,
        meshHandle: blockedHandle,
        revision: 33,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'dynamic-geometry-budget-exceeded' },
    });
    expect(world.sharedRefs.release(blockedHandle).ok).toBe(true);
    expect(lifecycle.inspect()).toMatchObject({
      prepared: 0,
      accepted: 0,
      published: 0,
      retired: 32,
      meshBytes: candidateBytes * 32,
    });
    expect(
      handles.filter((handle) => store.getMeshGpuHandles(handle, world) !== undefined),
    ).toHaveLength(32);

    completions.forEach((complete) => {
      complete();
    });
    await Promise.resolve();
    await vi.waitFor(() => expect(lifecycle.inspect().meshBytes).toBe(0));
    expect(invalidated).toHaveLength(32);
    expect(handles.every((handle) => store.getMeshGpuHandles(handle, world) === undefined)).toBe(
      true,
    );
  });

  it('supersedes an older un-published candidate after a newer ECS swap', () => {
    const world = new World();
    const oldHandle = world.allocSharedRef('MeshAsset', mesh());
    const firstMesh = mesh();
    firstMesh.vertices[0] = 2;
    const firstHandle = world.allocSharedRef('MeshAsset', firstMesh);
    const secondMesh = mesh();
    secondMesh.vertices[0] = 3;
    const secondHandle = world.allocSharedRef('MeshAsset', secondMesh);
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: oldHandle } },
        { component: MeshRenderer, data: { materials: [] } },
      )
      .unwrap();
    const invalidated: number[] = [];
    const host = createDynamicGeometryHost({
      lifecycle: createDynamicGeometryLifecycle(),
      attachedWorlds: new Set([world]),
      getGpuStore: () =>
        ({
          ensureResident: () => ({ ok: true as const, value: {} }),
          retainMeshResidency: (handle: number) => residencyLease(handle, invalidated),
          invalidateMesh: (handle: number) => invalidated.push(handle),
        }) as unknown as GpuResidencyCache,
      currentGeneration: () => 1,
      isConsumedByRenderFrame: () => true,
    });
    const first = host.prepareDynamicGeometry({
      world,
      entity,
      mesh: firstMesh,
      meshHandle: firstHandle,
      revision: 1,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(host.acceptDynamicGeometry(first.value, { world, fixedStep: 0 }).ok).toBe(true);
    const second = host.prepareDynamicGeometry({
      world,
      entity,
      mesh: secondMesh,
      meshHandle: secondHandle,
      revision: 2,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const accepted = host.acceptDynamicGeometry(second.value, { world, fixedStep: 0 });
    expect(accepted.ok).toBe(true);
    expect(world.get(entity, MeshFilter).unwrap().assetHandle).toBe(secondHandle);
    expect(host.cancelDynamicGeometry(first.value)).toMatchObject({
      ok: false,
      error: { code: 'dynamic-geometry-candidate-not-found' },
    });
    expect(invalidated).toContain(firstHandle);
  });

  it('preserves another entity candidate when a newer topology is accepted', () => {
    const world = new World();
    const firstLive = world.allocSharedRef('MeshAsset', mesh());
    const firstCandidateMesh = mesh();
    firstCandidateMesh.vertices[0] = 5;
    const firstCandidateHandle = world.allocSharedRef('MeshAsset', firstCandidateMesh);
    const secondLive = world.allocSharedRef('MeshAsset', mesh());
    const secondCandidateMesh = mesh();
    secondCandidateMesh.vertices[0] = 6;
    const secondCandidateHandle = world.allocSharedRef('MeshAsset', secondCandidateMesh);
    const firstEntity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: firstLive } },
        { component: MeshRenderer, data: { materials: [] } },
      )
      .unwrap();
    const secondEntity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: secondLive } },
        { component: MeshRenderer, data: { materials: [] } },
      )
      .unwrap();
    const invalidated: number[] = [];
    const host = createDynamicGeometryHost({
      lifecycle: createDynamicGeometryLifecycle(),
      attachedWorlds: new Set([world]),
      getGpuStore: () =>
        ({
          ensureResident: () => ({ ok: true as const, value: {} }),
          retainMeshResidency: (handle: number) => residencyLease(handle, invalidated),
          invalidateMesh: (handle: number) => invalidated.push(handle),
        }) as unknown as GpuResidencyCache,
      currentGeneration: () => 1,
      isConsumedByRenderFrame: () => true,
    });
    const first = host.prepareDynamicGeometry({
      world,
      entity: firstEntity,
      mesh: firstCandidateMesh,
      meshHandle: firstCandidateHandle,
      revision: 1,
      topologyRevision: 1,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = host.prepareDynamicGeometry({
      world,
      entity: secondEntity,
      mesh: secondCandidateMesh,
      meshHandle: secondCandidateHandle,
      revision: 2,
      topologyRevision: 2,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(host.acceptDynamicGeometry(second.value, { world, fixedStep: 0 }).ok).toBe(true);
    expect(invalidated).not.toContain(firstCandidateHandle);
    expect(host.cancelDynamicGeometry(first.value).ok).toBe(true);
    expect(invalidated).toContain(firstCandidateHandle);
    expect(world.sharedRefs.refcount(firstCandidateHandle)).toBe(1);
  });

  it('requires a live MeshFilter/MeshRenderer binding and withholds receipts until draw consumption', async () => {
    const world = new World();
    const sourceMesh = mesh();
    const meshHandle = world.allocSharedRef('MeshAsset', sourceMesh);
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: meshHandle } },
        { component: MeshRenderer, data: { materials: [] } },
      )
      .unwrap();
    const attachedWorlds = new Set([world]);
    const lifecycle = createDynamicGeometryLifecycle();
    const invalidatedMeshes: Array<{ readonly handle: number; readonly world: World }> = [];
    let consumedByFrame = false;
    const gpuStore = {
      ensureResident: () => ({ ok: true as const, value: {} }),
      retainMeshResidency: (handle: number) => {
        const lifetime = new ResidencyLifetime(() => invalidatedMeshes.push({ handle, world }));
        return lifetime.retain(() => lifetime.retire());
      },
      invalidateMesh: (handle: number, invalidationWorld: World) => {
        invalidatedMeshes.push({ handle, world: invalidationWorld });
      },
    } as unknown as GpuResidencyCache;
    const host = createDynamicGeometryHost({
      lifecycle,
      attachedWorlds,
      getGpuStore: () => gpuStore,
      currentGeneration: () => 1,
      isConsumedByRenderFrame: () => consumedByFrame,
    });

    const prepared = host.prepareDynamicGeometry({
      world,
      entity,
      mesh: sourceMesh,
      meshHandle,
      revision: 1,
      topologyRevision: 1,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const accepted = host.acceptDynamicGeometry(prepared.value, { world, fixedStep: 0 });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;

    const replacementHandle = world.allocSharedRef('MeshAsset', mesh());
    expect(world.set(entity, MeshFilter, { assetHandle: replacementHandle }).ok).toBe(true);
    expect(host.publishDynamicGeometry({ frameId: 1, deviceGeneration: 1 }, [world], 0)).toEqual(
      [],
    );
    expect(host.dynamicGeometryReceipt(accepted.value)).toBeUndefined();

    expect(world.set(entity, MeshFilter, { assetHandle: meshHandle }).ok).toBe(true);
    consumedByFrame = true;
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const receipts = host.publishDynamicGeometry(
      { frameId: 2, deviceGeneration: 1, completed },
      [world],
      0,
    );
    expect(receipts).toHaveLength(1);
    expect(host.dynamicGeometryReceipt(accepted.value)).toMatchObject({ frameId: 2 });

    const bindings: ComponentData[] = [
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: { materials: [] } },
    ];
    for (const binding of bindings) {
      world.removeComponent(entity, binding.component).unwrap();
      expect(host.publishDynamicGeometry({ frameId: 3, deviceGeneration: 1 }, [world], 0)).toEqual(
        [],
      );
      expect(host.dynamicGeometryReceipt(accepted.value)).toMatchObject({ frameId: 2 });
      expect(invalidatedMeshes).toEqual([]);
      world.addComponent(entity, binding).unwrap();
    }

    const topologyMesh = mesh();
    topologyMesh.vertices[0] = 8;
    const topologyHandle = world.allocSharedRef('MeshAsset', topologyMesh);
    const topologyCandidate = host.prepareDynamicGeometry({
      world,
      entity,
      mesh: topologyMesh,
      meshHandle: topologyHandle,
      revision: 2,
      topologyRevision: 2,
    });
    expect(topologyCandidate.ok).toBe(true);
    if (!topologyCandidate.ok) return;
    expect(host.acceptDynamicGeometry(topologyCandidate.value, { world, fixedStep: 0 }).ok).toBe(
      true,
    );
    // Topology invalidates temporal history, but the receipt fence remains
    // queryable until explicit retirement and FrameReceipt completion.
    expect(host.dynamicGeometryReceipt(accepted.value)).toMatchObject({ frameId: 2 });
    expect(host.cancelDynamicGeometry(accepted.value)).toMatchObject({
      ok: false,
      error: { code: 'dynamic-geometry-candidate-state' },
    });
    expect(world.get(entity, MeshFilter).unwrap().assetHandle).toBe(topologyHandle);
    // Retiring while the accepted handle is still live is safe but cannot
    // evict that binding. The consumer first swaps its ECS binding away, then
    // the FrameReceipt completion fence permits GPU destruction.
    expect(world.set(entity, MeshFilter, { assetHandle: replacementHandle }).ok).toBe(true);
    expect(host.retireDynamicGeometry(accepted.value).ok).toBe(true);
    expect(invalidatedMeshes).toEqual([]);
    complete();
    await Promise.resolve();
    expect(invalidatedMeshes).toEqual([{ handle: meshHandle, world }]);
    expect(host.dynamicGeometryReceipt(accepted.value)).toBeUndefined();
  });

  it('rejects a candidate without an actual ECS render entity before GPU admission', () => {
    const invalidated: number[] = [];
    const world = new World();
    const sourceMesh = mesh();
    const meshHandle = world.allocSharedRef('MeshAsset', sourceMesh);
    const host = createDynamicGeometryHost({
      lifecycle: createDynamicGeometryLifecycle(),
      attachedWorlds: new Set([world]),
      getGpuStore: () =>
        ({
          ensureResident: () => ({ ok: true as const, value: {} }),
          retainMeshResidency: (handle: number) => residencyLease(handle, invalidated),
        }) as unknown as GpuResidencyCache,
      currentGeneration: () => 1,
      isConsumedByRenderFrame: () => false,
    });

    expect(
      host.prepareDynamicGeometry({
        world,
        mesh: sourceMesh,
        meshHandle,
        revision: 1,
      }),
    ).toMatchObject({ ok: false, error: { code: 'dynamic-geometry-invalid' } });

    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: meshHandle } },
        { component: MeshRenderer, data: { materials: [] } },
      )
      .unwrap();
    expect(
      host.prepareDynamicGeometry({ world, entity, mesh: sourceMesh, revision: 2 }),
    ).toMatchObject({ ok: false, error: { code: 'dynamic-geometry-gpu-not-ready' } });
  });

  it('requires active PhysicsWorld admission, not an already committed publication', () => {
    const invalidated: number[] = [];
    const world = new World();
    const sourceMesh = mesh();
    const meshHandle = world.allocSharedRef('MeshAsset', sourceMesh);
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: meshHandle } },
        { component: MeshRenderer, data: { materials: [] } },
      )
      .unwrap();
    let publication: { readonly revision: number; readonly fixedStep: number } | undefined;
    let admission: typeof publication;
    world.insertResource('PhysicsWorld', {
      getDerivedPublication: () => publication,
      getDerivedAdmission: () => admission,
    });
    const host = createDynamicGeometryHost({
      lifecycle: createDynamicGeometryLifecycle(),
      attachedWorlds: new Set([world]),
      getGpuStore: () =>
        ({
          ensureResident: () => ({ ok: true as const, value: {} }),
          retainMeshResidency: (handle: number) => residencyLease(handle, invalidated),
        }) as unknown as GpuResidencyCache,
      currentGeneration: () => 1,
      isConsumedByRenderFrame: () => true,
    });
    const prepared = host.prepareDynamicGeometry({
      world,
      entity,
      physicsEntity: entity,
      mesh: sourceMesh,
      meshHandle,
      revision: 1,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(host.acceptDynamicGeometry(prepared.value, { world, fixedStep: 0 })).toMatchObject({
      ok: false,
      error: { code: 'dynamic-geometry-ordering-required' },
    });
    publication = { revision: 1, fixedStep: 0 };
    expect(host.acceptDynamicGeometry(prepared.value, { world, fixedStep: 0 })).toMatchObject({
      ok: false,
      error: { code: 'dynamic-geometry-ordering-required' },
    });
    admission = publication;
    const accepted = host.acceptDynamicGeometry(prepared.value, { world, fixedStep: 0 });
    admission = undefined;
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(
      host.publishDynamicGeometry({ frameId: 1, deviceGeneration: 1 }, [world], 0),
    ).toHaveLength(1);
  });
});
