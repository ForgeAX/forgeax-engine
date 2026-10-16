import { vec3 } from '@forgeax/engine-math';
import { expect, it, vi } from 'vitest';
import type { RenderFrameState } from '../record/frame-snapshot';
import { uploadMaterialUniforms } from '../record/material-uniforms';
import type { _InternalRenderPipelineContext } from '../record/render-context';
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
    materialParamSchema: [
      { name: 'baseColor', type: 'vec4' },
      { name: 'roughness', type: 'f32' },
      { name: 'metallic', type: 'f32' },
    ],
    baseColor: vec3.create(1, 0, 0),
    metallic: 0,
    roughness: 0.5,
  };
  const green: MaterialSnapshot = { ...red, baseColor: vec3.create(0, 1, 0) };
  const context = (materials: MaterialSnapshot[], state = frameState) =>
    ({
      runtime: { device },
      frameState: state,
      materialSlots: materials,
      materialSlotCount: materials.length,
      materialSlotOwners: materials.map((_, renderableIndex) => ({ renderableIndex })),
      validatedOrdered: [],
      pipelineState: { materialUniformBuffer: { buffer } },
    }) as unknown as _InternalRenderPipelineContext;
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
    uploadMaterialUniforms(context([red, red, red]));
    expect(await read()).toEqual([
      [1, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
    ]);
    uploadMaterialUniforms(context([red, red, red]));
    expect(write).toHaveBeenCalledTimes(1);
    uploadMaterialUniforms(context([red, green, red]));
    expect(write.mock.calls[1]?.[1]).toBe(MATERIAL_PER_ENTITY_STRIDE);
    expect(write.mock.calls[1]?.[4]).toBe(MATERIAL_PER_ENTITY_STRIDE);
    expect(await read()).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [1, 0, 0],
    ]);
    uploadMaterialUniforms(context([green, red, red]));
    expect(await read()).toEqual([
      [0, 1, 0],
      [1, 0, 0],
      [1, 0, 0],
    ]);
    uploadMaterialUniforms(context([green, green, green], {} as RenderFrameState));
    uploadMaterialUniforms(context([green, red, red]));
    expect(await read()).toEqual([
      [0, 1, 0],
      [1, 0, 0],
      [1, 0, 0],
    ]);
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
