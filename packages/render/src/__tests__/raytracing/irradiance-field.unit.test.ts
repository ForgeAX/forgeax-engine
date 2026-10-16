import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  IRRADIANCE_FIELD_FRAME_BYTES,
  IRRADIANCE_FIELD_RELOCATION,
  IRRADIANCE_FIELD_UNIFORM_BYTES,
  IrradianceFieldProbeState,
  irradianceFieldDepthClamp,
  irradianceFieldKernelWgsl,
  packIrradianceFieldFrame,
  packIrradianceFieldUniform,
} from '../../raytracing/irradiance-field';
import { planIrradianceField } from '../../raytracing/irradiance-field-plan';

const plan = planIrradianceField({
  region: {
    grid: {
      origin: [-4, -4, -4],
      dimensions: [33, 33, 33],
      spacing: 0.25,
      maxDistance: 2,
      coverageDistance: 1,
    },
    maxInstances: 64,
    maxFieldBytes: 16 * 1024 * 1024,
  },
  probeSpacing: 1,
  raysPerProbe: 64,
  probeBudget: 32,
  hysteresis: 0.9,
  cards: { resolution: 32, maxCaptureBytes: 8 * 1024 * 1024, budget: 64 },
  resolution: 'half',
  radiosity: true,
}).unwrap();

describe('irradiance field GPU layouts', () => {
  it('packs the sampling uniform as origin/spacing, dimensions/count, biases and level rows', () => {
    const bytes = packIrradianceFieldUniform(plan, [
      { window: [-3, 2, 5], min: [-2, 2, 5], max: [5, 10, 13] },
    ]);
    expect(bytes.byteLength).toBe(IRRADIANCE_FIELD_UNIFORM_BYTES);
    expect([...new Float32Array(bytes.buffer, 0, 4)]).toEqual([-3.75, -3.75, -3.75, 1]);
    expect([...new Uint32Array(bytes.buffer, 16, 4)]).toEqual([8, 8, 8, 512]);
    const bias = new Float32Array(bytes.buffer, 32, 4);
    expect(bias[0]).toBeCloseTo(0.25);
    expect(bias[1]).toBeCloseTo(0.1);
    expect(bias[2]).toBe(irradianceFieldDepthClamp(plan));
    expect(bias[3]).toBe(0);
    const words = new Int32Array(bytes.buffer);
    expect([...words.subarray(12, 14)]).toEqual([1, 512]);
    expect([...words.subarray(16, 19)]).toEqual([-3, 2, 5]);
    expect([...words.subarray(32, 35)]).toEqual([-2, 2, 5]);
    expect([...words.subarray(48, 51)]).toEqual([5, 10, 13]);
  });

  it('keeps the depth clamp beyond the farthest relocated trilinear corner', () => {
    expect(irradianceFieldDepthClamp(plan)).toBeGreaterThan(
      Math.sqrt(3) * (1 + IRRADIANCE_FIELD_RELOCATION.limit) * plan.spacing,
    );
  });

  it('packs the frame schedule at the offsets every kernel declares', () => {
    const query = new Uint8Array(8);
    new Uint32Array(query.buffer)[0] = 96;
    new Float32Array(query.buffer)[1] = 0.5;
    const bytes = packIrradianceFieldFrame({
      probeBudget: 32,
      raysPerProbe: 64,
      frameIndex: 7,
      tileOffset: 3,
      tileBudget: 5,
      tileCount: 12,
      lightCount: 2,
      atlasWidth: 128,
      cardResolution: 32,
      radiosity: true,
      environment: [0.25, 0.5, 0.75],
      hysteresis: 0.9,
      maxDistance: 100,
      surfaceBias: 0.05,
      depthClamp: 2,
      cardMargin: 0.125,
      gather: [64, 32, 32, 16],
      query,
      reflections: [12, 0.25],
    });
    expect(bytes.byteLength).toBe(IRRADIANCE_FIELD_FRAME_BYTES);
    const u = new Uint32Array(bytes.buffer);
    const f = new Float32Array(bytes.buffer);
    expect([...u.subarray(0, 12)]).toEqual([0, 32, 64, 7, 3, 5, 12, 2, 128, 32, 12, 1]);
    expect([...f.subarray(12, 16)]).toEqual([0.25, 0.5, 0.75, Math.fround(0.9)]);
    expect([...f.subarray(16, 20)]).toEqual([100, Math.fround(0.05), 2, 0.125]);
    expect([...u.subarray(20, 24)]).toEqual([64, 32, 32, 16]);
    expect(u[24]).toBe(96);
    expect(f[25]).toBe(0.5);
    expect([...f.subarray(26, 28)]).toEqual([12, 0.25]);
  });

  it('shares one Frame/Field declaration across every kernel', () => {
    const frame =
      'struct Frame { schedule: vec4u, cards: vec4u, atlas: vec4u, environment: vec4f, trace: vec4f, gather: vec4u, query: vec4u }';
    for (const traversal of ['global-sdf', 'ray-query'] as const)
      for (const source of Object.values(irradianceFieldKernelWgsl(traversal)))
        expect(source.split(frame).length).toBe(2);
  });

  it('keeps every kernel within the default eight storage buffers per stage', () => {
    for (const traversal of ['global-sdf', 'ray-query'] as const)
      for (const [stage, source] of Object.entries(irradianceFieldKernelWgsl(traversal)))
        expect(source.match(/var<storage,/g)?.length ?? 0, `${traversal}:${stage}`).toBeLessThan(9);
  });

  it('traces from the placed origins and shades only active, relocated probes', () => {
    const kernels = irradianceFieldKernelWgsl('global-sdf');
    expect(kernels.placeProbes).toContain('probeOrigins[i]=ProbeOrigin(origin,probe,updates)');
    expect(kernels.traceProbes).toContain('let origin=placed.position');
    expect(kernels.traceProbes).not.toContain('probeMeta');
    expect(kernels.updateProbes).toContain(`${IRRADIANCE_FIELD_RELOCATION.clearance}*spacing`);
    // A near-surface start that runs past its surface retraces one SDF voxel off it;
    // Ray Query has no sub-voxel blind band and never lifts.
    expect(kernels.traceProbes).toContain('hit=traceWorld(Ray(origin+surface.xyz*surface.w');
    expect(irradianceFieldKernelWgsl('ray-query').traceProbes).toContain(
      'fn probeSurface(p: vec3f) -> vec4f { return vec4f(0); }',
    );
    const sample = readFileSync(
      new URL('../../../../shader/src/ray-irradiance-field-sample.wgsl', import.meta.url),
      'utf8',
    );
    expect(sample).toContain(
      `const IRRADIANCE_FIELD_PROBE_ACTIVE = ${IrradianceFieldProbeState.active}u;`,
    );
    expect(sample).toContain('+ irradianceFieldProbeOffset(state)');
    // The relocated origin stays inside its own cell, so trilinear weights stay valid.
    expect(IRRADIANCE_FIELD_RELOCATION.limit).toBeLessThan(0.5);
    expect(IRRADIANCE_FIELD_RELOCATION.clearance).toBeLessThan(IRRADIANCE_FIELD_RELOCATION.limit);
  });
});
