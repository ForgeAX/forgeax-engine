import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { disposeInstanceBufferChunks, type InstanceBufferChunks } from '../instance-buffer-cache';
import { cleanPerFrameCaches } from '../record/fold-buckets';
import { instanceCollectionCacheKey } from '../record/frame-snapshot';
import {
  resolveGeometryInstanceBuffer,
  resolveStorageInstanceChunks,
} from '../record/main-pass-geometry';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import type { RenderableSnapshot } from '../render-system-extract';

async function fixture() {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const layout = device
    .createBindGroupLayout({
      entries: [{ binding: 0, visibility: 1, buffer: { type: 'read-only-storage' } }],
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
