import { err, RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { GpuScene, type GpuSceneResourceFrame } from '../gpu-scene';
import { MaterialResource } from '../material-resource';
import { RenderScene } from '../scene/render-scene';
import { receiptRow } from './gpu-draw-selection-fixture';

it('keeps entity tables stable while distinct material versions are held by old frames', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const available = GpuScene.create(device, 4).unwrap();
  if (available.status !== 'available') throw Error('Missing scene');
  const gpu = available.scene;
  const scene = new RenderScene();
  const source = receiptRow().source;
  gpu
    .sync(
      scene.apply([{ kind: 'update', worldId: 0, entityKey: source.entityKey, snapshot: source }]),
    )
    .unwrap();
  const buffers = [gpu.primitiveBuffer, gpu.instanceBuffer, gpu.transformBuffer];
  const capacity = gpu.rowCapacity;
  const frames: GpuSceneResourceFrame[] = [];
  try {
    for (let index = 0; index < 8; index++) {
      const frame = gpu.captureResources().unwrap();
      frames.push(frame);
      const address = frame.indexForResource(source.material, source.material.snapshot);
      expect(address).toBeDefined();
      frame.seal().unwrap();
      source.material.adopt({ ...source.material.snapshot, roughness: (index + 1) / 10 });
      gpu.sync({ ...scene.apply([]), materialUpdates: [source.material] }).unwrap();
      expect(gpu.materialIndexForResource(source.material)).not.toBe(address);
      expect(gpu.rowCapacity).toBe(capacity);
      expect(gpu.primitiveBuffer).toBe(buffers[0]);
      expect(gpu.instanceBuffer).toBe(buffers[1]);
      expect(gpu.transformBuffer).toBe(buffers[2]);
    }
  } finally {
    for (const frame of frames) frame.release();
    gpu.dispose();
  }
});

it('balances repeated and reordered material bindings while a frame retains an old version', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const available = GpuScene.create(device, 32).unwrap();
  if (available.status !== 'available') throw Error('Missing scene');
  const gpu = available.scene,
    scene = new RenderScene();
  const source = receiptRow().source;
  const a = source.material;
  const b = new MaterialResource({ ...a.snapshot, roughness: 0.25 });
  const update = (materials: readonly MaterialResource[]) =>
    gpu
      .sync(
        scene.apply([
          {
            kind: 'update',
            worldId: 0,
            entityKey: source.entityKey,
            snapshot: {
              ...source,
              material: materials[0] ?? a,
              materials,
              materialBindingSources: materials.map(() => 'engine-default' as const),
            },
          },
        ]),
      )
      .unwrap();
  update([a, a]);
  const frame = gpu.captureResources().unwrap();
  const old = frame.indexForResource(a, a.snapshot);
  expect(old).toBeDefined();
  try {
    for (const materials of [[a], [a, a], [b, a], [a, b], [b, b], [b]]) {
      update(materials);
      for (const resource of materials)
        expect(gpu.materialIndexForResource(resource)).toBeDefined();
      expect(frame.indexForResource(a, a.snapshot)).toBe(old);
    }
    gpu.sync(scene.apply([{ kind: 'remove', worldId: 0, entityKey: source.entityKey }])).unwrap();
    expect(gpu.materialIndexForResource(a)).toBeUndefined();
    expect(gpu.materialIndexForResource(b)).toBeUndefined();
    expect(frame.indexForResource(a, a.snapshot)).toBe(old);
  } finally {
    frame.release();
    gpu.dispose();
  }
});

it('closes known resource demands before submission and refuses late latest-version lookups', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const created = GpuScene.create(device, 4).unwrap();
  if (created.status !== 'available') throw new Error('GPU Scene unavailable');
  const gpu = created.scene,
    scene = new RenderScene();
  const a = receiptRow().source,
    b = { ...receiptRow().source, entityKey: 43 };
  gpu
    .sync(
      scene.apply(
        [a, b].map((snapshot) => ({
          kind: 'update',
          worldId: 0,
          entityKey: snapshot.entityKey,
          snapshot,
        })),
      ),
    )
    .unwrap();
  const frame = gpu.captureResources().unwrap();
  try {
    const old = frame.indexForResource(a.material, a.material.snapshot);
    expect(old).toBeDefined();
    expect(() => frame.submit()).toThrow('Seal GPU scene resource reads');
    frame.seal().unwrap();
    a.material.adopt({ ...a.material.snapshot, roughness: 0.125 });
    gpu.sync({ ...scene.apply([]), materialUpdates: [a.material] }).unwrap();
    expect(gpu.materialIndexForResource(a.material)).not.toBe(old);
    expect(frame.indexForResource(a.material)).toBeUndefined();
    expect(frame.indexForResource(b.material)).toBeUndefined();
    expect(frame.indexForGeometry(0, 9)).toBeUndefined();
    frame.release();
    frame.release();
    expect(() => frame.seal()).toThrow('must be live');
  } finally {
    frame.release();
    gpu.dispose();
  }
});

it('pins one material version across edits and reuses released storage after completion', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const created = GpuScene.create(device, 128).unwrap();
  if (created.status !== 'available') throw new Error('GPU Scene unavailable');
  const gpu = created.scene;
  const scene = new RenderScene();
  const row = receiptRow().source;
  gpu
    .sync(scene.apply([{ kind: 'update', worldId: 0, entityKey: row.entityKey, snapshot: row }]))
    .unwrap();
  const material = row.material;
  const edit = (roughness: number) => {
    material.adopt({ ...material.snapshot, roughness });
    gpu.sync({ ...scene.apply([]), materialUpdates: [material] }).unwrap();
  };
  let complete: (() => void) | undefined;
  vi.spyOn(device.queue, 'onSubmittedWorkDone').mockImplementation(
    () =>
      new Promise<undefined>((resolve) => {
        complete = () => resolve(undefined);
      }),
  );
  try {
    const first = gpu.captureResources().unwrap();
    const address = first.indexForResource(material, material.snapshot);
    expect(address).toBeDefined();
    first.seal().unwrap();
    first.submit();
    edit(0.2);
    const current = gpu.materialIndexForResource(material);
    expect(current).not.toBe(address);
    const second = gpu.captureResources().unwrap();
    expect(second.indexForResource(material, material.snapshot)).toBe(current);
    edit(0.4);
    expect(gpu.materialIndexForResource(material)).not.toBe(current);
    const third = gpu.captureResources().unwrap();
    third.indexForResource(material, material.snapshot);
    complete?.();
    await Promise.resolve();
    edit(0.6);
    expect(gpu.materialIndexForResource(material)).toBe(address);
    second.release();
    third.release();
    const capacity = gpu.rowCapacity;
    for (let i = 0; i < 100; i++) {
      const frame = gpu.captureResources().unwrap();
      frame.indexForResource(material, material.snapshot);
      edit(i / 100);
      frame.release();
    }
    expect(gpu.rowCapacity).toBe(capacity);
    first.release(); // Idempotent after completion.
  } finally {
    gpu.dispose();
  }
});

it('holds replaced buffers until every prepared frame releases them and rejects excess retention', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const available = GpuScene.create(device, 4).unwrap();
  if (available.status !== 'available') throw new Error('GPU Scene unavailable');
  const gpu = available.scene;
  const scene = new RenderScene();
  const source = receiptRow().source;
  const destroy = vi.spyOn(device, 'destroyBuffer');
  gpu
    .sync(
      scene.apply([{ kind: 'update', worldId: 0, entityKey: source.entityKey, snapshot: source }]),
    )
    .unwrap();
  const frames = Array.from({ length: 128 }, () => gpu.captureResources().unwrap());
  expect(gpu.captureResources().ok).toBe(false);
  const retained = gpu.materialBuffer;
  frames[0]?.indexForResource(source.material, source.material.snapshot);
  source.material.adopt({
    ...source.material.snapshot,
    materialShaderId: 'test::large',
    materialParamSchema: Array.from({ length: 1024 }, (_, index) => ({
      name: `value${index}`,
      type: 'f32' as const,
    })),
  });
  gpu.sync({ ...scene.apply([]), materialUpdates: [source.material] }).unwrap();
  expect(gpu.materialBuffer).not.toBe(retained);
  await device.queue.onSubmittedWorkDone();
  expect(destroy).not.toHaveBeenCalledWith(retained);
  for (const frame of frames.slice(1)) frame.release();
  await device.queue.onSubmittedWorkDone();
  expect(destroy).not.toHaveBeenCalledWith(retained);
  frames[0]?.release();
  await device.queue.onSubmittedWorkDone();
  expect(destroy).toHaveBeenCalledWith(retained);
  const retry = gpu.captureResources().unwrap();
  retry.release();
  gpu.dispose();
  expect(destroy.mock.calls.filter(([buffer]) => buffer === retained)).toHaveLength(1);
});

it('recovers from failed material growth when the next edit has a different layout', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const available = GpuScene.create(device, 4).unwrap();
  if (available.status !== 'available') throw new Error('GPU Scene unavailable');
  const gpu = available.scene;
  const scene = new RenderScene();
  const source = receiptRow().source;
  gpu
    .sync(
      scene.apply([{ kind: 'update', worldId: 0, entityKey: source.entityKey, snapshot: source }]),
    )
    .unwrap();
  const held = gpu.captureResources().unwrap();
  const previous = held.indexForResource(source.material, source.material.snapshot);
  const create = device.createBuffer.bind(device);
  const failure = vi.spyOn(device, 'createBuffer');
  failure.mockImplementationOnce(() =>
    err(
      new RhiError({
        code: 'rhi-not-available',
        expected: 'injected capacity failure',
        hint: 'retry after capacity returns',
      }),
    ),
  );
  const edit = (fields: number) => {
    source.material.adopt({
      ...source.material.snapshot,
      materialShaderId: 'test::large',
      materialParamSchema: Array.from({ length: fields }, (_, index) => ({
        name: `value${index}`,
        type: 'f32' as const,
      })),
    });
    return gpu.sync({ ...scene.apply([]), materialUpdates: [source.material] });
  };
  try {
    expect(edit(1024).ok).toBe(false);
    expect(gpu.materialIndexForResource(source.material)).toBeUndefined();
    const failed = gpu.captureResources().unwrap();
    expect(failed.indexForResource(source.material, source.material.snapshot)).toBeUndefined();
    failed.release();
    failure.mockImplementation(create);
    expect(edit(128).ok).toBe(true);
    expect(gpu.materialIndexForResource(source.material)).toBeDefined();
    expect(gpu.materialIndexForResource(source.material)).not.toBe(previous);
  } finally {
    failure.mockRestore();
    held.release();
    gpu.dispose();
  }
});

it('rejects late first demands and pins a fresh accepted buffer generation', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const available = GpuScene.create(device, 4).unwrap();
  if (available.status !== 'available') throw new Error('GPU Scene unavailable');
  const gpu = available.scene;
  const scene = new RenderScene();
  const source = receiptRow().source;
  gpu
    .sync(
      scene.apply([{ kind: 'update', worldId: 0, entityKey: source.entityKey, snapshot: source }]),
    )
    .unwrap();
  let frame = gpu.captureResources().unwrap();
  const destroy = vi.spyOn(device, 'destroyBuffer');
  const edit = (fields: number) => {
    source.material.adopt({
      ...source.material.snapshot,
      materialShaderId: 'test::large',
      materialParamSchema: Array.from({ length: fields }, (_, index) => ({
        name: `value${index}`,
        type: 'f32' as const,
      })),
    });
    gpu.sync({ ...scene.apply([]), materialUpdates: [source.material] }).unwrap();
  };
  try {
    edit(1024);
    expect(frame.indexForResource(source.material, source.material.snapshot)).toBeUndefined();
    expect(frame.seal().ok).toBe(false);
    frame.release();
    frame = gpu.captureResources().unwrap();
    const acquired = gpu.materialBuffer;
    expect(frame.indexForResource(source.material, source.material.snapshot)).toBeDefined();
    frame.seal().unwrap();
    edit(4096);
    expect(gpu.materialBuffer).not.toBe(acquired);
    await device.queue.onSubmittedWorkDone();
    expect(destroy).not.toHaveBeenCalledWith(acquired);
    frame.release();
    await device.queue.onSubmittedWorkDone();
    expect(destroy).toHaveBeenCalledWith(acquired);
  } finally {
    frame.release();
    gpu.dispose();
  }
});
