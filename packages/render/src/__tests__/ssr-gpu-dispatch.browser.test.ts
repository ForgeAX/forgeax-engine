import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import { browserShaderEntries } from './browser-shader-entries.fixture';
import {
  admittedSsrSpatial,
  runSsrGpuDispatch,
  runSsrViewDistanceProbe,
  SSR_PROBE_SHADER_IDENTIFIERS,
  sourcesFromManifest,
  ssrPlanarCoordinateErrors,
} from './ssr-gpu-dispatch';

const confidence = (values: readonly number[]) => values.filter((_, i) => i % 4 === 3);

describe('SSR GPU dispatch Browser WebGPU probe', () => {
  let device: RhiDevice;
  let sources: ReturnType<typeof sourcesFromManifest>;
  beforeAll(async () => {
    expect(admittedSsrSpatial().status).toBe('admitted');
    sources = sourcesFromManifest({
      entries: await browserShaderEntries(SSR_PROBE_SHADER_IDENTIFIERS),
    });
    const adapter = (await rhi.requestAdapter()).unwrap();
    device = (
      await adapter.requestDevice({ requiredFeatures: ['depth32float-stencil8'] })
    ).unwrap();
  });

  // Independent cases identify the failing invariant. The 60-frame case
  // also includes cold software-driver compilation and completed readbacks;
  // its bounded 60-second execution allowance is not a frame-performance gate.
  it('reconstructs perspective and orthographic view distance', async () => {
    for (const distances of await runSsrViewDistanceProbe(device)) {
      expect(distances[0]).toBeCloseTo(6.58, 4);
      expect(distances[1]).toBeCloseTo(12, 4);
    }
  });

  it('executes 60 stable depth-pyramid, half-color, trace and composition frames with finite visible hits', async () => {
    const hit = await runSsrGpuDispatch(device, sources, 60, { halfHitColor: true });
    expect(hit.passNames).toContain('ssr-half-hit-color-downsample');
    expect(hit.passNames.filter((name) => name.startsWith('hzb-reduce'))).toHaveLength(1);
    expect(hit.passNames).toContain('hzb-seed');
    expect(hit.passNames).toContain('ssr-trace');
    expect(hit.passNames).not.toContain('ssr-temporal');
    expect(hit.passNames.filter((name) => name === 'ssr-compose')).toHaveLength(1);
    expect(hit.resourceNames.some((label) => label.startsWith('ssr-history'))).toBe(false);
    expect(hit.pixels).toHaveLength(60);
    expect(new Set(hit.pixels.map((pixel) => pixel.join(','))).size).toBe(1);
    expect(hit.pixel.some((value) => value !== 0)).toBe(true);
    const pyramid = hit.pyramidPixels[0] ?? [];
    // Derive both source columns of the first HZB texel from the inclined
    // receiver's plane equation. The pyramid keeps the greater distance.
    const distances = [0.5, 1.5].map((x) => 6 / (1 - (((x / 64) * 2 - 1) * 2) / Math.sqrt(3)));
    expect(pyramid[0]).toBeCloseTo(Math.max(...distances), 2);
    const trace = hit.tracePixels[0] ?? [];
    expect(confidence(trace).some((value) => value > 0)).toBe(true);
    expect(confidence(trace).filter((value) => value >= 0x3400).length).toBeGreaterThan(40);
    expect(confidence(trace).every((value) => value <= 0x3c00)).toBe(true);
  }, 60_000);

  it.each([
    { sourceBackFacing: true },
    { excludedSource: true },
  ])('reads rendered hit color independently of receiver-only inputs on the source (%j)', async (options) => {
    const reference = await runSsrGpuDispatch(device, sources);
    const result = await runSsrGpuDispatch(device, sources, 1, options);
    expect(confidence(reference.tracePixels[0] ?? []).some((value) => value > 0)).toBe(true);
    expect(result.tracePixels).toEqual(reference.tracePixels);
  });

  it.each([
    false,
    true,
  ])('preserves reflected coordinates for a flat source (half hit color: %s)', async (halfHitColor) => {
    const result = await runSsrGpuDispatch(device, sources, 1, {
      planarCoordinateSource: true,
      halfHitColor,
    });
    const errors = ssrPlanarCoordinateErrors(result.tracePixels[0] ?? []);
    expect(errors.length).toBeGreaterThan(10);
    expect(errors.filter((error) => error > 0.002).length / errors.length).toBeLessThan(0.05);
  });

  it('rejects excluded receiver material coverage', async () => {
    const result = await runSsrGpuDispatch(device, sources, 1, { excludedReceiver: true });
    expect(confidence(result.tracePixels[0] ?? []).every((value) => value === 0)).toBe(true);
  });

  it.each([
    { maxDistance: 0.01 },
    { enabled: false },
  ])('produces zero confidence for an unavailable ray (%j)', async (options) => {
    const result = await runSsrGpuDispatch(device, sources, 1, options);
    expect(confidence(result.tracePixels[0] ?? []).every((value) => value === 0)).toBe(true);
  });
});
