import { readFileSync } from 'node:fs';
import { probeR32FloatRenderCapability } from '@forgeax/engine-rhi';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { beforeAll, expect, it } from 'vitest';
import {
  adaptExposure,
  autoExposureTarget,
  weightedLuminanceHistogram,
} from '../pipeline/standard-output/auto-exposure/oracle';
import type { DepthPyramidShaderSources } from '../render-contract';
import {
  runPortableExposure,
  runPortablePyramid,
  runUeExposureMeterFixture,
} from './portable-kernel-expansion-gpu';
import {
  runSsrGpuDispatch,
  type SsrProbeShaderSources,
  ssrPlanarCoordinateErrors,
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
        'forgeax_ssr::ray': read('ssr-ray'),
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
        'forgeax_ssr::ray': read('ssr-ray'),
        'forgeax_view::common': read('common'),
        'forgeax_pbr::gbuffer': read('standard-gbuffer'),
        forgeax_scene_temporal: read('scene-temporal'),
      },
    });
    if (!result.ok) throw result.error;
    return result.value.wgsl;
  };
  ssrSources = {
    ...sources,
    trace: await utility('ssr-trace', false),
    compose: await utility('ssr-compose', false),
    traceFragment: await utility('ssr-trace', true),
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

it.each([
  'compute',
  'fragment',
] as const)('adapts exposure in submit order before CPU completion on %s', async (execution) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const factory = (descriptor: GPUShaderModuleDescriptor) =>
    createShaderModuleImmediate(device, descriptor);
  const deltas = [1 / 120, 1 / 10, 1 / 240, 1 / 60];
  const exposure = await runPortableExposure(
    device,
    factory,
    execution,
    1,
    1,
    new Float32Array([1, 1, 1, 1]),
    deltas,
  );
  const target = autoExposureTarget(new Uint32Array(exposure.histogram), 0, [-8, 8], 1);
  let expected = 1;
  for (const [index, dt] of deltas.entries()) {
    expected = adaptExposure(expected, target, dt, 3, 1);
    expect(exposure.timeline[index]).toBeCloseTo(expected, 6);
  }
});

it.each([
  'compute',
  'fragment',
] as const)('adopts the first valid UE exposure and adapts subsequent frames on %s', async (execution) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const factory = (descriptor: GPUShaderModuleDescriptor) =>
    createShaderModuleImmediate(device, descriptor);
  const pixel = (value: number) => new Float32Array(4 * 4 * 4).fill(value);
  const dark = pixel(1 / 32);
  const bright = pixel(1 / 2);
  const near = pixel(1 / 24);
  const step = 1 / 60;
  const result = await runPortableExposure(
    device,
    factory,
    execution,
    4,
    4,
    bright,
    Array(6).fill(step),
    [
      undefined,
      { ue: true, pixels: pixel(0) },
      { ue: true, pixels: dark },
      { ue: true, pixels: bright },
      { ue: true, pixels: near },
      { ue: true, pixels: pixel(0) },
    ],
  );
  const target = (luminance: number) => {
    const position = ((Math.log2(luminance) + 10) * 63) / 30;
    const low = Math.floor(position);
    const lowerMass = 1 - (position - low);
    const keptUpper = 0.9 - Math.max(0.1, Math.min(lowerMass, 0.9));
    const averageLog = -10 + ((low + keptUpper / 0.8) * 30) / 63;
    return 0.18 * 2 ** -averageLog;
  };
  const adopted = target(1 / 32);
  const afterBrightEv = Math.log2(adopted) - 3 * step;
  // At the calibration step, the exponential weight reduces to rate * dt / 1.5.
  const afterNearEv =
    afterBrightEv + (Math.log2(target(1 / 24)) - afterBrightEv) * ((3 * step) / 1.5);
  expect(result.timeline[1]).toBe(1);
  expect(result.timeline[2]).toBeCloseTo(adopted, 5);
  expect(result.timeline[3]).toBeCloseTo(2 ** afterBrightEv, 5);
  expect(result.timeline[4]).toBeCloseTo(2 ** afterNearEv, 5);
  expect(result.timeline[5]).toBeCloseTo(2 ** afterNearEv, 5);
});

it.each([
  'compute',
  'fragment',
] as const)('uses UE histogram clipping with an unweighted meter on %s', async (execution) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const factory = (descriptor: GPUShaderModuleDescriptor) =>
    createShaderModuleImmediate(device, descriptor);
  const { maxBucketError, gainErrorEv } = await runUeExposureMeterFixture(
    device,
    factory,
    execution,
  );
  expect(maxBucketError).toBeLessThanOrEqual(32);
  expect(gainErrorEv).toBeLessThan(2e-6);
});

it('runs the full SSR graph for 60 completed frames with compute and raster spatial plans', async () => {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (
    await adapter.requestDevice({ requiredFeatures: ['depth32float-stencil8'] })
  ).unwrap();
  const native = await runSsrGpuDispatch(device, ssrSources, 60, { planarCoordinateSource: true });
  const raster = await runSsrGpuDispatch(device, ssrSources, 60, {
    execution: 'fragment',
    planarCoordinateSource: true,
  });
  expect(raster.pyramidPixels).toEqual(native.pyramidPixels);
  expect(raster.tracePixels).toEqual(native.tracePixels);
  expect(raster.pixels).toEqual(native.pixels);
  const errors = ssrPlanarCoordinateErrors(raster.tracePixels[0] ?? []);
  expect(errors.length).toBeGreaterThan(20);
  expect(Math.max(...errors)).toBeLessThan(0.02);
});

it.each([
  'compute',
  'fragment',
] as const)('preserves compact Deferred SSR trace and composition in %s', async (execution) => {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (
    await adapter.requestDevice({ requiredFeatures: ['depth32float-stencil8'] })
  ).unwrap();
  const shaders = {
    ...ssrSources,
    gbuffer: 'standard-gbuffer/2',
    compactGbuffer: 'standard-gbuffer/4',
  } as const;
  const full = await runSsrGpuDispatch(device, shaders, 3, {
    execution,
    gbuffer: 'full',
    coordinateSource: true,
  });
  const compact = await runSsrGpuDispatch(device, shaders, 3, {
    execution,
    gbuffer: 'compact',
    coordinateSource: true,
  });
  expect(compact.resourceNames).toContain('gbuffer-b');
  expect(compact.tracePixels).toEqual(full.tracePixels);
  expect(compact.composedPixels).toEqual(full.composedPixels);
  const trace = compact.tracePixels.at(-1) ?? [];
  expect(trace.filter((value, index) => index % 4 === 3 && value >= 0x3400).length).toBeGreaterThan(
    20,
  );
});

it('traces Water SSR with independent receiver inputs and switches to previous hit color', async () => {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (
    await adapter.requestDevice({ requiredFeatures: ['depth32float-stencil8'] })
  ).unwrap();
  const current = await runSsrGpuDispatch(device, ssrSources, 1, {
    waterTrace: 'current',
    coordinateSource: true,
  });
  const history = await runSsrGpuDispatch(device, ssrSources, 1, {
    waterTrace: 'history',
    coordinateSource: true,
  });
  const currentTrace = current.tracePixels[0] ?? [];
  const historyTrace = history.tracePixels[0] ?? [];
  let coloredHits = 0;
  for (let index = 0; index < currentTrace.length; index += 4) {
    if ((currentTrace[index + 3] ?? 0) === 0) continue;
    expect(historyTrace[index + 3]).toBe(currentTrace[index + 3]);
    expect(historyTrace[index]).toBe(historyTrace[index + 1]);
    expect(historyTrace[index]).toBe(historyTrace[index + 2]);
    if (currentTrace[index] !== currentTrace[index + 1]) coloredHits++;
  }
  expect(coloredHits).toBeGreaterThan(20);
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
