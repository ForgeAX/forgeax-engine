import type { Result, RhiDevice } from '@forgeax/engine-rhi';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { ensureReady, rhi as wgpu } from '../../../rhi-wgpu/src/index';

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

const SIZE = 8;
const LAYERS = 4;
const colors = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 0],
] as const;

/**
 * Clear each 3D slice through one 3D view with `depthSlice`, and each array
 * layer through its own single-layer view, then read every layer back. A
 * backend that ignored `depthSlice` would leave slices 0-2 holding the last
 * clear (or zero) instead of their own color.
 */
async function probe(device: RhiDevice, shape: '3d' | '2d-array'): Promise<number[][]> {
  const texture = value(
    device.createTexture({
      size: [SIZE, SIZE, LAYERS],
      dimension: shape === '3d' ? '3d' : '2d',
      format: 'rgba8unorm',
      usage: 0x10 | 0x01,
    }),
  );
  const readback = value(device.createBuffer({ size: 256 * SIZE * LAYERS, usage: 0x09 }));
  try {
    const volumeView =
      shape === '3d' ? value(device.createTextureView(texture, { dimension: '3d' })) : undefined;
    const encoder = value(device.createCommandEncoder());
    colors.forEach(([r, g, b], layer) => {
      const view =
        volumeView ??
        value(
          device.createTextureView(texture, {
            dimension: '2d',
            baseArrayLayer: layer,
            arrayLayerCount: 1,
          }),
        );
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view,
            ...(shape === '3d' ? { depthSlice: layer } : {}),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [r / 255, g / 255, b / 255, 1],
          },
        ],
      });
      pass.end();
    });
    encoder.copyTextureToBuffer(
      { texture },
      { buffer: readback, bytesPerRow: 256, rowsPerImage: SIZE },
      [SIZE, SIZE, LAYERS],
    );
    value(device.queue.submit([value(encoder.finish())]));
    await device.queue.onSubmittedWorkDone();
    const mapped = value(await readback.mapAsync(1));
    const bytes = new Uint8Array(value(mapped.getMappedRange()).slice(0));
    mapped.unmap();
    return colors.map((_, layer) =>
      Array.from(bytes.slice(layer * 256 * SIZE, layer * 256 * SIZE + 4)),
    );
  } finally {
    value(device.destroyBuffer(readback));
    value(device.destroyTexture(texture));
  }
}

it('writes 3D depth slices and array layers through the WASM and native WebGPU RHI', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  document.body.append(canvas);
  try {
    await ensureReady();
    const backends = [
      value(await value(await wgpu.requestAdapter(undefined, canvas)).requestDevice()),
      value(await value(await webgpu.rhi.requestAdapter()).requestDevice()),
    ];
    for (const device of backends) {
      for (const shape of ['3d', '2d-array'] as const) {
        const layers = await probe(device, shape);
        expect(layers, `${device.caps.backendKind} ${shape}`).toEqual(
          colors.map(([r, g, b]) => [r, g, b, 255]),
        );
      }
    }
  } finally {
    canvas.remove();
  }
}, 60_000);
