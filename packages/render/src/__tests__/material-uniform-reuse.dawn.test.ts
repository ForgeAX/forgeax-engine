import { vec3 } from '@forgeax/engine-math';
import { expect, it, vi } from 'vitest';
import { MaterialResource } from '../material-resource';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { RenderFrameState } from '../record/frame-snapshot';
import type { PerSubmeshMaterialBgDeps } from '../record/main-pass-material';
import { materialUniformResources, prepareMaterialUniform } from '../record/material-uniforms';
import { MATERIAL_PER_ENTITY_STRIDE } from '../record/render-context';
import type { MaterialSnapshot } from '../render-system-extract';
import { nativeDeviceFixture } from './native-device-fixture';

it('preserves native uniform bytes through sparse edits, reordering and an intervening view', async () => {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  let scopeOpen = true;
  const size = MATERIAL_PER_ENTITY_STRIDE * 3;
  const buffer = device.createBuffer({ size, usage: 64 | 4 | 8 }).unwrap();
  const readback = device.createBuffer({ size, usage: 1 | 8 }).unwrap();
  const frameState = {} as RenderFrameState;
  const red: MaterialSnapshot = {
    passes: [],
    materialParamSchema: [
      { name: 'baseColor', type: 'vec4' },
      { name: 'roughness', type: 'f32' },
      { name: 'metallic', type: 'f32' },
    ],
    baseColor: vec3.create(1, 0, 0),
    metallic: 0,
    roughness: 0.5,
  };
  const root = new MaterialResource({ ...red, passes: [] });
  const green = { ...root.snapshot, baseColor: vec3.create(0, 1, 0) };
  const deps = {
    runtime: { device },
    frameState,
    pipelineState: { materialUniformBuffer: { buffer } },
  } as unknown as PerSubmeshMaterialBgDeps;
  const resources = materialUniformResources([]);
  const world = {} as RenderResourceScope;
  const write = vi.spyOn(device.queue, 'writeBuffer');
  const read = async () => {
    const encoder = device.createCommandEncoder().unwrap();
    encoder.copyBufferToBuffer(buffer, 0, readback, 0, size);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    const mapping = (await readback.mapAsync(1)).unwrap();
    const values = new Float32Array(mapping.getMappedRange().unwrap().slice(0));
    mapping.unmap();
    return [0, 1, 2].map((slot) =>
      Array.from(
        values.subarray(
          (slot * MATERIAL_PER_ENTITY_STRIDE) / 4,
          (slot * MATERIAL_PER_ENTITY_STRIDE) / 4 + 3,
        ),
      ),
    );
  };
  try {
    const old = root.snapshot;
    prepareMaterialUniform(deps, old, world, resources);
    expect((await read())[0]).toEqual([1, 0, 0]);
    for (let index = 0; index < 100; index++) prepareMaterialUniform(deps, old, world, resources);
    expect(write).toHaveBeenCalledTimes(1);
    root.adopt(green);
    prepareMaterialUniform(deps, root.snapshot, world, resources);
    expect((await read())[0]).toEqual([0, 1, 0]);
    prepareMaterialUniform(deps, old, world, resources);
    expect((await read())[0]).toEqual([1, 0, 0]);
    expect(write).toHaveBeenCalledTimes(3);
    expect(await native.popErrorScope()).toBeNull();
    scopeOpen = false;
  } finally {
    write.mockRestore();
    if (scopeOpen) await native.popErrorScope();
    device.destroyBuffer(buffer).unwrap();
    device.destroyBuffer(readback).unwrap();
    native.destroy();
  }
});
