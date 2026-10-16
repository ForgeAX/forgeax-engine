import { FixedTime, FixedUpdate, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Transform } from '@forgeax/engine-scene';
import { err, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import {
  createDynamicGeometrySourceHost,
  type DynamicGeometryResidencyPort,
} from '../assembly/dynamic-geometry-host';
import { MeshFilter, MeshRenderer } from '../components';
import { ResidencyLifetime } from '../device/residency-lifetime';
import { createDynamicGeometryLifecycle, DynamicGeometryError } from '../dynamic-geometry';

function fixture(maxConcurrentPreparations = 1, lifecycle = createDynamicGeometryLifecycle()) {
  const world = new World();
  world.addSystem(FixedUpdate, { name: 'source-fixed-time', queries: [], fn: () => {} }).unwrap();
  const previous = world.allocSharedRef('MeshAsset', createBoxGeometry(1, 1, 1).unwrap());
  const mesh = createBoxGeometry(2, 2, 2).unwrap();
  const meshHandle = world.allocSharedRef('MeshAsset', mesh);
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: previous } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();
  const attachedWorlds = new Set([world]);
  let generation = 1,
    publishedTick: number | undefined;
  let consumed = false,
    current = true,
    destroyed = false;
  const pending: {
    resolve(result: Awaited<ReturnType<DynamicGeometryResidencyPort['prepare']>>): void;
    reject(cause: unknown): void;
  }[] = [];
  const lifetime = new ResidencyLifetime(() => {
    destroyed = true;
  });
  const prepare = vi.fn<DynamicGeometryResidencyPort['prepare']>(
    () =>
      new Promise((done, fail) => {
        pending.push({ resolve: done, reject: fail });
      }),
  );
  const next = () => {
    const preparation = pending.shift();
    if (preparation === undefined) throw new Error('no physical preparation to settle');
    return preparation;
  };
  const host = createDynamicGeometrySourceHost({
    lifecycle,
    attachedWorlds,
    currentGeneration: () => generation,
    residency: { prepare, maxConcurrentPreparations },
    isConsumedByRenderFrame: () => consumed,
    recordStageLane: () => (consumed ? 'gpu' : undefined),
    publishedFixedStep: () => publishedTick,
  });
  return {
    world,
    previous,
    meshHandle,
    entity,
    lifecycle,
    host,
    prepare,
    lifetime,
    pendingCount: () => pending.length,
    input: { world, entity, mesh, meshHandle, revision: 1 },
    ready: () => {
      const lease = lifetime.retain(() => lifetime.retire());
      next().resolve(ok({ isCurrent: () => current && !destroyed, release: lease.release }));
    },
    fail: () =>
      next().resolve(
        err(new DynamicGeometryError('dynamic-geometry-gpu-failed', 'upload succeeds', 'retry')),
      ),
    failUnexpectedly: () => next().reject(new Error('unknown physical ownership')),
    detach: () => {
      attachedWorlds.delete(world);
      host.invalidateDynamicGeometryWorld(world);
    },
    recover: () => {
      generation++;
    },
    invalidateResidency: () => {
      current = false;
    },
    submitted: (withTick = true) => {
      consumed = true;
      publishedTick = withTick ? world.getResource(FixedTime).tick : undefined;
    },
    destroyed: () => destroyed,
  };
}

it('reserves the existing candidate budget while waiting and mutates only on synchronous admission', async () => {
  const f = fixture();
  const pending = f.host.prepareDynamicGeometry(f.input);
  expect(f.lifecycle.inspect().prepared).toBe(1);
  expect(f.lifecycle.inspect().meshBytes).toBeGreaterThan(0);
  expect(f.world.get(f.entity, MeshFilter).unwrap().assetHandle).toBe(f.previous);
  await Promise.resolve();
  f.ready();
  const candidate = (await pending).unwrap();
  expect(f.host.isDynamicGeometryCurrent(candidate)).toBe(true);
  expect(f.world.get(f.entity, MeshFilter).unwrap().assetHandle).toBe(f.previous);
  let accepted = false;
  f.world
    .addSystem(FixedUpdate, {
      name: 'admit-source-geometry',
      queries: [],
      fn: () => {
        if (accepted) return;
        f.host
          .acceptDynamicGeometry(candidate, {
            world: f.world,
            fixedStep: f.world.getResource(FixedTime).tick,
          })
          .unwrap();
        accepted = true;
      },
    })
    .unwrap();
  f.world.update(1 / 60).unwrap();
  expect(accepted).toBe(true);
  expect(f.world.get(f.entity, MeshFilter).unwrap().assetHandle).toBe(f.meshHandle);
});

it('copies geometry once before async upload and accepts only a payload-free credential', async () => {
  const f = fixture();
  let copies = 0;
  class CountedPositions extends Float32Array {
    constructor(values: ArrayLike<number>) {
      super(values);
      copies++;
    }
  }
  const source = f.input.mesh;
  if (
    !(source.attributes.position instanceof Float32Array) ||
    source.indices === undefined ||
    source.aabb === undefined
  )
    throw new Error('fixture mesh is missing geometry');
  source.attributes.position = new CountedPositions(source.attributes.position);
  const original = {
    vertex: source.vertices[0],
    position: source.attributes.position[0],
    index: source.indices[0],
    bound: source.aabb[0],
  };
  copies = 0;
  const pending = f.host.prepareDynamicGeometry(f.input);
  // The source can change before the port's first microtask or capacity wait.
  source.vertices[0] = 123;
  source.attributes.position[0] = 234;
  source.indices[0] = 999;
  source.aabb[0] = 345;
  await Promise.resolve();
  const snapshot = f.prepare.mock.calls[0]?.[0].mesh;
  expect(snapshot).toBeDefined();
  expect(snapshot).not.toBe(source);
  expect(snapshot?.vertices[0]).toBe(original.vertex);
  const snapshotPositions = snapshot?.attributes.position;
  if (!(snapshotPositions instanceof Float32Array)) throw new Error('snapshot has no positions');
  expect(snapshotPositions[0]).toBe(original.position);
  expect(snapshot?.indices?.[0]).toBe(original.index);
  expect(snapshot?.aabb?.[0]).toBe(original.bound);
  expect(copies).toBe(1);
  f.ready();
  const candidate = (await pending).unwrap();
  expect(candidate).not.toHaveProperty('mesh');
  const ordering = { world: f.world, fixedStep: f.world.getResource(FixedTime).tick };
  const before = f.lifecycle.inspect();
  expect(f.host.acceptDynamicGeometry({ ...candidate, revision: 9 }, ordering).ok).toBe(false);
  expect(f.lifecycle.inspect()).toEqual(before);
  expect(f.world.get(f.entity, MeshFilter).unwrap().assetHandle).toBe(f.previous);
  const accepted = f.host.acceptDynamicGeometry(candidate, ordering).unwrap();
  expect(accepted).not.toHaveProperty('mesh');
  expect(copies).toBe(1);
  expect(f.world.get(f.entity, MeshFilter).unwrap().assetHandle).toBe(f.meshHandle);
  f.detach();
});

it.each([
  'count',
  'bytes',
] as const)('does not copy geometry refused by the %s budget', async (budget) => {
  const f = fixture(1, createDynamicGeometryLifecycle(1, budget === 'bytes' ? 1 : undefined));
  let copies = 0;
  class CountedPositions extends Float32Array {
    constructor(values: ArrayLike<number>) {
      super(values);
      copies++;
    }
  }
  if (!(f.input.mesh.attributes.position instanceof Float32Array))
    throw new Error('fixture has no positions');
  f.input.mesh.attributes.position = new CountedPositions(f.input.mesh.attributes.position);
  const held = budget === 'count' ? f.host.prepareDynamicGeometry(f.input) : undefined;
  copies = 0;
  f.lifecycle.invalidateGeneration(1);
  const before = f.lifecycle.inspect();
  const refs = [f.previous, f.meshHandle].map((handle) => f.world.sharedRefs.refcount(handle));
  const refused = await f.host.prepareDynamicGeometry({ ...f.input, revision: 2 });
  expect(refused).toMatchObject({ ok: false, error: { code: 'dynamic-geometry-budget-exceeded' } });
  expect(copies).toBe(0);
  expect(f.lifecycle.inspect()).toEqual(before);
  expect([f.previous, f.meshHandle].map((handle) => f.world.sharedRefs.refcount(handle))).toEqual(
    refs,
  );
  expect(f.prepare).toHaveBeenCalledTimes(held === undefined ? 0 : 1);
  if (held !== undefined) {
    f.ready();
    (await held).unwrap();
  }
  f.detach();
});

it('restores a single snapshot failure before upload and can retry', async () => {
  const f = fixture();
  let failCopy = false;
  class CheckedPositions extends Float32Array {
    constructor(values: ArrayLike<number>) {
      super(values);
      if (failCopy) throw new Error('snapshot unavailable');
    }
  }
  if (!(f.input.mesh.attributes.position instanceof Float32Array))
    throw new Error('fixture has no positions');
  f.input.mesh.attributes.position = new CheckedPositions(f.input.mesh.attributes.position);
  f.lifecycle.invalidateGeneration(1);
  const before = f.lifecycle.inspect();
  const refs = [f.previous, f.meshHandle].map((handle) => f.world.sharedRefs.refcount(handle));
  failCopy = true;
  await expect(f.host.prepareDynamicGeometry(f.input)).rejects.toThrow('snapshot unavailable');
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.lifecycle.inspect()).toEqual(before);
  expect([f.previous, f.meshHandle].map((handle) => f.world.sharedRefs.refcount(handle))).toEqual(
    refs,
  );
  expect(f.host.dynamicGeometryFault(f.world)).toBeUndefined();
  expect(f.world.get(f.entity, MeshFilter).unwrap().assetHandle).toBe(f.previous);
  failCopy = false;
  const retry = f.host.prepareDynamicGeometry(f.input);
  await Promise.resolve();
  f.ready();
  const candidate = (await retry).unwrap();
  f.host.acceptDynamicGeometry(candidate, { world: f.world, fixedStep: 0 }).unwrap();
  expect(f.world.get(f.entity, MeshFilter).unwrap().assetHandle).toBe(f.meshHandle);
  f.detach();
});

it.each([
  'ordinary',
  'shared',
  'custom-constructor',
] as const)('moves only exclusive snapshot buffers from %s author storage', async (kind) => {
  const f = fixture();
  let leaked: Float32Array | undefined;
  class AliasedPositions extends Float32Array {
    constructor(values: ArrayLike<number>) {
      super(values);
      leaked = this;
    }
  }
  const positions = f.input.mesh.attributes.position;
  if (!(positions instanceof Float32Array)) throw new Error('fixture has no positions');
  if (kind === 'shared') {
    const shared = new Float32Array(new SharedArrayBuffer(positions.byteLength));
    shared.set(positions);
    f.input.mesh.attributes.position = shared;
  } else if (kind === 'custom-constructor') {
    f.input.mesh.attributes.position = new AliasedPositions(positions);
  }
  const authorPositions = f.input.mesh.attributes.position;
  if (!(authorPositions instanceof Float32Array)) throw new Error('author positions missing');
  const expected = structuredClone(f.input.mesh);
  let received: typeof expected | undefined;
  f.prepare.mockImplementationOnce(async (input, options) => {
    const transfers = options?.transfers;
    expect(transfers?.length).toBeGreaterThan(0);
    expect(transfers).not.toContain(f.input.mesh.vertices.buffer);
    expect(transfers).not.toContain(authorPositions.buffer);
    const privateVertices = input.mesh.vertices;
    const privatePositions = input.mesh.attributes.position;
    received = structuredClone(input.mesh, { transfer: [...(transfers ?? [])] });
    expect(privateVertices.byteLength).toBe(0);
    if (kind === 'custom-constructor') {
      expect(privatePositions?.byteLength).toBeGreaterThan(0);
      expect(leaked).toBe(privatePositions);
      if (leaked === undefined) throw new Error('custom snapshot alias missing');
      leaked[0] = 321;
    } else {
      expect(privatePositions?.byteLength).toBe(0);
    }
    return ok({ isCurrent: () => true, release: () => undefined });
  });
  const materialIdentity = f.input.mesh.materialSlots[0]?.slotName;
  if (materialIdentity === undefined) throw new Error('fixture has no material identity');
  const candidate = (
    await f.host.prepareDynamicGeometry({ ...f.input, materialIdentity })
  ).unwrap();
  expect(f.input.mesh.vertices.byteLength).toBeGreaterThan(0);
  expect(f.input.mesh.attributes.position?.byteLength).toBeGreaterThan(0);
  if (kind === 'shared') {
    const position = received?.attributes.position;
    expect(ArrayBuffer.isView(position) && position.buffer instanceof ArrayBuffer).toBe(true);
  }
  expect(received).toEqual(expected);
  f.host.acceptDynamicGeometry(candidate, { world: f.world, fixedStep: 0 }).unwrap();
  expect(f.world.get(f.entity, MeshFilter).unwrap().assetHandle).toBe(f.meshHandle);
  f.detach();
});

it('snapshots every batch member before an earlier upload delays its window', async () => {
  const f = fixture(1);
  const secondEntity = f.world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: f.previous } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();
  const before = f.input.mesh.vertices[0];
  const pending = f.host.prepareDynamicGeometryCandidates([
    f.input,
    { ...f.input, entity: secondEntity },
  ]);
  f.input.mesh.vertices[0] = 456;
  await Promise.resolve();
  expect(f.prepare).toHaveBeenCalledTimes(1);
  expect(f.prepare.mock.calls[0]?.[0].mesh.vertices[0]).toBe(before);
  f.ready();
  for (let turn = 0; turn < 12 && f.prepare.mock.calls.length < 2; turn++) await Promise.resolve();
  expect(f.prepare).toHaveBeenCalledTimes(2);
  expect(f.prepare.mock.calls[1]?.[0].mesh.vertices[0]).toBe(before);
  f.ready();
  const candidates = (await pending).unwrap();
  expect(candidates).toHaveLength(2);
  expect(candidates.every((candidate) => !('mesh' in candidate))).toBe(true);
  f.detach();
});

it('rolls back a later snapshot-copy failure before starting any batch upload and can retry', async () => {
  const f = fixture(2);
  let copiesUntilFailure = Infinity;
  class CheckedPositions extends Float32Array {
    constructor(values: ArrayLike<number>) {
      super(values);
      if (--copiesUntilFailure === 0) throw new Error('snapshot unavailable');
    }
  }
  if (!(f.input.mesh.attributes.position instanceof Float32Array))
    throw new Error('fixture has no positions');
  f.input.mesh.attributes.position = new CheckedPositions(f.input.mesh.attributes.position);
  const secondEntity = f.world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: f.previous } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();
  const inputs = [f.input, { ...f.input, entity: secondEntity }];
  f.lifecycle.invalidateGeneration(1);
  const before = f.lifecycle.inspect();
  const refs = [f.previous, f.meshHandle].map((handle) => f.world.sharedRefs.refcount(handle));
  copiesUntilFailure = 2;
  await expect(f.host.prepareDynamicGeometryCandidates(inputs)).rejects.toThrow(
    'snapshot unavailable',
  );
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.lifecycle.inspect()).toEqual(before);
  expect([f.previous, f.meshHandle].map((handle) => f.world.sharedRefs.refcount(handle))).toEqual(
    refs,
  );
  expect(f.world.get(f.entity, MeshFilter).unwrap().assetHandle).toBe(f.previous);
  expect(f.world.get(secondEntity, MeshFilter).unwrap().assetHandle).toBe(f.previous);
  copiesUntilFailure = Infinity;
  const retry = f.host.prepareDynamicGeometryCandidates(inputs);
  await Promise.resolve();
  f.ready();
  f.ready();
  const candidates = (await retry).unwrap();
  expect(
    f.host.acceptDynamicGeometryCandidates(candidates, {
      world: f.world,
      fixedStep: f.world.getResource(FixedTime).tick,
    }).ok,
  ).toBe(true);
  f.detach();
});

it.each([
  'abort',
  'detach',
  'recover',
] as const)('keeps late %s cleanup and bytes fenced without changing the World', async (action) => {
  const f = fixture();
  const abort = new AbortController();
  const pending = f.host.prepareDynamicGeometry(f.input, { signal: abort.signal });
  await Promise.resolve();
  let complete!: () => void;
  const submitted = new Promise<void>((resolve) => {
    complete = resolve;
  });
  f.lifetime.track(submitted);
  if (action === 'abort') abort.abort();
  if (action === 'detach') f.detach();
  if (action === 'recover') f.recover();
  f.ready();
  await Promise.resolve();
  await Promise.resolve();
  expect(f.lifecycle.inspect().meshBytes).toBeGreaterThan(0);
  expect(f.destroyed()).toBe(false);
  expect(f.world.get(f.entity, MeshFilter).unwrap().assetHandle).toBe(f.previous);
  complete();
  expect(await pending).toMatchObject({
    ok: false,
    error: {
      code:
        action === 'abort'
          ? 'dynamic-geometry-candidate-state'
          : action === 'detach'
            ? 'dynamic-geometry-world-not-attached'
            : 'dynamic-geometry-generation-mismatch',
    },
  });
  await vi.waitFor(() => expect(f.lifecycle.inspect().meshBytes).toBe(0));
  expect(f.destroyed()).toBe(true);
  expect(f.world.get(f.entity, MeshFilter).unwrap().assetHandle).toBe(f.previous);
});

it.each([
  'abort',
  'detach',
  'recover',
] as const)('rejects a faulted concurrent batch after %s without declaring its retained cleanup complete', async (action) => {
  const f = fixture(4),
    controller = new AbortController(),
    inputs = batchInputs(f);
  const pending = f.host.prepareDynamicGeometryCandidates(inputs, { signal: controller.signal });
  const outcome = pending.then(
    (value) => ({ kind: 'fulfilled' as const, value }),
    (error: unknown) => ({ kind: 'rejected' as const, error }),
  );
  await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledTimes(4));
  if (action === 'abort') controller.abort();
  if (action === 'detach') f.detach();
  if (action === 'recover') f.recover();
  f.failUnexpectedly();
  await vi.waitFor(() => expect(f.host.dynamicGeometryFault(f.world)).toBeDefined());
  while (f.pendingCount()) f.ready();
  const result = await Promise.race([
    outcome,
    new Promise<{ kind: 'timeout' }>((resolve) =>
      setTimeout(() => resolve({ kind: 'timeout' }), 250),
    ),
  ]);
  expect(result).toMatchObject({ kind: 'rejected', error: { code: 'dynamic-geometry-invalid' } });
  expect(f.prepare).toHaveBeenCalledTimes(4);
  expect(f.lifecycle.inspect().meshBytes).toBeGreaterThan(0);
  expect(
    inputs.every(
      (input) => f.world.get(input.entity, MeshFilter).unwrap().assetHandle === f.previous,
    ),
  ).toBe(true);
});

it.each([
  'abort',
  'detach',
  'recover',
] as const)('rejects a concurrent native fault while %s cleanup retains a submitted fence', async (action) => {
  const f = fixture(4),
    controller = new AbortController();
  let complete!: () => void;
  f.lifetime.track(
    new Promise<void>((resolve) => {
      complete = resolve;
    }),
  );
  const pending = f.host.prepareDynamicGeometryCandidates(batchInputs(f), {
    signal: controller.signal,
  });
  const outcome = pending.then(
    (value) => ({ kind: 'fulfilled' as const, value }),
    (error: unknown) => ({ kind: 'rejected' as const, error }),
  );
  try {
    await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledTimes(4));
    if (action === 'abort') controller.abort();
    if (action === 'detach') f.detach();
    if (action === 'recover') f.recover();
    f.ready();
    await Promise.resolve();
    await Promise.resolve();
    f.failUnexpectedly();
    await vi.waitFor(() => expect(f.host.dynamicGeometryFault(f.world)).toBeDefined());
    while (f.pendingCount()) f.ready();
    const result = await Promise.race([
      outcome,
      new Promise<{ kind: 'timeout' }>((resolve) =>
        setTimeout(() => resolve({ kind: 'timeout' }), 250),
      ),
    ]);
    expect(result).toMatchObject({ kind: 'rejected', error: { code: 'dynamic-geometry-invalid' } });
    expect(f.destroyed()).toBe(false);
    expect(f.lifecycle.inspect().meshBytes).toBeGreaterThan(0);
    expect(f.prepare).toHaveBeenCalledTimes(4);
  } finally {
    complete();
    while (f.pendingCount()) f.ready();
  }
});

it('returns a refused preparation with no candidate budget or binding mutation', async () => {
  const f = fixture();
  const pending = f.host.prepareDynamicGeometry(f.input);
  await Promise.resolve();
  f.fail();
  expect(await pending).toMatchObject({
    ok: false,
    error: { code: 'dynamic-geometry-gpu-failed' },
  });
  expect(f.lifecycle.inspect().meshBytes).toBe(0);
  expect(f.world.get(f.entity, MeshFilter).unwrap().assetHandle).toBe(f.previous);
});

function batchInputs(f: ReturnType<typeof fixture>) {
  return Array.from({ length: 33 }, () => {
    const entity = f.world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: f.previous } },
        { component: MeshRenderer, data: {} },
      )
      .unwrap();
    return { ...f.input, entity };
  });
}

it.each([
  'abort',
  'detach',
  'recover',
] as const)('releases an entire declared preparation after %s while its first physical request is pending', async (action) => {
  const f = fixture();
  const inputs = batchInputs(f);
  const references = [
    f.world.sharedRefs.refcount(f.previous),
    f.world.sharedRefs.refcount(f.meshHandle),
  ];
  const abort = new AbortController();
  const pending = f.host.prepareDynamicGeometryCandidates(inputs, { signal: abort.signal });
  expect(f.lifecycle.inspect().prepared).toBe(33);
  await Promise.resolve();
  expect(f.prepare).toHaveBeenCalledTimes(1);
  if (action === 'abort') abort.abort();
  if (action === 'detach') f.detach();
  if (action === 'recover') f.recover();
  f.ready();
  expect((await pending).ok).toBe(false);
  await vi.waitFor(() => expect(f.lifecycle.inspect().meshBytes).toBe(0));
  expect(f.prepare).toHaveBeenCalledTimes(1);
  expect(
    inputs.every(
      (input) => f.world.get(input.entity, MeshFilter).unwrap().assetHandle === f.previous,
    ),
  ).toBe(true);
  expect([
    f.world.sharedRefs.refcount(f.previous),
    f.world.sharedRefs.refcount(f.meshHandle),
  ]).toEqual(references);
  expect(f.destroyed()).toBe(true);
});

it('releases ready and unstarted members when a later declared preparation is refused', async () => {
  const f = fixture();
  const inputs = batchInputs(f);
  const references = [
    f.world.sharedRefs.refcount(f.previous),
    f.world.sharedRefs.refcount(f.meshHandle),
  ];
  const pending = f.host.prepareDynamicGeometryCandidates(inputs);
  await Promise.resolve();
  f.ready();
  await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledTimes(2));
  f.fail();
  expect(await pending).toMatchObject({
    ok: false,
    error: { code: 'dynamic-geometry-gpu-failed' },
  });
  await vi.waitFor(() => expect(f.lifecycle.inspect().meshBytes).toBe(0));
  expect(f.prepare).toHaveBeenCalledTimes(2);
  expect(
    inputs.every(
      (input) => f.world.get(input.entity, MeshFilter).unwrap().assetHandle === f.previous,
    ),
  ).toBe(true);
  expect([
    f.world.sharedRefs.refcount(f.previous),
    f.world.sharedRefs.refcount(f.meshHandle),
  ]).toEqual(references);
  expect(f.destroyed()).toBe(true);
});

it('revalidates remote allocation readiness at fixed-step admission', async () => {
  const f = fixture();
  const pending = f.host.prepareDynamicGeometry(f.input);
  await Promise.resolve();
  f.ready();
  const candidate = (await pending).unwrap();
  f.invalidateResidency();
  expect(f.host.isDynamicGeometryCurrent(candidate)).toBe(false);
  expect(f.host.acceptDynamicGeometry(candidate, { world: f.world, fixedStep: 0 })).toMatchObject({
    ok: false,
    error: { code: 'dynamic-geometry-gpu-not-ready' },
  });
  expect(f.world.get(f.entity, MeshFilter).unwrap().assetHandle).toBe(f.previous);
  f.host.cancelDynamicGeometry(candidate).unwrap();
});

it('invalidates a source candidate even if the native generation number did not change', async () => {
  const f = fixture();
  const pending = f.host.prepareDynamicGeometry(f.input);
  await Promise.resolve();
  f.ready();
  const candidate = (await pending).unwrap();
  f.host.invalidateDynamicGeometryWorld(f.world);
  expect(f.host.currentGeneration()).toBe(candidate.generation);
  expect(f.host.isDynamicGeometryCurrent(candidate)).toBe(false);
});

it('publishes the consumed source tick when simulation has advanced beyond its remote picture', async () => {
  const f = fixture();
  const pending = f.host.prepareDynamicGeometry(f.input);
  await Promise.resolve();
  f.ready();
  const candidate = (await pending).unwrap();
  const accepted = f.host
    .acceptDynamicGeometry(candidate, { world: f.world, fixedStep: 0 })
    .unwrap();
  expect(f.host.publishDynamicGeometry({ frameId: 1, deviceGeneration: 1 })).toEqual([]);
  f.submitted(false);
  expect(f.host.publishDynamicGeometry({ frameId: 1, deviceGeneration: 1 })).toEqual([]);
  f.submitted();
  f.world.update(1 / 60).unwrap();
  const receipts = f.host.publishDynamicGeometry({ frameId: 2, deviceGeneration: 1 });
  expect(f.world.getResource(FixedTime).tick).toBeGreaterThan(0);
  expect(receipts).toMatchObject([
    {
      candidateId: accepted.candidateId,
      publicationFixedStep: 0,
      frameId: 2,
      recordStageConsumed: true,
      recordStageLane: 'gpu',
    },
  ]);
});

it('faults the paired owner and keeps its budget when preparation throws with uncertain allocation', async () => {
  const f = fixture();
  const pending = f.host.prepareDynamicGeometry(f.input);
  const rejected = expect(pending).rejects.toMatchObject({ code: 'dynamic-geometry-invalid' });
  await Promise.resolve();
  f.failUnexpectedly();
  await rejected;
  expect(f.host.dynamicGeometryFault(f.world)).toBeDefined();
  expect(f.lifecycle.inspect().meshBytes).toBeGreaterThan(0);
  expect(f.world.get(f.entity, MeshFilter).unwrap().assetHandle).toBe(f.previous);
});

it('retains a standalone source mesh through pending upload and physical cancellation', async () => {
  const f = fixture();
  const pending = f.host.prepareMeshResidency(f.world, f.meshHandle);
  f.world.sharedRefs.release(f.meshHandle).unwrap();
  let complete!: () => void;
  f.lifetime.track(
    new Promise<void>((resolve) => {
      complete = resolve;
    }),
  );
  f.ready();
  const prepared = (await pending).unwrap();
  expect(prepared.isCurrent()).toBe(true);
  prepared.cancel();
  expect(prepared.isCurrent()).toBe(false);
  expect(f.world.sharedRefs.resolve(f.meshHandle).ok).toBe(true);
  expect(f.destroyed()).toBe(false);
  complete();
  await vi.waitFor(() => expect(f.destroyed()).toBe(true));
  expect(f.world.sharedRefs.resolve(f.meshHandle).ok).toBe(false);
  expect(f.lifecycle.inspect().meshBytes).toBe(0);
});

it('transfers a standalone preparation only after a live World binding owns the mesh', async () => {
  const f = fixture();
  const pending = f.host.prepareMeshResidency(f.world, f.meshHandle);
  f.ready();
  const prepared = (await pending).unwrap();
  f.world.set(f.entity, MeshFilter, { assetHandle: f.meshHandle }).unwrap();
  expect(prepared.commit()).toBe(true);
  expect(prepared.isCurrent()).toBe(false);
  expect(prepared.commit()).toBe(false);
  expect(f.destroyed()).toBe(false);
});

it('discards a standalone upload completed after its source generation changed', async () => {
  const f = fixture();
  const pending = f.host.prepareMeshResidency(f.world, f.meshHandle);
  f.recover();
  f.ready();
  expect(await pending).toMatchObject({
    ok: false,
    error: { code: 'mesh-residency-gpu-not-ready' },
  });
  expect(f.destroyed()).toBe(true);
  expect(f.world.get(f.entity, MeshFilter).unwrap().assetHandle).toBe(f.previous);
});

it.each([
  'abort',
  'detach',
  'recover',
  'refuse',
  'throw',
] as const)('drains every started member of a concurrent preparation window after %s', async (action) => {
  const f = fixture(4),
    abort = new AbortController(),
    inputs = batchInputs(f);
  const references = [
    f.world.sharedRefs.refcount(f.previous),
    f.world.sharedRefs.refcount(f.meshHandle),
  ];
  let settled = false;
  const pending = f.host.prepareDynamicGeometryCandidates(inputs, { signal: abort.signal });
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledTimes(4));
    expect(f.lifecycle.inspect().prepared).toBe(33);
    if (action === 'abort') abort.abort();
    if (action === 'detach') f.detach();
    if (action === 'recover') f.recover();
    if (action === 'refuse') f.fail();
    else if (action === 'throw') f.failUnexpectedly();
    else f.ready();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    while (f.pendingCount()) f.ready();
    if (action === 'throw') {
      await expect(pending).rejects.toMatchObject({ code: 'dynamic-geometry-invalid' });
      expect(f.host.dynamicGeometryFault(f.world)).toBeDefined();
      expect(f.lifecycle.inspect().meshBytes).toBeGreaterThan(0);
    } else expect((await pending).ok).toBe(false);
    expect(f.prepare).toHaveBeenCalledTimes(4);
    expect(
      inputs.every(
        (input) => f.world.get(input.entity, MeshFilter).unwrap().assetHandle === f.previous,
      ),
    ).toBe(true);
    if (action !== 'throw') {
      await vi.waitFor(() => expect(f.lifecycle.inspect().meshBytes).toBe(0));
      expect([
        f.world.sharedRefs.refcount(f.previous),
        f.world.sharedRefs.refcount(f.meshHandle),
      ]).toEqual(references);
    }
  } finally {
    abort.abort();
    while (f.pendingCount()) f.ready();
    await pending.catch(() => {});
  }
});
