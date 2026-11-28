import type { RhiDevice, Texture } from '@forgeax/engine-rhi';
import { expect } from 'vitest';
import type { RenderPipelineFrame } from '../render-pipeline';
import { TSR_PARAMS_BYTES } from '../tsr/layout';
import { createTsrProgram, createTsrRasterProgram } from '../tsr/program';
import { half, unhalf } from './tsr-feedback';

type Compile = NonNullable<
  RenderPipelineFrame['runtime']['immediateShaderModuleFactory']
>['createShaderModule'];

/**
 * UE 5.8.1 TSRMeasureFlickeringLuma.usf:62-65 on a ramp of scene colors:
 * GLuma = SMCSToGCS(dot(LinearToSMCS(c), kMoireSMCSWeights)) with SMCS(c) = (c / (c + 0.17))^2
 * (TSRColorSpace.ush:29-35) and kMoireSMCSWeights = 1/3 (ush:46-47). Written from the definition:
 * the SMCS mean is taken per channel and only then square-rooted back to the guide space.
 */
export async function verifyTsrFlickerLuma(
  device: RhiDevice,
  compile: Compile,
  execution: 'compute' | 'raster' = 'compute',
) {
  const width = 16;
  const height = 2;
  const frame = {
    runtime: { device, immediateShaderModuleFactory: { createShaderModule: compile } },
  } as unknown as RenderPipelineFrame;
  const program =
    execution === 'compute'
      ? createTsrProgram(frame, 'flickerLuma')
      : createTsrRasterProgram(frame, 'flickerLuma');
  const textures: Texture[] = [];
  const surface = () => {
    const texture = device
      .createTexture({
        size: { width, height },
        format: 'rgba16float',
        usage: 1 | 2 | 4 | (execution === 'compute' ? 8 : 16),
      })
      .unwrap();
    textures.push(texture);
    return { texture, view: device.createTextureView(texture, {}).unwrap() };
  };
  const scene = surface();
  const target = surface();
  const texel = (x: number, y: number): number[] =>
    y === 0 ? [x / 4, x / 4, x / 4, 1] : [unhalf(half(x * 0.5)), unhalf(half(x * 0.05)), 0, 1];
  const pixels = Array.from({ length: width * height }, (_, i) =>
    texel(i % width, Math.floor(i / width)).map((v) => unhalf(half(v))),
  );
  device.queue
    .writeTexture(
      { texture: scene.texture },
      new Uint16Array(pixels.flatMap((p) => p.map(half))),
      { bytesPerRow: width * 8, rowsPerImage: height },
      { width, height },
    )
    .unwrap();
  const params = device.createBuffer({ size: TSR_PARAMS_BYTES, usage: 64 | 8 }).unwrap();
  const values = new Float32Array(60);
  values[4] = width;
  values[5] = height;
  device.queue.writeBuffer(params, 0, new Uint8Array(values.buffer)).unwrap();
  const stride = 256;
  const readback = device.createBuffer({ size: stride * height, usage: 1 | 8 }).unwrap();
  try {
    const group = device
      .createBindGroup({
        layout: program.layout,
        entries: [
          { binding: 0, resource: { kind: 'textureView' as const, value: scene.view } },
          { binding: 1, resource: { kind: 'sampler' as const, value: program.sampler } },
          { binding: 2, resource: { kind: 'buffer' as const, value: { buffer: params } } },
          ...(execution === 'compute'
            ? [{ binding: 3, resource: { kind: 'textureView' as const, value: target.view } }]
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
          { view: target.view, loadOp: 'clear' as const, storeOp: 'store' as const },
        ],
      });
      pass.setPipeline(program.pipeline as ReturnType<typeof createTsrRasterProgram>['pipeline']);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
    }
    encoder.copyTextureToBuffer(
      { texture: target.texture },
      { buffer: readback, bytesPerRow: stride, rowsPerImage: height },
      { width, height },
    );
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await readback.mapAsync(1)).unwrap();
    const bytes = new Uint8Array(mapped.getMappedRange().unwrap().slice(0));
    mapped.unmap();
    const at = (x: number, y: number) =>
      Array.from(new Uint16Array(bytes.buffer, y * stride + x * 8, 4), unhalf);
    const smcs = (c: number) => (Math.max(0, c) / (Math.max(0, c) + 0.17)) ** 2;
    let worst = 0;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const c = pixels[y * width + x] as number[];
        const mean = (smcs(c[0] as number) + smcs(c[1] as number) + smcs(c[2] as number)) / 3;
        const want = Math.sqrt(mean);
        worst = Math.max(worst, Math.abs((at(x, y)[0] as number) - want));
      }
    // FP16 storage of a value in [0, 1] keeps the error below one part in a thousand.
    expect(worst).toBeLessThan(1e-3);
    // Black has no flicker luma and the luma grows monotonically with a gray ramp.
    expect(at(0, 0)[0]).toBe(0);
    for (let x = 1; x < width; x++)
      expect(at(x, 0)[0] as number).toBeGreaterThan(at(x - 1, 0)[0] as number);
    // A gray pixel equals its own GCS value, GCS(c) = c / (c + 0.17).
    expect(at(4, 0)[0] as number).toBeCloseTo(1 / (1 + 0.17), 2);
  } finally {
    await device.queue.onSubmittedWorkDone();
    for (const texture of textures) device.destroyTexture(texture).unwrap();
    device.destroyBuffer(params).unwrap();
    device.destroyBuffer(readback).unwrap();
  }
}
