import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import {
  type Buffer,
  type BufferDescriptor,
  ok,
  type RhiCommandEncoder,
} from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { type GpuDrivenOcclusionCamera, GpuDrivenView } from '../gpu-driven/view-gpu';
import { GpuScene } from '../gpu-scene';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import { updateGpuView } from './helpers/gpu-input-read-domain';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw Error('Missing byte-shim fixture resource');
  return value;
}

// Null neither stores uploads nor performs copies/maps. This explicit byte shim
// preserves real View.update, buffer descriptors, encoder ownership validation,
// queue submission and decoder. It proves plumbing, never hardware execution.
async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const bytes = new Map<Buffer, Uint8Array>();
  const descriptors = new Map<Buffer, BufferDescriptor>();
  const copies: {
    source: Buffer;
    destination: Buffer;
    sourceOffset: number;
    destinationOffset: number;
    size: number;
  }[] = [];
  const unmapped: Buffer[] = [];
  let beforeMap: (() => void | Promise<void>) | undefined;
  let unmapFailure: Error | undefined;
  let rangeFailure: Error | undefined;
  const createBuffer = device.createBuffer.bind(device);
  vi.spyOn(device, 'createBuffer').mockImplementation((desc) => {
    const result = createBuffer(desc);
    if (!result.ok) return result;
    const buffer = result.value;
    bytes.set(buffer, new Uint8Array(required(desc.size)));
    descriptors.set(buffer, desc);
    Object.defineProperty(buffer, 'mapAsync', {
      configurable: true,
      value: async (mode: number) => {
        expect(mode).toBe(GPU_BUFFER_USAGE_MAP_READ);
        await beforeMap?.();
        return ok({
          getMappedRange: () => {
            if (rangeFailure) throw rangeFailure;
            return ok(required(bytes.get(buffer)).slice().buffer);
          },
          unmap: () => {
            unmapped.push(buffer);
            if (unmapFailure) throw unmapFailure;
          },
        });
      },
    });
    return result;
  });
  const write = device.queue.writeBuffer.bind(device.queue);
  vi.spyOn(device.queue, 'writeBuffer').mockImplementation(
    (buffer, offset, data, dataOffset = 0, size) => {
      const uploaded = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      required(bytes.get(buffer)).set(
        uploaded.subarray(dataOffset, size === undefined ? undefined : dataOffset + size),
        offset,
      );
      return write(buffer, offset, data, dataOffset, size);
    },
  );
  const createEncoder = device.createCommandEncoder.bind(device);
  vi.spyOn(device, 'createCommandEncoder').mockImplementation((desc) => {
    const result = createEncoder(desc);
    if (!result.ok) return result;
    const encoder = result.value,
      copy = encoder.copyBufferToBuffer.bind(encoder);
    vi.spyOn(encoder, 'copyBufferToBuffer').mockImplementation(
      (
        source: Buffer,
        sourceOffsetOrDestination: number | Buffer,
        destinationOrSize?: Buffer | number,
        destinationOffset?: number,
        size?: number,
      ) => {
        // The observation uses the five-argument form. Preserve Null's actual
        // resource ledger validation before emulating its no-op byte transfer.
        const compact =
          typeof sourceOffsetOrDestination === 'object' && typeof destinationOrSize === 'number';
        const sourceOffset = compact ? 0 : sourceOffsetOrDestination;
        const destination = compact ? sourceOffsetOrDestination : destinationOrSize;
        destinationOffset = compact ? 0 : destinationOffset;
        size = compact ? destinationOrSize : size;
        if (
          typeof sourceOffset !== 'number' ||
          typeof destination !== 'object' ||
          destinationOffset === undefined ||
          size === undefined
        )
          throw Error('Expected valid three- or five-argument copy ranges');
        copy(source, sourceOffset, destination, destinationOffset, size);
        expect(
          (required(descriptors.get(source)).usage as number) & GPU_BUFFER_USAGE_COPY_SRC,
        ).not.toBe(0);
        expect(
          (required(descriptors.get(destination)).usage as number) & GPU_BUFFER_USAGE_COPY_DST,
        ).not.toBe(0);
        expect(sourceOffset + size).toBeLessThanOrEqual(required(bytes.get(source)).byteLength);
        expect(destinationOffset + size).toBeLessThanOrEqual(
          required(bytes.get(destination)).byteLength,
        );
        required(bytes.get(destination)).set(
          required(bytes.get(source)).subarray(sourceOffset, sourceOffset + size),
          destinationOffset,
        );
        copies.push({ source, destination, sourceOffset, destinationOffset, size });
      },
    );
    return result;
  });
  const scene = GpuScene.create(device, 1).unwrap();
  if (scene.status !== 'available') throw Error('Null scene unavailable');
  const topology = new BatchTopology();
  topology.rebuild([]);
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const view = GpuDrivenView.create({
    device,
    shaderModuleFactory: { createShaderModule: () => ok(shader) },
  }).unwrap();
  const planes = Float32Array.from({ length: 24 }, (_, i) => (i - 7) * 0.125);
  const update = (camera?: GpuDrivenOcclusionCamera) =>
    updateGpuView(
      view,
      topology.query(topology.sourcePlan(), undefined),
      scene.scene,
      planes,
      undefined,
      0,
      undefined,
      undefined,
      camera,
    ).unwrap();
  update();
  view.setTelemetrySubmit({ frameId: 7, deviceGeneration: 3 });
  const destroys = vi.spyOn(device, 'destroyBuffer');
  return {
    device,
    view,
    planes,
    update,
    copies,
    bytes,
    descriptors,
    unmapped,
    destroys,
    setBeforeMap: (fn: () => void | Promise<void>) => {
      beforeMap = fn;
    },
    setCleanupFailure: (error: Error) => {
      unmapFailure = error;
    },
    setRangeFailure: (error: Error) => {
      rangeFailure = error;
    },
    async close() {
      view.dispose();
      scene.scene.dispose();
      vi.restoreAllMocks();
    },
  };
}
const receipt = { frameId: 7, deviceGeneration: 3 };
it('decodes the actual uploaded view bytes from one bounded diagnostic copy', async () => {
  const f = await fixture();
  try {
    const result = await f.view.readGeometryCommands([], receipt);
    expect(result.commands).toEqual([]);
    expect(result.viewConstants).toEqual({
      scope: 'submitted-gpu-cull-view-constants',
      depthPyramid: 'unobserved',
      frustumPlanes: [...f.planes],
      occlusionEnabled: false,
      occlusionHistoryValid: false,
    });
    expect(f.copies).toHaveLength(4);
    const copy = required(f.copies[3]);
    expect(copy.sourceOffset).toBe(0);
    expect(copy.destinationOffset).toBe(f.copies.slice(0, 3).reduce((sum, c) => sum + c.size, 0));
    const source = required(f.descriptors.get(copy.source)),
      destination = required(f.descriptors.get(copy.destination));
    expect(source.usage).toBe(
      GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC,
    );
    expect(copy.size).toBe(source.size);
    expect(destination.size).toBe(copy.destinationOffset + copy.size);
    expect(destination.usage).toBe(GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST);
    expect(f.unmapped).toEqual([copy.destination]);
    expect(f.destroys.mock.calls.filter(([b]) => b === copy.destination)).toHaveLength(1);
  } finally {
    await f.close();
  }
});
it.each([
  { frameId: 8, deviceGeneration: 3 },
  { frameId: 7, deviceGeneration: 4 },
])('rejects wrong receipt before allocation or copy: %j', async (bad) => {
  const f = await fixture();
  try {
    const count = f.descriptors.size;
    await expect(f.view.readGeometryCommands([], bad)).rejects.toThrow('receipt-unavailable');
    expect(f.copies).toHaveLength(0);
    expect(f.descriptors.size).toBe(count);
    expect(f.unmapped).toHaveLength(0);
  } finally {
    await f.close();
  }
});
it.each([
  'same-plan-update',
  'same-value-new-submit',
  'dispose',
] as const)('fails closed when ownership changes during map: %s', async (change) => {
  const f = await fixture();
  try {
    const generation = f.view.currentResourceGeneration;
    f.setBeforeMap(() => {
      if (change === 'same-plan-update') {
        f.planes[0] = 77;
        f.update();
        expect(f.view.currentResourceGeneration).toBe(generation);
      } else if (change === 'same-value-new-submit') f.view.setTelemetrySubmit({ ...receipt });
      else f.view.dispose();
    });
    await expect(f.view.readGeometryCommands([], receipt)).rejects.toThrow('superseded');
    const destination = required(f.copies.at(-1)).destination;
    expect(f.unmapped).toEqual([destination]);
    expect(f.destroys.mock.calls.filter(([b]) => b === destination)).toHaveLength(1);
  } finally {
    await f.close();
  }
});
it('preserves the first mapped-range failure while attempting unmap and destroy', async () => {
  const f = await fixture();
  try {
    const primary = Error('original mapped-range failure');
    f.setRangeFailure(primary);
    f.setCleanupFailure(Error('unmap failure'));
    await expect(f.view.readGeometryCommands([], receipt)).rejects.toBe(primary);
    const destination = required(f.copies.at(-1)).destination;
    expect(f.unmapped).toEqual([destination]);
    expect(f.destroys.mock.calls.filter(([b]) => b === destination)).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it('copies actual late-graph enabled/history writes with the uploaded camera constants', async () => {
  const f = await fixture();
  const descriptor = {
    format: 'r32float',
    size: { width: 1, height: 1 },
    usage: 0x04 | 0x02,
    textureBindingViewDimension: undefined,
  } as const;
  const texture = f.device.createTexture(descriptor).unwrap(),
    pyramid = f.device.createTextureView(texture, {}).unwrap();
  try {
    const camera: GpuDrivenOcclusionCamera = {
      viewProjection: Float32Array.from({ length: 16 }, (_, i) => i * 0.25),
      near: 0.25,
      far: 512,
      orthographic: true,
      historyKey: 'one-owner',
    };
    const expected = [...camera.viewProjection];
    for (const history of [false, true]) {
      f.update(camera);
      f.view.setTelemetrySubmit({ ...receipt });
      const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
      const imported = graph.importTexture('owner-hzb', descriptor, () => texture).unwrap();
      const pyramidView = graph.importView(imported, {}, () => pyramid).unwrap();
      const resources = f.view
        .addPasses(graph, 'view-owner', true, undefined, undefined, true)
        .unwrap();
      if (!resources.addLateOcclusion) throw Error('Expected late graph owner');
      resources.addLateOcclusion(pyramidView).unwrap();
      const compiled = graph
        .compile({ device: f.device, surfaceSize: { width: 1, height: 1 } })
        .unwrap();
      const encoder = f.device.createCommandEncoder({ label: 'view-owner' }).unwrap();
      compiled.execute({ encoder }).unwrap();
      f.device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const decoded = await f.view.readGeometryCommands([], receipt);
      expect(decoded.viewConstants).toEqual({
        scope: 'submitted-gpu-cull-view-constants',
        depthPyramid: 'unobserved',
        frustumPlanes: [...f.planes],
        occlusionEnabled: true,
        occlusionHistoryValid: history,
        occlusionCamera: {
          viewProjection: expected,
          near: 0.25,
          far: 512,
          orthographic: true,
          footprintScale: 1,
        },
      });
    }
  } finally {
    f.device.destroyTexture(texture);
    await f.close();
  }
});

it('refuses a prior receipt after successful same-plan preparation before a new submit', async () => {
  const f = await fixture();
  try {
    const count = f.descriptors.size;
    f.update();
    await expect(f.view.readGeometryCommands([], receipt)).rejects.toThrow('receipt-unavailable');
    expect(f.descriptors.size).toBe(count);
    expect(f.copies).toHaveLength(0);
  } finally {
    await f.close();
  }
});
