import type { RhiDevice, Texture } from '@forgeax/engine-rhi';
import { expect } from 'vitest';
import type { RenderPipelineFrame } from '../render-pipeline';
import { TSR_PARAMS_BYTES } from '../tsr/layout';
import { createTsrProgram, createTsrRasterProgram } from '../tsr/program';
import { half, unhalf } from './tsr-feedback';

type Compile = NonNullable<
  RenderPipelineFrame['runtime']['immediateShaderModuleFactory']
>['createShaderModule'];

// UE TSRResolveHistory.usf:82-124 Mitchell-Netravali B = C = 1/3, written from the definition of
// the piecewise cubic rather than from the shader's expanded coefficients.
function mitchell(x: number): number {
  const B = 1 / 3;
  const C = 1 / 3;
  const d = Math.abs(x);
  if (d < 1)
    return ((12 - 9 * B - 6 * C) * d ** 3 + (-18 + 12 * B + 6 * C) * d ** 2 + (6 - 2 * B)) / 6;
  if (d < 2)
    return (
      ((-B - 6 * C) * d ** 3 +
        (6 * B + 30 * C) * d ** 2 +
        (-12 * B - 48 * C) * d +
        (8 * B + 24 * C)) /
      6
    );
  return 0;
}

/**
 * UE 5.8.1 TSRResolveHistory.usf reference path (usf:297-345) on a 2x history: each output pixel is
 * the 4x4 Mitchell-Netravali convolution of the history weighted by HdrWeight4
 * (TSRColorSpace.ush:166-174), clamped to the min/max of its sixteen taps and to 64512.
 */
export async function verifyTsrResolve(
  device: RhiDevice,
  compile: Compile,
  execution: 'compute' | 'raster' = 'compute',
) {
  const out = { width: 16, height: 8 };
  const history = { width: 32, height: 16 };
  const frame = {
    runtime: { device, immediateShaderModuleFactory: { createShaderModule: compile } },
  } as unknown as RenderPipelineFrame;
  const program =
    execution === 'compute'
      ? createTsrProgram(frame, 'resolve')
      : createTsrRasterProgram(frame, 'resolve');
  const textures: Texture[] = [];
  const surface = (size: { width: number; height: number }) => {
    const texture = device
      .createTexture({
        size,
        format: 'rgba16float',
        usage: 1 | 2 | 4 | (execution === 'compute' ? 8 : 16),
      })
      .unwrap();
    textures.push(texture);
    return { texture, view: device.createTextureView(texture, {}).unwrap() };
  };
  const source = surface(history);
  const target = surface(out);
  // A bright impulse at (9, 5), a hard vertical edge at x = 20 and an HDR-bright band from x = 28.
  const texel = (x: number, y: number): number[] => {
    if (x === 9 && y === 5) return [4, 4, 4, 1];
    if (x >= 28) return [64, 32, 16, 1];
    return x < 20 ? [0.5, 0.25, 0.125, 1] : [1, 1, 1, 1];
  };
  const pixels = Array.from({ length: history.width * history.height }, (_, i) =>
    texel(i % history.width, Math.floor(i / history.width)).map((v) => unhalf(half(v))),
  );
  device.queue
    .writeTexture(
      { texture: source.texture },
      new Uint16Array(pixels.flatMap((p) => p.map(half))),
      { bytesPerRow: history.width * 8, rowsPerImage: history.height },
      history,
    )
    .unwrap();
  const params = device.createBuffer({ size: TSR_PARAMS_BYTES, usage: 64 | 8 }).unwrap();
  const values = new Float32Array(60);
  values[14] = out.width;
  values[15] = out.height;
  values[22] = 1; // scene exposure of the HdrWeight
  device.queue.writeBuffer(params, 0, new Uint8Array(values.buffer)).unwrap();
  const stride = 256;
  const readback = device.createBuffer({ size: stride * out.height, usage: 1 | 8 }).unwrap();
  try {
    const group = device
      .createBindGroup({
        layout: program.layout,
        entries: [
          { binding: 0, resource: { kind: 'textureView' as const, value: source.view } },
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
      pass.dispatchWorkgroups(Math.ceil(out.width / 8), Math.ceil(out.height / 8), 1);
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
      { buffer: readback, bytesPerRow: stride, rowsPerImage: out.height },
      out,
    );
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await readback.mapAsync(1)).unwrap();
    const bytes = new Uint8Array(mapped.getMappedRange().unwrap().slice(0));
    mapped.unmap();
    const at = (x: number, y: number) =>
      Array.from(new Uint16Array(bytes.buffer, y * stride + x * 8, 4), unhalf);
    const expected = (x: number, y: number): number[] => {
      const px = (x + 0.5) * 2;
      const py = (y + 0.5) * 2;
      const left = Math.floor(px - 1.5) + 0.5;
      const top = Math.floor(py - 1.5) + 0.5;
      const sum = [0, 0, 0, 0];
      const low = [Infinity, Infinity, Infinity, Infinity];
      const high = [0, 0, 0, 0];
      let total = 0;
      for (let i = 0; i < 4; i++)
        for (let j = 0; j < 4; j++) {
          const sx = left + i;
          const sy = top + j;
          const c = pixels[
            Math.min(history.height - 1, Math.max(0, Math.floor(sy))) * history.width +
              Math.min(history.width - 1, Math.max(0, Math.floor(sx)))
          ] as number[];
          const w =
            mitchell(sx - px) *
            mitchell(sy - py) *
            Math.max(0.0001, 1 / (2 * (c[1] as number) + (c[0] as number) + (c[2] as number) + 4));
          for (let k = 0; k < 4; k++) {
            sum[k] = (sum[k] as number) + w * (c[k] as number);
            low[k] = Math.min(low[k] as number, c[k] as number);
            high[k] = Math.max(high[k] as number, c[k] as number);
          }
          total += w;
        }
      return sum.map((v, k) =>
        Math.min(
          64512,
          Math.max(0, Math.min(high[k] as number, Math.max(low[k] as number, v / total))),
        ),
      );
    };
    let worst = 0;
    for (let y = 0; y < out.height; y++)
      for (let x = 0; x < out.width; x++) {
        const want = expected(x, y);
        const got = at(x, y);
        for (let k = 0; k < 4; k++)
          worst = Math.max(
            worst,
            Math.abs((got[k] as number) - (want[k] as number)) /
              Math.max(1, Math.abs(want[k] as number)),
          );
      }
    expect(worst).toBeLessThan(2e-3);
    // A uniform region reproduces the history exactly, and an edge never overshoots its taps.
    expect(at(2, 2)).toEqual([0.5, 0.25, 0.125, 1]);
    for (let y = 0; y < out.height; y++) {
      const edge = at(10, y);
      for (let k = 0; k < 3; k++) {
        expect(edge[k] as number).toBeGreaterThanOrEqual(0.125 - 1e-3);
        expect(edge[k] as number).toBeLessThanOrEqual(1 + 1e-3);
      }
    }
    // The impulse spreads over the 4x4 kernel instead of being dropped or kept at full strength.
    expect(at(4, 2)[0] as number).toBeGreaterThan(0.6);
    expect(at(4, 2)[0] as number).toBeLessThan(4);
  } finally {
    await device.queue.onSubmittedWorkDone();
    for (const texture of textures) device.destroyTexture(texture).unwrap();
    device.destroyBuffer(params).unwrap();
    device.destroyBuffer(readback).unwrap();
  }
}
