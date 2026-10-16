import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { readShaderManifestPublication } from '@forgeax/engine-shader';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  admittedSsrSpatial,
  runSsrGpuDispatch,
  runSsrViewDistanceProbe,
  type SsrShaderManifest,
  sourcesFromManifest,
  ssrCoordinateErrors,
} from './ssr-gpu-dispatch';
import { runSsrReprojectionProbe } from './ssr-reprojection-probe';

const confidence = (values: readonly number[]) => values.filter((_, i) => i % 4 === 3);

describe('SSR GPU dispatch Browser WebGPU probe', () => {
  let device: RhiDevice;
  let sources: ReturnType<typeof sourcesFromManifest>;
  beforeAll(async () => {
    expect(admittedSsrSpatial().status).toBe('admitted');
    const response = await fetch('/shaders/manifest.json');
    expect(response.ok).toBe(true);
    sources = sourcesFromManifest(
      (await readShaderManifestPublication(await response.json())) as SsrShaderManifest,
    );
    const adapter = (await rhi.requestAdapter()).unwrap();
    device = (
      await adapter.requestDevice({ requiredFeatures: ['depth32float-stencil8'] })
    ).unwrap();
  });

  // Independent cases identify the failing invariant. The 60-frame case
  // also includes cold software-driver compilation and completed readbacks;
  // its bounded 60-second execution allowance is not a frame-performance gate.
  it('reprojects history and reconstructs perspective and orthographic view distance', async () => {
    expect(await runSsrReprojectionProbe(device, sources.temporal)).toEqual([
      [0.5, 0.5, 0.375, 0.5625],
      [0.5, 0.5, 0.375, 0.5625],
      [0.5, 0.5, 0.375, 0.5625],
    ]);
    for (const distances of await runSsrViewDistanceProbe(device, sources.trace)) {
      expect(distances[0]).toBeCloseTo(6.58, 4);
      expect(distances[1]).toBeCloseTo(12, 4);
    }
  });

  it('executes 60 stable depth-pyramid, trace and temporal frames with finite visible hits', async () => {
    const hit = await runSsrGpuDispatch(device, sources, 60);
    expect(hit.passNames.filter((name) => name.startsWith('depth-pyramid-reduce'))).toHaveLength(1);
    expect(hit.passNames.filter((name) => name.startsWith('ssr-reflection-mip'))).toHaveLength(1);
    expect(hit.passNames).toContain('depth-pyramid-seed');
    expect(hit.passNames).toContain('ssr-trace');
    expect(hit.passNames).toContain('ssr-temporal');
    expect(hit.passNames.filter((name) => name === 'ssr-compose')).toHaveLength(1);
    expect(hit.resourceNames).toContain('ssr-resolved');
    expect(hit.pixels).toHaveLength(60);
    expect(new Set(hit.pixels.map((pixel) => pixel.join(','))).size).toBe(1);
    expect(hit.pixel.some((value) => value !== 0)).toBe(true);
    const pyramid = hit.pyramidPixels[0] ?? [];
    // Independently derive the view distance at the leftmost pixel of the
    // inclined receiver from its plane equation and real perspective ray.
    const dx = (((0.5 / 64) * 2 - 1) * 2) / Math.sqrt(3);
    expect(pyramid[0]).toBeCloseTo(6 / (1 - dx), 2);
    const trace = hit.tracePixels[0] ?? [];
    expect(confidence(trace).some((value) => value > 0)).toBe(true);
    expect(confidence(trace).filter((value) => value >= 0x3400).length).toBeGreaterThan(40);
    expect(confidence(trace).every((value) => value <= 0x3c00)).toBe(true);
  }, 60_000);

  it('rejects back-facing sources', async () => {
    const result = await runSsrGpuDispatch(device, sources, 1, { sourceBackFacing: true });
    expect(confidence(result.tracePixels[0] ?? []).every((value) => value === 0)).toBe(true);
  });

  it.each([
    false,
    true,
  ])('preserves reflected coordinates (recessed source: %s)', async (recessedSource) => {
    const result = await runSsrGpuDispatch(device, sources, 1, {
      coordinateSource: true,
      recessedSource,
    });
    const errors = ssrCoordinateErrors(result.tracePixels[0] ?? [], recessedSource);
    expect(errors.length).toBeGreaterThan(10);
    expect(errors.filter((error) => error > 0.002).length / errors.length).toBeLessThan(0.05);
  });

  it.each([
    { excludedSource: true },
    { excludedReceiver: true },
  ])('rejects excluded material coverage (%j)', async (options) => {
    const result = await runSsrGpuDispatch(device, sources, 1, options);
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
