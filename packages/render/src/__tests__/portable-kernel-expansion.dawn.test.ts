import { readFileSync } from 'node:fs';
import { probeR32FloatRenderCapability } from '@forgeax/engine-rhi';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { beforeAll, expect, it } from 'vitest';
import { weightedLuminanceHistogram } from '../pipeline/standard-output/auto-exposure/oracle';
import type { DepthPyramidShaderSources } from '../render-contract';
import { runPortableExposure, runPortablePyramid } from './portable-kernel-expansion-gpu';
import {
  runSsrGpuDispatch,
  type SsrProbeShaderSources,
  ssrCoordinateErrors,
} from './ssr-gpu-dispatch';

let sources: DepthPyramidShaderSources;
let ssrSources: SsrProbeShaderSources;
beforeAll(async () => {
  const compiler = await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  );
  const read = (name: string) =>
    readFileSync(new URL(`../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8');
  const compile = async (stage: 'seed' | 'reduce', fragment: boolean) => {
    const result = await compiler.compileShader(read(`depth-pyramid-${stage}`), {
      id: `portable-test-${stage}-${fragment}`,
      defines: { PORTABLE_FRAGMENT: fragment },
      imports: {
        'forgeax_depth_pyramid::sample': read('depth-pyramid-sample'),
        'forgeax_view::common': read('common'),
      },
    });
    if (!result.ok) throw result.error;
    return result.value.wgsl;
  };
  sources = {
    seed: await compile('seed', false),
    reduce: await compile('reduce', false),
    seedFragment: await compile('seed', true),
    reduceFragment: await compile('reduce', true),
  };
  const utility = async (name: string, fragment: boolean) => {
    const result = await compiler.compileShader(read(name), {
      id: `portable-test-${name}-${fragment}`,
      defines: { PORTABLE_FRAGMENT: fragment },
      imports: {
        'forgeax_depth_pyramid::sample': read('depth-pyramid-sample'),
        'forgeax_view::common': read('common'),
        'forgeax_pbr::gbuffer': read('standard-gbuffer'),
      },
    });
    if (!result.ok) throw result.error;
    return result.value.wgsl;
  };
  ssrSources = {
    ...sources,
    trace: await utility('ssr-trace', false),
    temporal: await utility('ssr-temporal', false),
    compose: await utility('ssr-compose', false),
    traceFragment: await utility('ssr-trace', true),
    temporalFragment: await utility('ssr-temporal', true),
    composeFragment: await utility('ssr-compose', true),
  };
});

it('qualifies raster R32F and compares every Hi-Z mip to independent odd-size and hole references', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const factory = (descriptor: GPUShaderModuleDescriptor) =>
    createShaderModuleImmediate(device, descriptor);
  const qualified = (await probeR32FloatRenderCapability(device, factory, 1)).unwrap();
  expect(qualified.readback?.values).toEqual([37.25]);
  for (const [width, height] of [
    [17, 9],
    [5, 3],
    [1, 7],
    [1, 1],
  ] as const) {
    for (const reduction of ['closest', 'furthest'] as const) {
      const compute = await runPortablePyramid(
        device,
        factory,
        sources,
        width,
        height,
        reduction,
        'compute',
      );
      const fragment = await runPortablePyramid(
        device,
        factory,
        sources,
        width,
        height,
        reduction,
        'fragment',
      );
      expect(fragment.actual).toEqual(compute.actual);
      for (const [level, actual] of fragment.actual.entries()) {
        const reference = fragment.expected[level];
        expect(actual.length).toBe(reference?.length);
        for (const [index, value] of actual.entries())
          expect(
            Math.abs(value - (reference?.[index] ?? 0)) / Math.max(1, reference?.[index] ?? 0),
          ).toBeLessThan(1e-5);
      }
    }
  }
});

it('keeps every weighted histogram bin exact across atomic and fragment plans, including multi-level reduction', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const factory = (descriptor: GPUShaderModuleDescriptor) =>
    createShaderModuleImmediate(device, descriptor);
  for (const [width, height] of [
    [1, 1],
    [17, 9],
    [257, 257],
  ] as const) {
    const compute = await runPortableExposure(device, factory, 'compute', width, height);
    const fragment = await runPortableExposure(device, factory, 'fragment', width, height);
    const sampled: (readonly [number, number, number, number])[] = [];
    for (let y = 0; y < Math.ceil(height / 4); y++) {
      for (let x = 0; x < Math.ceil(width / 4); x++) {
        const pixel =
          (Math.min(y * 4 + 2, height - 1) * width + Math.min(x * 4 + 2, width - 1)) * 4;
        sampled.push([
          fragment.pixels[pixel] ?? 0,
          fragment.pixels[pixel + 1] ?? 0,
          fragment.pixels[pixel + 2] ?? 0,
          1,
        ]);
      }
    }
    expect(fragment.histogram).toEqual([
      ...weightedLuminanceHistogram(sampled, [Math.ceil(width / 4), Math.ceil(height / 4)]),
    ]);
    expect(fragment.histogram).toEqual(compute.histogram);
    expect(fragment.candidate.slice(1)).toEqual([1, 7, 1]);
    expect(fragment.candidate[0]).toBeCloseTo(compute.candidate[0] ?? 0, 6);
  }
});

it('runs the full SSR graph for 60 completed frames with compute and raster trace/temporal plans', async () => {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (
    await adapter.requestDevice({ requiredFeatures: ['depth32float-stencil8'] })
  ).unwrap();
  const native = await runSsrGpuDispatch(device, ssrSources, 60, { coordinateSource: true });
  const raster = await runSsrGpuDispatch(device, ssrSources, 60, {
    execution: 'fragment',
    coordinateSource: true,
  });
  expect(raster.pyramidPixels).toEqual(native.pyramidPixels);
  expect(raster.tracePixels).toEqual(native.tracePixels);
  expect(raster.pixels).toEqual(native.pixels);
  const errors = ssrCoordinateErrors(raster.tracePixels[0] ?? []);
  expect(errors.length).toBeGreaterThan(20);
  expect(Math.max(...errors)).toBeLessThan(0.02);
});

// Freeze the f32 log2 boundary policy before executing the cases: all weight
// stays in the mathematical bin or its immediately lower neighbour. Non-edge
// fixtures above retain exact 256-bin equality across execution plans.
it('conserves exact weights at f32 bin boundaries and rejects invalid HDR samples', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const factory = (descriptor: GPUShaderModuleDescriptor) =>
    createShaderModuleImmediate(device, descriptor);
  for (const execution of ['compute', 'fragment'] as const) {
    for (const bin of [1, 64, 127, 128, 192, 255]) {
      const value = Math.fround(2 ** (-12 + (bin * 24) / 256));
      const result = await runPortableExposure(
        device,
        factory,
        execution,
        1,
        1,
        new Float32Array([value, value, value, 1]),
      );
      expect(result.histogram.reduce((a, b) => a + b, 0)).toBe(3);
      for (const [index, weight] of result.histogram.entries())
        if (weight !== 0) expect([bin - 1, bin]).toContain(index);
      expect(Number.isFinite(result.candidate[0])).toBe(true);
    }
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await runPortableExposure(
        device,
        factory,
        execution,
        1,
        1,
        new Float32Array([value, value, value, 1]),
      );
      expect(result.histogram.every((count) => count === 0)).toBe(true);
      expect(result.candidate[0]).toBe(1);
    }
  }
});
