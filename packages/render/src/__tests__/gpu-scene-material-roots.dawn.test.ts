import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import { expect, it } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { GpuScene, type GpuSceneMaterialRootHold } from '../gpu-scene';
import { GPU_MATERIAL_DESCRIPTOR } from '../gpu-scene-inputs';
import { GPU_SCENE_LAYOUTS } from '../gpu-scene-schema';
import { MaterialFrame } from '../scene/material-dispatch';
import { RenderScene } from '../scene/render-scene';
import { preparedSnapshot } from './gpu-driven-production-fixture';
import { nativeDeviceFixture } from './native-device-fixture';

async function readBuffer(device: RhiDevice, source: Buffer, offset: number, length: number) {
  const target = device.createBuffer({ size: length, usage: 1 | 8 }).unwrap();
  try {
    const encoder = device.createCommandEncoder().unwrap();
    encoder.copyBufferToBuffer(source, offset, target, 0, length);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    const mapping = (await target.mapAsync(1)).unwrap();
    try {
      return new Uint8Array(mapping.getMappedRange().unwrap().slice(0));
    } finally {
      mapping.unmap();
    }
  } finally {
    device.destroyBuffer(target);
  }
}

async function fixture() {
  const native = await nativeDeviceFixture();
  const available = GpuScene.create(native.device, 4).unwrap();
  if (available.status !== 'available') throw new Error('Missing native GPU Scene');
  const scene = available.scene,
    projection = new RenderScene();
  const first = preparedSnapshot(1, 1),
    second = preparedSnapshot(2, 2);
  const active = new MaterialFrame(undefined).with(first.material);
  const resident = active.with(second.material);
  scene
    .sync({
      ...projection.apply(
        [first, second].map((snapshot) => ({
          kind: 'update' as const,
          entityKey: snapshot.entityKey,
          snapshot,
        })),
      ),
      materials: resident,
    })
    .unwrap();
  const leases: GpuSceneMaterialRootHold[] = [];
  const hold = () => {
    const frame = scene.captureResources().unwrap();
    try {
      expect(frame.indexForResource(second.material, second.material.snapshot)).toBeDefined();
      frame.seal().unwrap();
      const held = scene.holdMaterialRoots(frame).unwrap();
      leases.push(held);
      return held;
    } finally {
      frame.release();
    }
  };
  const bytes = async () => {
    const frame = scene.captureResources().unwrap();
    try {
      const descriptor = frame.indexForResource(second.material, second.material.snapshot);
      if (descriptor === undefined) throw new Error('Missing retained material descriptor');
      const inputs = frame.inputReads().buffer().unwrap();
      frame.seal().unwrap();
      const header = await readBuffer(native.device, inputs.buffer, descriptor * 4, 16);
      const payload = new DataView(header.buffer).getUint32(
        GPU_MATERIAL_DESCRIPTOR.payload * 4,
        true,
      );
      return await readBuffer(
        native.device,
        scene.materialBuffer,
        payload * 16,
        GPU_SCENE_LAYOUTS.material.stride,
      );
    } finally {
      frame.release();
    }
  };
  const use = (materials: MaterialFrame) =>
    scene.sync({ ...projection.apply([]), materials }).unwrap();
  const close = () => {
    for (const held of leases) held.release();
    scene.dispose();
    native.native.destroy();
  };
  return { ...native, scene, projection, first, second, active, resident, hold, bytes, use, close };
}

it('keeps actual mapped native material bytes and descriptors through ordinary demand toggles', async () => {
  const f = await fixture();
  f.native.pushErrorScope('validation');
  try {
    const held = f.hold();
    const descriptor = f.scene.materialIndexForResource(f.second.material);
    const accepted = await f.bytes();
    for (let step = 0; step < 3; step++) {
      f.use(f.active);
      expect(held.isCurrent()).toBe(true);
      expect(f.scene.materialIndexForResource(f.second.material)).toBe(descriptor);
      expect(equalBytes(await f.bytes(), accepted)).toBe(true);
      f.first.material.adopt({ ...f.first.material.snapshot, roughness: (step + 1) / 4 });
      f.use(f.active.with(f.first.material));
      expect(held.isCurrent()).toBe(true);
      expect(equalBytes(await f.bytes(), accepted)).toBe(true);
      f.use(f.resident.with(f.first.material));
      expect(f.scene.materialIndexForResource(f.second.material)).toBe(descriptor);
    }
    f.use(f.active.with(f.first.material));
    held.release();
    expect(held.isCurrent()).toBe(false);
    expect(f.scene.materialIndexForResource(f.second.material)).toBeUndefined();
    expect(await f.native.popErrorScope()).toBeNull();
  } finally {
    f.close();
  }
}, 30000);

it('settles distinct holders without reviving disposed native allocations', async () => {
  const f = await fixture();
  f.native.pushErrorScope('validation');
  try {
    const first = f.hold(),
      second = f.hold();
    const descriptor = f.scene.materialIndexForResource(f.second.material);
    const accepted = await f.bytes();
    f.use(f.active);
    first.release();
    first.release();
    expect(second.isCurrent()).toBe(true);
    expect(f.scene.materialIndexForResource(f.second.material)).toBe(descriptor);
    expect(equalBytes(await f.bytes(), accepted)).toBe(true);
    f.scene.dispose();
    expect(second.isCurrent()).toBe(false);
    second.release();
    second.release();
    expect(f.scene.captureResources().ok).toBe(false);
    expect(await f.native.popErrorScope()).toBeNull();
  } finally {
    f.close();
  }
}, 30000);
