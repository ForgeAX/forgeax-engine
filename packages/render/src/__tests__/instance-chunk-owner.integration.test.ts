import { MemoryError } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import { RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { err, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { disposeInstanceBufferChunks, type InstanceBufferChunks } from '../instance-buffer-cache';
import { MaterialResource } from '../material-resource';
import { cleanPerFrameCaches } from '../record/fold-buckets';
import { instanceCollectionCacheKey } from '../record/frame-snapshot';
import {
  resolveGeometryInstanceBuffer,
  resolveStorageInstanceChunks,
} from '../record/main-pass-geometry';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import type { RenderableSnapshot } from '../render-system-extract';
import { renderWorldFor } from '../world/render-world';

async function fixture(storage = true) {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  if (!storage)
    Object.defineProperty(device, 'caps', {
      value: { ...device.caps, storageBuffer: false, compute: false },
    });
  const layout = device
    .createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 1, buffer: { type: storage ? 'read-only-storage' : 'uniform' } },
      ],
    })
    .unwrap();
  const owners: InstanceBufferChunks = new Map();
  const context = {
    runtime: {
      device,
      errorRegistry: {
        fire: (error: unknown) => {
          throw error;
        },
      },
    },
    pipelineState: { instancesBindGroupLayout: layout },
    frameState: {
      frameNumber: 1,
      instanceBufferChunks: owners,
      instancesBgShared: new WeakMap(),
      transientInstanceBuffers: [],
      instanceBuffers: new Map(),
      materialBgPerEntity: new Map(),
      instancesBgPerEntity: new Map(),
    },
    bindGroupCounts: { createBindGroup: 0, keys: [] },
  } as unknown as _InternalRenderPipelineContext;
  const makeRow = (worldId: number) => {
    const transforms = new Float32Array(32 * 16);
    for (let i = 0; i < 32; i++) {
      transforms[i * 16] = 1;
      transforms[i * 16 + 5] = 1;
      transforms[i * 16 + 10] = 1;
      transforms[i * 16 + 15] = 1;
      transforms[i * 16 + 12] = i;
    }
    const source = {
      worldId,
      entityKey: 7,
      instances: { cacheKey: 7, archVersion: 1, revision: 1, instanceCount: 32, transforms },
    } as unknown as RenderableSnapshot & {
      instances: NonNullable<RenderableSnapshot['instances']>;
    };
    return { source };
  };
  const resolve = (row: ReturnType<typeof makeRow>, capacity = 8) => {
    const draws = resolveStorageInstanceChunks(
      context,
      row as never,
      row.source.instances,
      capacity * 128,
      undefined,
      -1,
    );
    if (draws === null) throw Error('chunks unavailable');
    return draws;
  };
  return { context, device, makeRow, resolve, owners };
}

it.each([
  'initial',
  'replacement',
] as const)('rolls back a rejected %s LOD permutation upload before publishing cache ownership', async (mode) => {
  const { context, device, makeRow, owners } = await fixture(false);
  const material = new MaterialResource({
    passes: [],
    materialShaderId: 'forgeax::default-unlit',
    baseColor: vec3.create(1, 1, 1),
    metallic: 0,
    roughness: 1,
  });
  const base = makeRow(0);
  const entry = {
    ...base,
    source: { ...base.source, material, materials: [material] },
    mesh: { lodRanges: [[{ first: 0, count: 6, baseVertex: 0 }]] },
    cpuInstanceLods: [{ first: 0, count: 32, level: 0 }],
  };
  const resolve = () => resolveGeometryInstanceBuffer(context, entry as never, [], false);
  if (mode === 'replacement') resolve();
  const previous = [...owners.values()].flatMap((chunks) => [...chunks.values()]);
  Object.assign(entry.source.instances, { archVersion: 2 });
  const error = new RhiError({
    code: 'internal-error',
    expected: 'the instance upload succeeds',
    hint: 'injected queue failure',
  });
  const created = vi.spyOn(device, 'createBuffer');
  const destroyed = vi.spyOn(device, 'destroyBuffer');
  const write = vi.spyOn(device.queue, 'writeBuffer').mockReturnValueOnce(err(error));
  expect(() => resolve()).toThrow(error);
  const rejected = created.mock.results.at(-1)?.value;
  expect(rejected?.ok).toBe(true);
  if (!rejected?.ok) throw Error('missing rejected upload allocation');
  expect(destroyed).toHaveBeenCalledExactlyOnceWith(rejected.value);
  expect([...owners.values()].flatMap((chunks) => [...chunks.values()])).toEqual(previous);
  expect(previous.every((cached) => !cached.buffer.isDestroyed)).toBe(true);
  write.mockRestore();
  expect(resolve()).toHaveLength(1);
  expect(previous.every((cached) => cached.buffer.isDestroyed)).toBe(true);
  disposeInstanceBufferChunks(owners);
  expect(destroyed).toHaveBeenCalledTimes(mode === 'replacement' ? 3 : 2);
});

it('retains exact opaque LOD permutations across views without rewriting source or unchanged bytes', async () => {
  const { context, device, makeRow, owners } = await fixture(false);
  const base = makeRow(0);
  const material = new MaterialResource({
    passes: [],
    materialShaderId: 'forgeax::default-unlit',
    baseColor: vec3.create(1, 1, 1),
    metallic: 0,
    roughness: 1,
  });
  const entry = {
    ...base,
    source: { ...base.source, material, materials: [material] },
    mesh: {
      lodRanges: [[{ first: 0, count: 6, baseVertex: 0 }], [{ first: 6, count: 3, baseVertex: 0 }]],
    },
    cpuInstanceLods: Array.from({ length: 32 }, (_, first) => ({
      first,
      count: 1,
      level: first % 2,
    })),
  };
  const sourceBytes = entry.source.instances.transforms.slice();
  const payloads: Float32Array[] = [];
  const originalWrite = device.queue.writeBuffer.bind(device.queue);
  const write = vi
    .spyOn(device.queue, 'writeBuffer')
    .mockImplementation((buffer, offset, data, ...rest) => {
      if (data instanceof Float32Array) payloads.push(data.slice());
      return originalWrite(buffer, offset, data, ...rest);
    });
  const resolve = () => resolveGeometryInstanceBuffer(context, entry as never, [], false);
  const first = resolve();
  expect(first?.map((draw) => [draw.instanceCount, draw.lodLevel])).toEqual([
    [16, 0],
    [16, 1],
  ]);
  expect(
    payloads.map((values) => Array.from({ length: 16 }, (_, i) => values[i * 16 + 12])),
  ).toEqual([
    Array.from({ length: 16 }, (_, i) => i * 2),
    Array.from({ length: 16 }, (_, i) => i * 2 + 1),
  ]);
  expect(resolve()?.map((draw) => draw.instanceBuffer)).toEqual(
    first?.map((draw) => draw.instanceBuffer),
  );
  expect(write).toHaveBeenCalledTimes(2);
  entry.cpuInstanceLods = [
    { first: 0, count: 16, level: 0 },
    { first: 16, count: 16, level: 1 },
  ];
  const anotherView = resolve();
  expect(anotherView?.[0]?.instanceBuffer).not.toBe(first?.[0]?.instanceBuffer);
  expect(
    [...owners.values()]
      .flatMap((chunks) => [...chunks.values()])
      .every((entry) => !entry.buffer.isDestroyed),
  ).toBe(true);
  expect(entry.source.instances.transforms).toEqual(sourceBytes);
  expect(resolve()?.map((draw) => draw.instanceBuffer)).toEqual(
    anotherView?.map((draw) => draw.instanceBuffer),
  );
  expect(write).toHaveBeenCalledTimes(4);
  entry.source.instances.transforms[16 + 12] = 101;
  Object.assign(entry.source.instances, { revision: 2, dirtyRanges: [{ start: 1, end: 2 }] });
  resolve();
  expect(write).toHaveBeenCalledTimes(5);
  expect(payloads.at(-1)?.[16 + 12]).toBe(101);
  resolve();
  expect(write).toHaveBeenCalledTimes(5);
  // A skipped revision has no complete range proof and uploads both buckets.
  Object.assign(entry.source.instances, { revision: 4 });
  resolve();
  expect(write).toHaveBeenCalledTimes(7);
  // A blended use of this same collection retains source order and cannot retire
  // a differently mapped opaque view already encoded in the same frame.
  material.adopt({ ...material.snapshot, transparent: true });
  const blended = resolve();
  expect(blended).toHaveLength(1);
  expect(blended?.[0]?.lodLevel).toBeUndefined();
  expect(
    [...owners.values()]
      .flatMap((chunks) => [...chunks.values()])
      .every((entry) => !entry.buffer.isDestroyed),
  ).toBe(true);
  disposeInstanceBufferChunks(owners);
});

it('retains exact chunk bindings and uploads no unchanged instance bytes', async () => {
  const { device, makeRow, resolve, owners } = await fixture();
  const row = makeRow(0);
  const write = vi.spyOn(device.queue, 'writeBuffer');
  const first = resolve(row);
  expect(first.map((draw) => [draw.firstInstanceOrdinal, draw.instanceCount])).toEqual([
    [0, 8],
    [8, 8],
    [16, 8],
    [24, 8],
  ]);
  expect(write).toHaveBeenCalledTimes(4);
  const second = resolve(row);
  expect(second.map((draw) => draw.instanceBuffer)).toEqual(
    first.map((draw) => draw.instanceBuffer),
  );
  expect(second.map((draw) => draw.instanceBindGroup)).toEqual(
    first.map((draw) => draw.instanceBindGroup),
  );
  expect(write).toHaveBeenCalledTimes(4);
  disposeInstanceBufferChunks(owners);
});

it('replaces changed windows and retires stale chunks without visiting another World', async () => {
  const { context, device, makeRow, resolve, owners } = await fixture();
  const first = makeRow(0),
    second = makeRow(1);
  resolve(first);
  const retained = resolve(second);
  const ownerKey = instanceCollectionCacheKey(0, first.source.instances);
  const secondKey = instanceCollectionCacheKey(1, second.source.instances);
  const writes = vi.spyOn(device.queue, 'writeBuffer');
  resolve(first, 16);
  expect([...(owners.get(ownerKey)?.keys() ?? [])]).toEqual([0, 16]);
  expect(writes).toHaveBeenCalledTimes(2);
  expect(resolve(second).map((draw) => draw.instanceBuffer)).toEqual(
    retained.map((draw) => draw.instanceBuffer),
  );
  Reflect.set(first.source.instances, 'instanceCount', 8);
  Reflect.set(first.source.instances, 'revision', 2);
  resolve(first);
  expect([...(owners.get(ownerKey)?.keys() ?? [])]).toEqual([0]);
  expect(owners.get(secondKey)?.size).toBe(4);
  const destroyed = vi.spyOn(device, 'destroyBuffer');
  cleanPerFrameCaches(context.runtime as never, context.frameState, [second] as never);
  expect(owners.has(ownerKey)).toBe(false);
  expect(owners.get(secondKey)?.size).toBe(4);
  expect(destroyed).toHaveBeenCalledTimes(1);
  disposeInstanceBufferChunks(owners);
  expect(destroyed).toHaveBeenCalledTimes(5);
  expect(owners.size).toBe(0);
  disposeInstanceBufferChunks(owners);
  expect(destroyed).toHaveBeenCalledTimes(5);
});

it('uses the same collection ownership for chunked uniform fallback', async () => {
  const { context, device, makeRow, owners } = await fixture();
  Reflect.set(
    context.runtime,
    'device',
    new Proxy(device, {
      get(target, key) {
        if (key === 'caps') return { ...target.caps, storageBuffer: false };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  );
  Reflect.set(
    context.pipelineState,
    'instancesBindGroupLayout',
    device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 1, buffer: { type: 'uniform' } }],
      })
      .unwrap(),
  );
  const row = makeRow(0);
  Reflect.set(row.source.instances, 'instanceCount', 300);
  Reflect.set(row.source.instances, 'transforms', new Float32Array(300 * 16));
  const first = resolveGeometryInstanceBuffer(context, row as never, [], false);
  expect(first?.map((draw) => [draw.firstInstanceOrdinal, draw.instanceCount])).toEqual([
    [0, 128],
    [128, 128],
    [256, 44],
  ]);
  const second = resolveGeometryInstanceBuffer(context, row as never, [], false);
  expect(second?.map((draw) => draw.instanceBuffer)).toEqual(
    first?.map((draw) => draw.instanceBuffer),
  );
  const key = instanceCollectionCacheKey(0, row.source.instances);
  expect([...(owners.get(key)?.keys() ?? [])]).toEqual([0, 128, 256]);
  Reflect.set(row.source.instances, 'instanceCount', 160);
  Reflect.set(row.source.instances, 'revision', 2);
  expect(
    resolveGeometryInstanceBuffer(context, row as never, [], false)?.map(
      (draw) => draw.instanceCount,
    ),
  ).toEqual([128, 32]);
  expect([...(owners.get(key)?.keys() ?? [])]).toEqual([0, 128]);
  disposeInstanceBufferChunks(owners);
});

it('copies exact arena windows before upload return and reuses backing across changing revisions', async () => {
  const { context, device, makeRow, resolve } = await fixture();
  const world = renderWorldFor(context.runtime);
  const row = makeRow(0);
  const uploaded: Float32Array[] = [];
  const realWrite = device.queue.writeBuffer.bind(device.queue);
  vi.spyOn(device.queue, 'writeBuffer').mockImplementation((buffer, offset, data, start, size) => {
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    // Queue uploads consume the view synchronously. A retained spy must copy
    // its exact byte window, as the real WebGPU queue does.
    uploaded.push(new Float32Array(bytes.slice().buffer));
    return realWrite(buffer, offset, data, start, size);
  });
  resolve(row);
  const warmed = world.memoryStats().arena.backingAllocations;
  for (let revision = 2; revision < 8; revision++) {
    row.source.instances.transforms[12] = revision;
    Object.assign(row.source.instances, { revision });
    world
      .withFrameArena(() => {
        world.frameArena.alloc(Float32Array, 13).unwrap().fill(Number.NaN);
        resolve(row);
        return ok(undefined);
      })
      .unwrap();
  }
  expect(uploaded[0]?.[12]).toBe(0);
  expect(uploaded[0]?.[28]).toBe(0);
  expect(uploaded.at(-4)?.[12]).toBe(7);
  expect(world.memoryStats().arena.backingAllocations).toBe(warmed);
  expect(world.frameArena.isActive).toBe(false);
});

it('retries an instance upload after scratch admission fails without publishing its revision', async () => {
  const { context, device, makeRow, resolve } = await fixture();
  const world = renderWorldFor(context.runtime);
  const row = makeRow(0);
  const error = new MemoryError({ kind: 'budget', requestedBytes: 1024, limitBytes: 0 });
  const admission = vi.spyOn(world.frameArena, 'alloc').mockReturnValueOnce(err(error));
  const write = vi.spyOn(device.queue, 'writeBuffer');
  expect(() => resolve(row)).toThrow(error);
  expect(write).not.toHaveBeenCalled();
  expect(world.frameArena.isActive).toBe(false);
  admission.mockRestore();
  expect(resolve(row)).toHaveLength(4);
  expect(write).toHaveBeenCalledTimes(4);
});
