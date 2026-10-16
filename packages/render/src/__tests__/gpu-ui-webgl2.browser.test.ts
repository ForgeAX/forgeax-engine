import type { UiGpuFrame, UiGpuPass } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createShaderModule, ensureReady, requestAdapter } from '../../../rhi-wgpu/src/index';
import { gpuShaders } from '../../../ui-blitz/src/gpu-shaders';
import { createGpuUiRaster } from '../assembly/gpu-ui-raster';

const packed = (...words: number[]) => new Uint8Array(new Uint32Array(words).buffer);
const pair = (x: number, y: number) => x | (y << 16);
const extent = pair(8, 8);
const zeroData = { width: 1, height: 1, data: new Uint8Array(16) };

function frame(passes: readonly UiGpuPass[], color: number): UiGpuFrame {
  return {
    version: 1,
    width: 8,
    height: 8,
    layerWidth: 8,
    layerHeight: 8,
    layerPages: [1, 0],
    scratch: false,
    alphas: zeroData,
    paints: zeroData,
    gradients: { width: 1, height: 1, data: new Uint8Array(4) },
    filterData: { width: 1, height: 1, data: packed(1, color, 0, 0) },
    images: [],
    passes,
  };
}

it('executes the shipped UI shaders through Naga GLSL300 and integer WebGL2 inputs', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 8;
  document.body.append(canvas);
  await ensureReady();
  const device = (
    await (await requestAdapter(undefined, canvas)).unwrap().requestDevice()
  ).unwrap();
  expect(device.caps.backendKind).toBe('wgpu-webgl2');
  expect(device.limits.maxVertexAttributes).toBeGreaterThanOrEqual(9);
  expect(device.limits.maxBindGroups).toBeGreaterThanOrEqual(4);
  expect(device.limits.maxSampledTexturesPerShaderStage).toBeGreaterThanOrEqual(5);
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('WebGL2 context unavailable');
  const sources: string[] = [];
  const shaderSource = gl.shaderSource;
  gl.shaderSource = function (shader, code) {
    sources.push(code);
    shaderSource.call(this, shader, code);
  };
  let raster: Awaited<ReturnType<typeof createGpuUiRaster>> | undefined;
  try {
    raster = await createGpuUiRaster({
      device,
      shaders: gpuShaders,
      createShaderModule: async (owner, code) =>
        (await createShaderModule(owner, { code })).unwrap(),
    });
    // All five production pipelines compile their vertex and fragment stages.
    expect(sources).toHaveLength(10);
    expect(sources.every((source) => source.startsWith('#version 300 es'))).toBe(true);
    expect(sources.some((source) => /flat\s+(?:in|out)\s+uint/.test(source))).toBe(true);
    expect(sources.some((source) => source.includes('usampler2D'))).toBe(true);

    const rgba = [32, 64, 128, 255];
    const color = 0xff804020;
    const clear = (target: number): UiGpuPass => ({
      kind: 'clear',
      target,
      instances: packed(1, 2, 3, 4, 8, 8, color),
    });
    const cases: {
      name: string;
      passes: UiGpuPass[];
      colored: (x: number, y: number) => boolean;
    }[] = [
      {
        name: 'flat clear color',
        passes: [clear(0)],
        colored: (x, y) => x >= 1 && x < 4 && y >= 2 && y < 6,
      },
      {
        name: 'sampled copy',
        passes: [
          clear(2),
          {
            kind: 'copy',
            target: 0,
            source: 2,
            instances: packed(pair(2, 1), pair(1, 2), pair(3, 4), extent),
          },
        ],
        colored: (x, y) => x >= 2 && x < 5 && y >= 1 && y < 5,
      },
      {
        name: 'nine integer attributes and uint filter data',
        passes: [
          {
            kind: 'filter',
            target: 0,
            source: 2,
            instances: packed(0, extent, 0, extent, extent, 0, 0, extent, 1),
          },
        ],
        colored: () => true,
      },
    ];
    for (const scene of cases) {
      raster.prepare(frame(scene.passes, color));
      const output = raster.texture;
      if (!output) throw new Error('UI raster did not allocate its output');
      const staging = device.createBuffer({ size: 256 * 8, usage: 0x01 | 0x08 }).unwrap();
      try {
        const encoder = device.createCommandEncoder().unwrap();
        raster.encode(encoder);
        encoder.copyTextureToBuffer(
          { texture: output },
          { buffer: staging, bytesPerRow: 256, rowsPerImage: 8 },
          { width: 8, height: 8, depthOrArrayLayers: 1 },
        );
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        const completed = device.queue.onSubmittedWorkDone();
        raster.submitted(completed);
        const mapped = (await staging.mapAsync(1)).unwrap();
        try {
          const bytes = new Uint8Array(mapped.getMappedRange().unwrap());
          for (let y = 0; y < 8; y++)
            for (let x = 0; x < 8; x++)
              expect([...bytes.subarray(y * 256 + x * 4, y * 256 + x * 4 + 4)], scene.name).toEqual(
                scene.colored(x, y) ? rgba : [0, 0, 0, 0],
              );
        } finally {
          mapped.unmap();
        }
        await completed;
        expect(gl.getError(), scene.name).toBe(gl.NO_ERROR);
      } finally {
        device.destroyBuffer(staging).unwrap();
      }
    }
  } finally {
    raster?.dispose();
    gl.shaderSource = shaderSource;
    canvas.remove();
  }
}, 30_000);
