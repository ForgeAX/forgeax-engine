import type { RhiDevice, Texture } from '@forgeax/engine-rhi';
import { expect } from 'vitest';
import type { RenderPipelineFrame } from '../render-pipeline';
import { TSR_ANALYSIS_FORMATS, TSR_PARAMS_BYTES } from '../tsr/layout';
import { createTsrProgram, createTsrRasterProgram } from '../tsr/program';
import { half } from './tsr-feedback';

type Compile = NonNullable<
  RenderPipelineFrame['runtime']['immediateShaderModuleFactory']
>['createShaderModule'];

function decodeAaOffset(encodedByte: number): number {
  return encodedByte === 0 ? 0 : (encodedByte - 8) * (0.5 / 7);
}

/**
 * UE 5.8.1 TSRSpatialAntiAliasing.usf on a one pixel staircase: bright rows above y = 2 for x < 20
 * and above y = 3 from x = 20. The last pixel before each end of a straight run moves toward the
 * edge (ComputeDistanceToEdge, TSRSpatialAntiAliasing.ush:448-495: 0.5 - (len + 0.5) / (1 + lenN + lenP)
 * for a run that ends on one side only), pixels inside a run stay put, an unmasked pixel stays
 * put, and an isolated speck reports NoiseFiltering (ush:68-130) instead of an offset.
 */
export async function verifyTsrSpatial(
  device: RhiDevice,
  compile: Compile,
  execution: 'compute' | 'raster' = 'compute',
) {
  const width = 40,
    height = 6;
  const frame = {
    runtime: { device, immediateShaderModuleFactory: { createShaderModule: compile } },
  } as unknown as RenderPipelineFrame;
  const program =
    execution === 'compute'
      ? createTsrProgram(frame, 'spatial')
      : createTsrRasterProgram(frame, 'spatial');
  const textures: Texture[] = [];
  const surface = (format: 'rgba16float' | 'rgba8unorm') => {
    const texture = device
      .createTexture({
        size: { width, height },
        format,
        usage: 1 | 2 | 4 | (execution === 'compute' ? 8 : 16),
      })
      .unwrap();
    textures.push(texture);
    return { texture, view: device.createTextureView(texture, {}).unwrap(), format };
  };
  const scene = surface('rgba16float'),
    decision = surface(TSR_ANALYSIS_FORMATS.decision),
    spatial = surface(TSR_ANALYSIS_FORMATS.spatial);
  const upload = (
    target: { texture: Texture; format: 'rgba16float' | 'rgba8unorm' },
    pixel: (x: number, y: number) => number[],
  ) => {
    const raw = Array.from({ length: width * height }, (_, i) =>
      pixel(i % width, Math.floor(i / width)),
    );
    const data =
      target.format === 'rgba16float'
        ? new Uint16Array(raw.flatMap((p) => p.map(half)))
        : new Uint8Array(
            raw.flatMap((p) => p.map((v) => Math.max(0, Math.min(255, Math.round(v * 255))))),
          );
    device.queue
      .writeTexture(
        { texture: target.texture },
        data,
        { bytesPerRow: width * (target.format === 'rgba16float' ? 8 : 4), rowsPerImage: height },
        { width, height },
      )
      .unwrap();
  };
  const bright = (x: number, y: number) => y < (x < 20 ? 2 : 3);
  upload(scene, (x, y) => {
    // An isolated speck far from the staircase.
    if (x === 34 && y === 5) return [1, 1, 1, 1];
    return bright(x, y) ? [1, 1, 1, 1] : [0, 0, 0, 1];
  });
  // The reject stage masks everything except column 0, using UE rgba8unorm bitmask encoding (1/255).
  upload(decision, (x) => [0, 0, 0, x === 0 ? 0 : 1 / 255]);
  const params = device.createBuffer({ size: TSR_PARAMS_BYTES, usage: 64 | 8 }).unwrap();
  const paramFloats = new Float32Array(TSR_PARAMS_BYTES / 4);
  paramFloats[4] = width;
  paramFloats[5] = height;
  paramFloats[22] = 1;
  device.queue.writeBuffer(params, 0, new Uint8Array(paramFloats.buffer)).unwrap();
  const stride = 256;
  const readback = device.createBuffer({ size: stride * height, usage: 1 | 8 }).unwrap();
  try {
    const group = device
      .createBindGroup({
        layout: program.layout,
        entries: [
          { binding: 0, resource: { kind: 'textureView' as const, value: scene.view } },
          { binding: 1, resource: { kind: 'textureView' as const, value: decision.view } },
          { binding: 2, resource: { kind: 'sampler' as const, value: program.sampler } },
          { binding: 3, resource: { kind: 'buffer' as const, value: { buffer: params } } },
          ...(execution === 'compute'
            ? [{ binding: 4, resource: { kind: 'textureView' as const, value: spatial.view } }]
            : []),
        ],
      })
      .unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    if (execution === 'compute') {
      const pass = encoder.beginComputePass();
      pass.setPipeline(program.pipeline as ReturnType<typeof createTsrProgram>['pipeline']);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8), 1);
      pass.end();
    } else {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: spatial.view, loadOp: 'clear' as const, storeOp: 'store' as const },
        ],
      });
      pass.setPipeline(program.pipeline as ReturnType<typeof createTsrRasterProgram>['pipeline']);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
    }
    encoder.copyTextureToBuffer(
      { texture: spatial.texture },
      { buffer: readback, bytesPerRow: stride, rowsPerImage: height },
      { width, height },
    );
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await readback.mapAsync(1)).unwrap();
    const bytes = new Uint8Array(mapped.getMappedRange().unwrap().slice(0));
    mapped.unmap();
    const at = (x: number, y: number) => {
      const off = y * stride + x * 4;
      return [
        decodeAaOffset(bytes[off] ?? 0),
        decodeAaOffset(bytes[off + 1] ?? 0),
        (bytes[off + 2] ?? 0) / 255,
        (bytes[off + 3] ?? 0) / 255,
      ];
    };
    // Quantization is 1/14; the analytic distance is 0.5 - 0.5 / 9 = 0.444.
    expect(at(20, 2)[1] ?? Number.NaN).toBeCloseTo(0.43, 1);
    expect(at(19, 2)[1] ?? Number.NaN).toBeCloseTo(-0.43, 1);
    expect(at(20, 2)[0]).toBe(0);
    // Inside a straight run: no end on either side.
    expect(at(8, 1)[1]).toBe(0);
    expect(at(30, 2)[1]).toBe(0);
    // Flat regions and masked-out pixels report nothing.
    expect(at(10, 5)).toEqual([0, 0, 0, 0]);
    expect(at(0, 1)).toEqual([0, 0, 0, 0]);
    // A speck is noise: filtered by NoiseFiltering instead of moved.
    expect(at(34, 5)[2] ?? Number.NaN).toBeGreaterThan(0.5);
    expect(at(10, 5)[2]).toBe(0);
  } finally {
    await device.queue.onSubmittedWorkDone();
    for (const texture of textures) device.destroyTexture(texture).unwrap();
    device.destroyBuffer(params).unwrap();
    device.destroyBuffer(readback).unwrap();
  }
}
