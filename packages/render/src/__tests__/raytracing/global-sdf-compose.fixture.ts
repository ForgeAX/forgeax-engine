import { buildMeshDistanceField } from '@forgeax/engine-geometry';
import type { Buffer } from '@forgeax/engine-rhi';
import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect } from 'vitest';
import {
  createGlobalSdfComposition,
  createGlobalSdfCompositionRecorder,
  GLOBAL_SDF_COMPOSE_WGSL,
  type GlobalSdfCompositionInputs,
} from '../../raytracing/global-sdf';
import { packSdfScene } from '../../raytracing/sdf-query';
import { readBuffer } from './path-tracer.fixture';
import { sdfCubeIndices, sdfCubePositions } from './sdf-cards.geometry';

/** The same admitted source uses an encoder helper and borrowed pass ranges.
 * GPU copies produce the padded inputs; no host copy edits their packed values. */
export async function verifyBorrowedGlobalSdfComposition(
  save?: (tape: Uint8Array, outputs: Readonly<Record<string, Uint8Array>>) => Promise<void>,
) {
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const native = webgpu._internal_getRawDevice(
    recorder.backend.unwrapDeviceForSurface(device).unwrap(),
  );
  assert(native);
  const errors: string[] = [];
  native.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const field = (
    await buildMeshDistanceField(sdfCubePositions, sdfCubeIndices, { resolution: 16 })
  ).unwrap();
  const source = [
    {
      instanceId: 7,
      geometryId: 9,
      mask: 255,
      field,
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    },
  ];
  const packed = packSdfScene(source, 1024).unwrap();
  const grid = {
    origin: [-2, -2, -2] as const,
    dimensions: [9, 9, 9] as const,
    spacing: 0.5,
    maxDistance: 2,
    coverageDistance: 0.25,
  };
  const reference = (
    await createGlobalSdfComposition(device, recorder.backend.createShaderModule, source, grid)
  ).unwrap();
  const count = reference.voxelCount;
  const offset = Math.max(
    256,
    device.limits.minStorageBufferOffsetAlignment,
    device.limits.minUniformBufferOffsetAlignment,
  );
  const sizes = {
    instances: packed.instances.byteLength,
    fields: packed.fields.byteLength,
    bounds: 48,
    settings: 48,
    voxels: count * 16,
  };
  const owned: Buffer[] = [];
  const make = (label: string, size: number) => {
    const bytes = new Uint8Array(offset + size + 256).fill(0xcd);
    bytes.fill(0, offset, offset + size);
    const buffer = device.createBuffer({ label, size: bytes.byteLength, usage: 0xcc }).unwrap();
    owned.push(buffer);
    device.queue.writeBuffer(buffer, 0, bytes).unwrap();
    return { buffer, offset, size };
  };
  const input = Object.fromEntries(
    Object.entries(sizes).map(([name, size]) => [name, make(`borrowed-compose.${name}`, size)]),
  ) as GlobalSdfCompositionInputs;
  const omitted = make('borrowed-compose.omitted-producer', count * 16);
  const observedOmission = make('borrowed-compose.observed-omission', count * 16);
  let tapeBytes: Uint8Array;
  let referenceBytes: Uint8Array;
  let borrowedBytes: Uint8Array;
  let omittedBytes: Uint8Array;
  try {
    const compose = createGlobalSdfCompositionRecorder(
      device,
      (
        await recorder.backend.createShaderModule(device, { code: GLOBAL_SDF_COMPOSE_WGSL })
      ).unwrap(),
    ).unwrap();
    const capture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    for (const name of ['instances', 'fields', 'bounds', 'settings'] as const)
      encoder.copyBufferToBuffer(
        reference.buffers[name],
        0,
        input[name].buffer,
        offset,
        sizes[name],
      );
    // An actual copy consumer retains the omitted producer in the tape. Unused
    // allocations are correctly absent from the recorder's frame closure.
    encoder.copyBufferToBuffer(omitted.buffer, offset, observedOmission.buffer, offset, count * 16);
    reference.record(encoder).unwrap();
    const pass = encoder.beginComputePass({ label: 'borrowed-compose.record' });
    compose.record(pass, input, count).unwrap();
    pass.end();
    // The omission control owns an identically initialized output but has no
    // composition dispatch. Its unwritten state must survive the same submit.
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    (await recorder.frameBoundary()).unwrap();
    tapeBytes = (await capture).unwrap().bytes;
    referenceBytes = await readBuffer(device, reference.buffers.voxels, count * 16);
    borrowedBytes = await readBuffer(device, input.voxels.buffer, offset + count * 16 + 256);
    omittedBytes = await readBuffer(device, omitted.buffer, offset + count * 16 + 256);
    expect(await readBuffer(device, observedOmission.buffer, offset + count * 16 + 256)).toEqual(
      omittedBytes,
    );
    await save?.(tapeBytes, {
      reference: referenceBytes,
      borrowed: borrowedBytes,
      omitted: omittedBytes,
    });
    expect(borrowedBytes.subarray(offset, offset + count * 16)).toEqual(referenceBytes);
    expect(omittedBytes.subarray(offset, offset + count * 16).every((value) => value === 0)).toBe(
      true,
    );
    expect(referenceBytes).not.toEqual(omittedBytes.subarray(offset, offset + count * 16));
    for (const bytes of [borrowedBytes, omittedBytes]) {
      expect(bytes.subarray(0, offset).every((value) => value === 0xcd)).toBe(true);
      expect(bytes.subarray(offset + count * 16).every((value) => value === 0xcd)).toBe(true);
    }
    const view = new DataView(
      referenceBytes.buffer,
      referenceBytes.byteOffset,
      referenceBytes.byteLength,
    );
    for (let index = 0; index < count; index++)
      expect(view.getUint32(index * 16 + 8, true)).toBe(1);
    expect(view.getFloat32(364 * 16, true)).toBeLessThan(0);
    expect(errors).toEqual([]);
  } finally {
    for (const buffer of owned) device.destroyBuffer(buffer).unwrap();
    reference.dispose();
    (await recorder.dispose()).unwrap();
    native.destroy();
  }
  const tape = decodeTape(tapeBytes).unwrap();
  const model = buildFrameModel(tape);
  const dispatches = model.works.filter((work) => work.kind === 'dispatchWorkgroups');
  expect(dispatches).toHaveLength(2);
  expect(model.commands.filter((command) => command.kind === 'copyBufferToBuffer')).toHaveLength(5);
  expect(model.unseededResources).toEqual([]);
  for (const binding of dispatches[1]?.bindings ?? []) {
    expect(binding.bufferOffset).toBe(offset);
    expect(binding.bufferSize).toBe(Object.values(sizes)[binding.binding]);
  }
  const fresh = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const freshNative = webgpu._internal_getRawDevice(fresh);
  assert(freshNative);
  freshNative.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const replay = (
    await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
  ).unwrap();
  try {
    for (const [index, work] of dispatches.entries()) {
      const resource = work.bindings.find((binding) => binding.binding === 4)?.resourceId;
      assert(resource);
      const initial = (await replay.readResource(resource)).unwrap().bytes;
      expect(
        initial
          .subarray(index === 0 ? 0 : offset, (index === 0 ? 0 : offset) + count * 16)
          .every((value) => value === 0),
      ).toBe(true);
      expect((await replay.readResourceAtWork(resource, work.workIndex)).unwrap().bytes).toEqual(
        index === 0 ? referenceBytes : borrowedBytes,
      );
    }
    const missing = model.resources.find((resource) => {
      const descriptor = resource.descriptor as {
        readonly desc?: { readonly label?: string };
      } | null;
      return descriptor?.desc?.label === 'borrowed-compose.omitted-producer';
    });
    assert(missing);
    expect(missing.consumers.filter((consumer) => consumer.workIndex !== null)).toEqual([]);
    const last = dispatches[1];
    assert(last);
    expect(
      (await replay.readResourceAtWork(missing.resourceId, last.workIndex)).unwrap().bytes,
    ).toEqual(omittedBytes);
  } finally {
    (await replay.dispose()).unwrap();
    freshNative.destroy();
  }
  expect(errors).toEqual([]);
  return {
    tape: tapeBytes,
    outputs: { reference: referenceBytes, borrowed: borrowedBytes, omitted: omittedBytes },
    summary: {
      voxelCount: count,
      offset,
      ranges: sizes,
      dispatches: dispatches.map((work) => ({
        workIndex: work.workIndex,
        eventIndex: work.eventIndex,
        bindings: work.bindings,
      })),
      copiedInputs: 4,
      omissionCopyConsumers: 1,
      completeVoxels: count,
      omittedStatus: 0,
      exactReplay: true,
      originalResourcesRetiredBeforeReplay: true,
    },
  };
}
