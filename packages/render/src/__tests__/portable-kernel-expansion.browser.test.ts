import { probeR32FloatRenderCapability } from '@forgeax/engine-rhi';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { readShaderManifestPublication } from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import * as wgpu from '../../../rhi-wgpu/src/index';
import { weightedLuminanceHistogram } from '../pipeline/standard-output/auto-exposure/oracle';
import { runPortableExposure, runPortablePyramid } from './portable-kernel-expansion-gpu';
import {
  runSsrGpuDispatch,
  type SsrShaderManifest,
  sourcesFromManifest,
  ssrCoordinateErrors,
} from './ssr-gpu-dispatch';

it.each([
  'webgpu',
  'wgpu-webgl2',
] as const)('qualifies Hi-Z, SSR and exact histogram exposure on %s raster execution', async (backend) => {
  const publication = await fetch('/shaders/manifest.json');
  expect(publication.ok).toBe(true);
  const manifest = (await readShaderManifestPublication(
    await publication.json(),
  )) as SsrShaderManifest;
  const find = (entry: string) => {
    const source = manifest.entries.find(({ wgsl }) => wgsl.includes(`fn ${entry}(`))?.wgsl;
    if (source === undefined) throw new Error(`missing published ${entry}`);
    return source;
  };
  const sources = {
    ...sourcesFromManifest(manifest),
    seedFragment: find('depth_pyramid_seed_fragment'),
    reduceFragment: find('depth_pyramid_reduce_fragment'),
    traceFragment: find('ssr_trace_fragment'),
    temporalFragment: find('ssr_temporal_fragment'),
    composeFragment: find('vs_ssr_compose_fragment'),
  };
  const pack = backend === 'webgpu' ? webgpu : wgpu;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 32;
  const saved = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  let adapter: import('@forgeax/engine-rhi').RhiAdapter;
  try {
    if (backend === 'wgpu-webgl2')
      Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
    adapter =
      backend === 'wgpu-webgl2'
        ? (await wgpu.rhi.requestAdapter({}, canvas)).unwrap()
        : (await webgpu.rhi.requestAdapter()).unwrap();
  } finally {
    if (backend === 'wgpu-webgl2') {
      if (saved === undefined) Reflect.deleteProperty(navigator, 'gpu');
      else Object.defineProperty(navigator, 'gpu', saved);
    }
  }
  const device = (
    await adapter.requestDevice({ requiredFeatures: ['depth32float-stencil8'] })
  ).unwrap();
  expect(device.caps.backendKind).toBe(backend);
  const factory = (descriptor: GPUShaderModuleDescriptor) =>
    pack.createShaderModuleImmediate(device, descriptor);
  const receipt = (await probeR32FloatRenderCapability(device, factory, 1)).unwrap();
  expect(receipt.readback?.values).toEqual([37.25]);
  for (const reduction of ['closest', 'furthest'] as const) {
    const pyramid = await runPortablePyramid(
      device,
      factory,
      sources,
      17,
      9,
      reduction,
      'fragment',
    );
    for (const [level, pixels] of pyramid.actual.entries()) {
      for (const [index, value] of pixels.entries()) {
        const expected = pyramid.expected[level]?.[index] ?? 0;
        expect(Math.abs(value - expected) / Math.max(1, expected)).toBeLessThan(1e-5);
      }
    }
  }
  const width = 257,
    height = 257;
  const exposure = await runPortableExposure(device, factory, 'fragment', width, height);
  const sampled: (readonly [number, number, number, number])[] = [];
  for (let y = 0; y < Math.ceil(height / 4); y++) {
    for (let x = 0; x < Math.ceil(width / 4); x++) {
      const pixel = (Math.min(y * 4 + 2, height - 1) * width + Math.min(x * 4 + 2, width - 1)) * 4;
      sampled.push([
        exposure.pixels[pixel] ?? 0,
        exposure.pixels[pixel + 1] ?? 0,
        exposure.pixels[pixel + 2] ?? 0,
        1,
      ]);
    }
  }
  expect(exposure.histogram).toEqual([...weightedLuminanceHistogram(sampled, [65, 65])]);
  for (const bin of [1, 64, 127, 128, 192, 255]) {
    const value = Math.fround(2 ** (-12 + (bin * 24) / 256));
    const edge = await runPortableExposure(
      device,
      factory,
      'fragment',
      1,
      1,
      new Float32Array([value, value, value, 1]),
    );
    expect(edge.histogram.reduce((a, b) => a + b, 0)).toBe(3);
    for (const [index, weight] of edge.histogram.entries())
      if (weight !== 0) expect([bin - 1, bin]).toContain(index);
    expect(Number.isFinite(edge.candidate[0])).toBe(true);
  }
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const invalid = await runPortableExposure(
      device,
      factory,
      'fragment',
      1,
      1,
      new Float32Array([value, value, value, 1]),
    );
    expect(invalid.histogram.every((count) => count === 0)).toBe(true);
    expect(invalid.candidate[0]).toBe(1);
  }
  const ssr = await runSsrGpuDispatch(
    device,
    sources,
    60,
    { execution: 'fragment', coordinateSource: true },
    pack.createShaderModuleImmediate,
  );
  const errors = ssrCoordinateErrors(ssr.tracePixels[0] ?? []);
  expect(errors.length).toBeGreaterThan(20);
  expect(Math.max(...errors)).toBeLessThan(0.02);
  // biome-ignore lint/suspicious/noConsole: preserve detached real-GPU qualification evidence.
  console.info(
    '[portable-kernel-evidence]',
    JSON.stringify({
      backend: device.caps.backendKind,
      frameCount: ssr.pixels.length,
      histogram: exposure.histogram,
      candidate: exposure.candidate,
      coordinateSamples: errors.length,
      maxCoordinateError: Math.max(...errors),
      passes: ssr.passNames,
    }),
  );
});
