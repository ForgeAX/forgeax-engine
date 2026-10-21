import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssetRegistry, runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { FixedTime, FixedUpdate, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Transform } from '@forgeax/engine-scene';
import { err, type MaterialAsset, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import {
  createDynamicGeometrySourceHost,
  type DynamicGeometryResidencyPort,
} from '../assembly/dynamic-geometry-host';
import { MeshFilter, MeshRenderer } from '../components';
import { ResidencyLifetime } from '../device/residency-lifetime';
import { createDynamicGeometryLifecycle, DynamicGeometryError } from '../dynamic-geometry';
import { Materials } from '../materials';

function fixture(
  maxConcurrentPreparations = 1,
  lifecycle = createDynamicGeometryLifecycle(),
  collective = false,
  maxSnapshots = 128,
) {
  const world = new World({ assets: new AssetRegistry({ limits: { maxSnapshots } }) });
  world.addSystem(FixedUpdate, { name: 'source-fixed-time', queries: [], fn: () => {} }).unwrap();
  const previous = runtimeAssetRegistry(world.assets)
    .create(createBoxGeometry(1, 1, 1).unwrap())
    .unwrap();
  const mesh = createBoxGeometry(2, 2, 2).unwrap();
  const meshHandle = runtimeAssetRegistry(world.assets).create(mesh).unwrap();
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
  let currentnessToken: object = Object.freeze({});
  const pending: {
    resolve(result: Awaited<ReturnType<DynamicGeometryResidencyPort['prepare']>>): void;
    reject(cause: unknown): void;
  }[] = [];
  const lifetime = new ResidencyLifetime(() => {
    destroyed = true;
    currentnessToken = Object.freeze({});
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
    residency: {
      prepare,
      maxConcurrentPreparations,
      ...(collective ? { currentnessToken: () => currentnessToken } : {}),
    },
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
      currentnessToken = Object.freeze({});
    },
    submitted: (withTick = true) => {
      consumed = true;
      publishedTick = withTick ? world.getResource(FixedTime).tick : undefined;
    },
    unconsumed: () => {
      consumed = false;
    },
    destroyed: () => destroyed,
  };
}

it('requires individual currentness checks when the physical owner has no collective proof', () => {
  const f = fixture();
  expect(f.host.dynamicGeometryCurrentness?.(f.world)).toBeUndefined();
});

it('checks the candidate itself even when the physical owner offers a collective token', async () => {
  const f = fixture(1, createDynamicGeometryLifecycle(), true);
  expect(f.host.dynamicGeometryCurrentness?.(f.world)).toBeDefined();
  const pending = f.host.prepareDynamicGeometry(f.input);
  await Promise.resolve();
  f.ready();
  const candidate = (await pending).unwrap();
  expect(f.host.isDynamicGeometryCurrent(candidate)).toBe(true);
  const currentness = f.host.dynamicGeometryCurrentness?.(f.world);
  expect(f.host.dynamicGeometryCurrentness?.(f.world)).toBe(currentness);
  runtimeAssetRegistry(f.world.assets)
    .update(f.meshHandle, {
      attributes: {
        ...f.input.mesh.attributes,
        position: new Float32Array(f.input.mesh.attributes.position as Float32Array).fill(0),
      },
    })
    .unwrap();
  expect(f.host.dynamicGeometryCurrentness?.(f.world)).not.toBe(currentness);
  expect(f.host.isDynamicGeometryCurrent(candidate)).toBe(false);
  expect(f.host.acceptDynamicGeometry(candidate, { world: f.world, fixedStep: 0 }).ok).toBe(false);
  f.detach();
});

it('invalidates the candidate before cancellation cleanup finishes', async () => {
  const f = fixture(1, createDynamicGeometryLifecycle(), true);
  const pending = f.host.prepareDynamicGeometry(f.input);
  await Promise.resolve();
  f.ready();
  const candidate = (await pending).unwrap();
  expect(f.host.isDynamicGeometryCurrent(candidate)).toBe(true);
  f.host.cancelDynamicGeometry(candidate).unwrap();
  expect(f.host.isDynamicGeometryCurrent(candidate)).toBe(false);
});

it('withholds collective currentness after uncertain native ownership faults the World', async () => {
  const f = fixture(1, createDynamicGeometryLifecycle(), true);
  expect(f.host.dynamicGeometryCurrentness?.(f.world)).toBeDefined();
  const pending = f.host.prepareDynamicGeometry(f.input);
  const rejected = expect(pending).rejects.toMatchObject({ code: 'dynamic-geometry-invalid' });
  await Promise.resolve();
  f.failUnexpectedly();
  await rejected;
  expect(f.host.dynamicGeometryFault(f.world)).toBeDefined();
  expect(f.host.dynamicGeometryCurrentness?.(f.world)).toBeUndefined();
});

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

it('captures managed content before async upload and accepts only a payload-free credential', async () => {
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
  expect(copies).toBe(0);
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
  expect(copies).toBe(0);
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
  const refs = [f.previous, f.meshHandle].map((handle) =>
    runtimeAssets(f.world.assets).refcount(handle),
  );
  const refused = await f.host.prepareDynamicGeometry({ ...f.input, revision: 2 });
  expect(refused).toMatchObject({ ok: false, error: { code: 'dynamic-geometry-budget-exceeded' } });
  expect(copies).toBe(0);
  expect(f.lifecycle.inspect()).toEqual(before);
  expect(
    [f.previous, f.meshHandle].map((handle) => runtimeAssets(f.world.assets).refcount(handle)),
  ).toEqual(refs);
  expect(f.prepare).toHaveBeenCalledTimes(held === undefined ? 0 : 1);
  if (held !== undefined) {
    f.ready();
    (await held).unwrap();
  }
  f.detach();
});

it('restores a snapshot budget refusal before upload and can retry', async () => {
  const f = fixture(1, createDynamicGeometryLifecycle(), false, 1);
  const held = runtimeAssetRegistry(f.world.assets).snapshot(f.meshHandle).unwrap();
  f.lifecycle.invalidateGeneration(1);
  const before = f.lifecycle.inspect();
  const refs = [f.previous, f.meshHandle].map((handle) =>
    runtimeAssets(f.world.assets).refcount(handle),
  );
  expect(await f.host.prepareDynamicGeometry(f.input)).toMatchObject({
    ok: false,
    error: { code: 'dynamic-geometry-budget-exceeded' },
  });
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.lifecycle.inspect()).toEqual(before);
  expect(
    [f.previous, f.meshHandle].map((handle) => runtimeAssets(f.world.assets).refcount(handle)),
  ).toEqual(refs);
  expect(f.host.dynamicGeometryFault(f.world)).toBeUndefined();
  expect(f.world.get(f.entity, MeshFilter).unwrap().assetHandle).toBe(f.previous);
  held.dispose();
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
    expect(privatePositions?.byteLength).toBe(0);
    if (leaked !== undefined) {
      expect(leaked).not.toBe(privatePositions);
      leaked[0] = 321;
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

it('rolls back a later snapshot budget refusal before starting any batch upload and can retry', async () => {
  const f = fixture(2, createDynamicGeometryLifecycle(), false, 2);
  const held = runtimeAssetRegistry(f.world.assets).snapshot(f.meshHandle).unwrap();
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
  const refs = [f.previous, f.meshHandle].map((handle) =>
    runtimeAssets(f.world.assets).refcount(handle),
  );
  expect(await f.host.prepareDynamicGeometryCandidates(inputs)).toMatchObject({
    ok: false,
    error: { code: 'dynamic-geometry-budget-exceeded' },
  });
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.lifecycle.inspect()).toEqual(before);
  expect(
    [f.previous, f.meshHandle].map((handle) => runtimeAssets(f.world.assets).refcount(handle)),
  ).toEqual(refs);
  expect(f.world.get(f.entity, MeshFilter).unwrap().assetHandle).toBe(f.previous);
  expect(f.world.get(secondEntity, MeshFilter).unwrap().assetHandle).toBe(f.previous);
  held.dispose();
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
    runtimeAssets(f.world.assets).refcount(f.previous),
    runtimeAssets(f.world.assets).refcount(f.meshHandle),
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
    runtimeAssets(f.world.assets).refcount(f.previous),
    runtimeAssets(f.world.assets).refcount(f.meshHandle),
  ]).toEqual(references);
  expect(f.destroyed()).toBe(true);
});

it('releases ready and unstarted members when a later declared preparation is refused', async () => {
  const f = fixture();
  const inputs = batchInputs(f);
  const references = [
    runtimeAssets(f.world.assets).refcount(f.previous),
    runtimeAssets(f.world.assets).refcount(f.meshHandle),
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
    runtimeAssets(f.world.assets).refcount(f.previous),
    runtimeAssets(f.world.assets).refcount(f.meshHandle),
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

it.each([
  1, 2,
])('publishes the consumed source tick after %i successor FixedUpdates', async (steps) => {
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
  f.world.update(steps / 60).unwrap();
  const receipts = f.host.publishDynamicGeometry({ frameId: 2, deviceGeneration: 1 });
  expect(f.world.getResource(FixedTime).tick).toBe(steps);
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
  runtimeAssets(f.world.assets).release(f.meshHandle).unwrap();
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
  expect(runtimeAssets(f.world.assets).resolveAsset(f.meshHandle).ok).toBe(true);
  expect(f.destroyed()).toBe(false);
  complete();
  await vi.waitFor(() => expect(f.destroyed()).toBe(true));
  expect(runtimeAssets(f.world.assets).resolveAsset(f.meshHandle).ok).toBe(false);
  expect(f.lifecycle.inspect().meshBytes).toBe(0);
});

it('transfers a standalone preparation only after a live World binding owns the mesh', async () => {
  const f = fixture();
  const pending = f.host.prepareMeshResidency(f.world, f.meshHandle);
  f.ready();
  const prepared = (await pending).unwrap();
  f.world.set(f.entity, MeshFilter, { assetHandle: f.meshHandle }).unwrap();
  expect(prepared.commit(f.entity)).toBe(true);
  expect(prepared.isCurrent()).toBe(false);
  expect(prepared.commit(f.entity)).toBe(false);
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
    runtimeAssets(f.world.assets).refcount(f.previous),
    runtimeAssets(f.world.assets).refcount(f.meshHandle),
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
        runtimeAssets(f.world.assets).refcount(f.previous),
        runtimeAssets(f.world.assets).refcount(f.meshHandle),
      ]).toEqual(references);
    }
  } finally {
    abort.abort();
    while (f.pendingCount()) f.ready();
    await pending.catch(() => {});
  }
});

it('rejects asynchronous residency prepared before a mesh edit and releases its snapshot', async () => {
  const f = fixture();
  const records = runtimeAssets(f.world.assets);
  const pending = f.host.prepareDynamicGeometry(f.input);
  await Promise.resolve();
  expect(records.inspect().snapshots).toBe(1);
  const positions = new Float32Array(f.input.mesh.attributes.position as Float32Array);
  positions[0] = 5;
  runtimeAssetRegistry(f.world.assets)
    .update(f.meshHandle, {
      attributes: {
        ...f.input.mesh.attributes,
        position: positions,
      },
    })
    .unwrap();
  f.ready();
  expect(await pending).toMatchObject({
    ok: false,
    error: { code: 'dynamic-geometry-candidate-state' },
  });
  expect(f.world.get(f.entity, MeshFilter).unwrap().assetHandle).toBe(f.previous);
  expect(records.inspect().snapshots).toBe(0);
  expect(f.lifecycle.inspect().meshBytes).toBe(0);
  f.detach();
});

async function publishedSameHandlePair(materialIdentity?: string) {
  const f = fixture();
  if (materialIdentity !== undefined) {
    const material = runtimeAssetRegistry(f.world.assets)
      .create({
        ...Materials.standard({ baseColor: [1, 1, 1, 1] }),
        sourceKey: materialIdentity,
      } as unknown as MaterialAsset)
      .unwrap();
    f.world.set(f.entity, MeshRenderer, { materials: [material] }).unwrap();
  }
  const publish = async (revision: number, frameId: number) => {
    const pending = f.host.prepareDynamicGeometry({
      ...f.input,
      revision,
      ...(materialIdentity === undefined ? {} : { materialIdentity }),
    });
    await Promise.resolve();
    f.ready();
    const prepared = (await pending).unwrap();
    const accepted = f.host
      .acceptDynamicGeometry(prepared, {
        world: f.world,
        fixedStep: f.world.getResource(FixedTime).tick,
      })
      .unwrap();
    f.submitted();
    const receipts = f.host.publishDynamicGeometry({ frameId, deviceGeneration: 1 });
    expect(receipts.some((receipt) => receipt.candidateId === accepted.candidateId)).toBe(true);
    expect(f.host.dynamicGeometryReceipt(accepted)).toBeDefined();
    return accepted;
  };
  const old = await publish(1, 1),
    successor = await publish(2, 2);
  return { f, old, successor };
}

it('retires only an old published same-handle lease with an explicit published successor credential', async () => {
  const { f, old, successor } = await publishedSameHandlePair();
  expect(f.host.retireDynamicGeometry(old).ok).toBe(false);
  // This optional proof must never be inferred from the shared handle alone.
  expect(f.host.retireSupersededDynamicGeometry?.(old, successor)?.ok).toBe(true);
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
  expect(f.host.dynamicGeometryReceipt(old)).toBeUndefined();
  expect(f.host.isDynamicGeometryCurrent(successor)).toBe(true);
  expect(f.world.get(f.entity, MeshFilter).unwrap().assetHandle).toBe(f.meshHandle);
  expect(f.destroyed()).toBe(false);
  f.world.despawn(f.entity).unwrap();
  expect(f.host.retireDynamicGeometry(successor).ok).toBe(true);
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
  expect(f.destroyed()).toBe(true);
});

it('rejects forged, self and not-current successor proofs without changing either published owner', async () => {
  const { f, old, successor } = await publishedSameHandlePair();
  const before = f.lifecycle.inspect();
  for (const invalid of [
    old,
    { ...successor, revision: successor.revision + 1 },
    { ...successor, owner: {} },
    { ...successor, generation: successor.generation + 1 },
  ]) {
    expect(f.host.retireSupersededDynamicGeometry?.(old, invalid)?.ok).toBe(false);
    expect(f.lifecycle.inspect()).toEqual(before);
  }
  f.invalidateResidency();
  expect(f.host.retireSupersededDynamicGeometry?.(old, successor)?.ok).toBe(false);
  expect(f.lifecycle.inspect()).toEqual(before);
});

it('keeps old published geometry when a registered accepted successor is cancelled', async () => {
  const { f, old, successor } = await publishedSameHandlePair();
  const pending = f.host.prepareDynamicGeometry({ ...f.input, revision: 3 });
  await Promise.resolve();
  f.ready();
  const prepared = (await pending).unwrap();
  expect(f.host.retireSupersededDynamicGeometry?.(old, prepared)?.ok).toBe(false);
  const accepted = f.host
    .acceptDynamicGeometry(prepared, {
      world: f.world,
      fixedStep: f.world.getResource(FixedTime).tick,
    })
    .unwrap();
  expect(f.host.retireSupersededDynamicGeometry?.(old, accepted)?.ok).toBe(true);
  expect(f.host.dynamicGeometryReceipt(old)).toBeDefined();
  expect(f.host.dynamicGeometryReceipt(accepted)).toBeUndefined();
  expect(f.host.retireSupersededDynamicGeometry?.(old, successor)?.ok).toBe(false);
  f.host.cancelDynamicGeometry(accepted).unwrap();
  f.host.publishDynamicGeometry({ frameId: 3, deviceGeneration: 1 });
  expect(f.host.retireSupersededDynamicGeometry?.(old, accepted)?.ok).toBe(false);
  expect(f.host.isDynamicGeometryCurrent(old)).toBe(true);
  expect(f.host.dynamicGeometryReceipt(old)).toBeDefined();
});

it('does not borrow a published successor after its live material binding changed', async () => {
  const { f, old, successor } = await publishedSameHandlePair('retirement-material');
  f.world.set(f.entity, MeshRenderer, { materials: [] }).unwrap();
  const before = f.lifecycle.inspect();
  expect(f.host.retireSupersededDynamicGeometry?.(old, successor)?.ok).toBe(false);
  expect(f.lifecycle.inspect()).toEqual(before);
  expect(f.host.dynamicGeometryReceipt(old)).toBeDefined();
});

it('defers same-entity retirement until the registered successor is truly consumed', async () => {
  const { f, old } = await publishedSameHandlePair();
  const pending = f.host.prepareDynamicGeometry({ ...f.input, revision: 3 });
  await Promise.resolve();
  f.ready();
  const prepared = (await pending).unwrap();
  const next = f.host
    .acceptDynamicGeometry(prepared, {
      world: f.world,
      fixedStep: f.world.getResource(FixedTime).tick,
    })
    .unwrap();
  const before = f.lifecycle.inspect();
  expect(f.host.retireSupersededDynamicGeometry?.(old, next)?.ok).toBe(true);
  expect(f.lifecycle.inspect()).toEqual(before);
  f.unconsumed();
  f.host.publishDynamicGeometry({ frameId: 3, deviceGeneration: 1 });
  expect(f.host.dynamicGeometryReceipt(old)).toBeDefined();
  expect(f.host.dynamicGeometryReceipt(next)).toBeUndefined();
  f.submitted();
  f.host.publishDynamicGeometry({ frameId: 4, deviceGeneration: 1 });
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
  expect(f.host.dynamicGeometryReceipt(old)).toBeUndefined();
  expect(f.host.dynamicGeometryReceipt(next)).toBeDefined();
  expect(f.host.isDynamicGeometryCurrent(next)).toBe(true);
  expect(f.destroyed()).toBe(false);
});

it('revalidates live material identity before a deferred retirement releases its old lease', async () => {
  const { f, old } = await publishedSameHandlePair('deferred-material');
  const materials = [...f.world.get(f.entity, MeshRenderer).unwrap().materials];
  const pending = f.host.prepareDynamicGeometry({
    ...f.input,
    revision: 3,
    materialIdentity: 'deferred-material',
  });
  await Promise.resolve();
  f.ready();
  const next = f.host
    .acceptDynamicGeometry((await pending).unwrap(), {
      world: f.world,
      fixedStep: f.world.getResource(FixedTime).tick,
    })
    .unwrap();
  expect(f.host.retireSupersededDynamicGeometry?.(old, next)?.ok).toBe(true);
  f.world.set(f.entity, MeshRenderer, { materials: [] }).unwrap();
  f.submitted();
  f.host.publishDynamicGeometry({ frameId: 3, deviceGeneration: 1 });
  expect(f.host.dynamicGeometryReceipt(old)).toBeDefined();
  f.world.set(f.entity, MeshRenderer, { materials }).unwrap();
  f.host.publishDynamicGeometry({ frameId: 4, deviceGeneration: 1 });
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
  expect(f.host.dynamicGeometryReceipt(old)).toBeUndefined();
  expect(f.host.isDynamicGeometryCurrent(next)).toBe(true);
});

async function acceptedReplacement(
  f: ReturnType<typeof fixture>,
  revision: number,
  changedHandle = false,
) {
  const mesh = changedHandle ? createBoxGeometry(3, 3, 3).unwrap() : f.input.mesh;
  const meshHandle = changedHandle
    ? runtimeAssetRegistry(f.world.assets).create(mesh).unwrap()
    : f.meshHandle;
  const pending = f.host.prepareDynamicGeometry({ ...f.input, meshHandle, revision });
  await Promise.resolve();
  f.ready();
  return f.host
    .acceptDynamicGeometry((await pending).unwrap(), {
      world: f.world,
      fixedStep: f.world.getResource(FixedTime).tick,
    })
    .unwrap();
}

it.each([
  false,
  true,
])('carries a registered retirement through exact unpublished replacement, changed handle %s', async (changedHandle) => {
  const { f, old } = await publishedSameHandlePair();
  const b = await acceptedReplacement(f, 3);
  expect(f.host.retireSupersededDynamicGeometry?.(old, b)?.ok).toBe(true);
  const c = await acceptedReplacement(f, 4, changedHandle);
  expect(f.host.isDynamicGeometryCurrent(b)).toBe(false);
  expect(f.host.dynamicGeometryReceipt(old)).toBeDefined();
  f.submitted();
  f.host.publishDynamicGeometry({ frameId: 3, deviceGeneration: 1 });
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
  expect(f.host.dynamicGeometryReceipt(old)).toBeUndefined();
  expect(f.host.dynamicGeometryReceipt(c)).toBeDefined();
  expect(f.host.isDynamicGeometryCurrent(c)).toBe(true);
});

it('keeps the original published lease when the carried unpublished successor is cancelled', async () => {
  const { f, old } = await publishedSameHandlePair();
  const b = await acceptedReplacement(f, 3);
  expect(f.host.retireSupersededDynamicGeometry?.(old, b)?.ok).toBe(true);
  const c = await acceptedReplacement(f, 4);
  f.host.cancelDynamicGeometry(c).unwrap();
  f.submitted();
  f.host.publishDynamicGeometry({ frameId: 3, deviceGeneration: 1 });
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
  expect(f.host.dynamicGeometryReceipt(old)).toBeDefined();
  expect(f.host.isDynamicGeometryCurrent(old)).toBe(true);
  expect(f.destroyed()).toBe(false);
});
