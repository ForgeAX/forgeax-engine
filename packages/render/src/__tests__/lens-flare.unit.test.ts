import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { Camera } from '../components';
import { LENS_FLARE_GHOST_COUNT, LensFlare, resolveLensFlare } from '../components/lens-flare';
import { createRenderFeatureHost, runRenderFeatureFrame } from '../features/host';
import {
  createLensFlareRenderFeature,
  LENS_FLARE_PARAMS_BYTES,
  LENS_FLARE_PROGRAMS,
  packLensFlareParams,
} from '../features/lens-flare';
import { lensFlareGuardBandSize } from '../features/lens-flare-graph';
import {
  createStandardOutputPlan,
  validateStandardOutputPlan,
} from '../pipeline/standard-output/graph';
import { extractCameraSnapshots } from '../render-system-extract';
import { setActiveCamera } from '../systems/active-camera';

function fixture() {
  const world = new World();
  const camera = world
    .spawn(
      { component: Transform, data: {} },
      { component: Camera, data: {} },
      { component: LensFlare, data: {} },
    )
    .unwrap();
  return { world, camera, data: () => world.get(camera, LensFlare).unwrap() };
}

describe('camera LensFlare', () => {
  it('extracts detached Unreal defaults for the active camera only', () => {
    const { world, camera } = fixture();
    const other = world
      .spawn({ component: Transform, data: {} }, { component: Camera, data: {} })
      .unwrap();
    setActiveCamera(world, camera);
    const snapshot = extractCameraSnapshots(world)[0]?.lensFlare;
    expect(snapshot).toMatchObject({ intensity: 1, threshold: 8, bokehSize: 3, tint: [1, 1, 1] });
    expect(snapshot?.ghostTints).toHaveLength(LENS_FLARE_GHOST_COUNT * 3);
    // Unreal places a ghost of alpha a at viewport scale 7a - 3.5.
    expect(snapshot?.ghostScales[0]).toBeCloseTo(0.6 * 7 - 3.5, 5);
    expect(snapshot?.ghostScales[7]).toBeCloseTo(0.15 * 7 - 3.5, 5);
    world.set(camera, LensFlare, { tint: [0, 1, 0] }).unwrap();
    expect(snapshot?.tint).toEqual([1, 1, 1]);
    expect(structuredClone(snapshot)).toEqual(snapshot);
    setActiveCamera(world, other);
    expect(extractCameraSnapshots(world)[0]?.lensFlare).toBeUndefined();
    world.removeComponent(camera, LensFlare).unwrap();
    setActiveCamera(world, camera);
    expect(extractCameraSnapshots(world)[0]?.lensFlare).toBeUndefined();
  });

  it('admits no work at zero intensity, zero tint or with every ghost disabled', () => {
    const { data } = fixture();
    expect(resolveLensFlare({ ...data(), intensity: 0 })).toEqual({ ok: true, value: undefined });
    expect(resolveLensFlare({ ...data(), tint: new Float32Array(3) })).toEqual({
      ok: true,
      value: undefined,
    });
    expect(
      resolveLensFlare({ ...data(), ghostScales: new Float32Array(LENS_FLARE_GHOST_COUNT) }),
    ).toEqual({ ok: true, value: undefined });
    expect(
      resolveLensFlare({ ...data(), ghostTints: new Float32Array(LENS_FLARE_GHOST_COUNT * 3) }),
    ).toEqual({ ok: true, value: undefined });
  });

  it.each([
    ['intensity', -0.01],
    ['intensity', 65],
    ['threshold', -1],
    ['threshold', 70000],
    ['bokehSize', 0],
    ['bokehSize', 11],
  ] as const)('rejects %s=%s before graph admission', (field, value) => {
    const { data } = fixture();
    for (const invalid of [value, NaN, Infinity]) {
      const result = resolveLensFlare({ ...data(), [field]: invalid });
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error).toMatchObject({
          code: 'lens-flare-invalid-parameter',
          detail: { field, value: invalid },
        });
    }
  });

  it.each([
    ['tint', 3, 65],
    ['ghostTints', 24, -1],
    ['ghostScales', 8, 9],
  ] as const)('rejects out-of-range and non-finite %s elements', (field, length, value) => {
    const { data } = fixture();
    for (const invalid of [value, NaN, -Infinity]) {
      const array = new Float32Array(length).fill(1);
      array[length - 1] = invalid;
      const result = resolveLensFlare({ ...data(), [field]: array });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.detail).toMatchObject({ field, value: invalid });
    }
  });

  it('creates no resources for disabled cameras and packs one shared parameter layout', () => {
    const host = createRenderFeatureHost([createLensFlareRenderFeature()]).unwrap();
    try {
      const frame = runRenderFeatureFrame(host, [
        {
          identity: 'main',
          render: true,
          worlds: [new World()],
          owner: 0,
          frameNumber: 1,
          caps: { rgba16floatRenderable: true } as never,
        },
      ]).frame;
      expect(frame.errors).toEqual([]);
      expect(frame.plans).toEqual([]);
      expect(frame.fullscreenEffects.size).toBe(0);
    } finally {
      host.dispose();
    }
    const { data } = fixture();
    const snapshot = resolveLensFlare({
      ...data(),
      intensity: 2,
      tint: new Float32Array([1, 0.5, 0.25]),
    });
    if (!snapshot.ok || snapshot.value === undefined) throw new Error('expected a snapshot');
    const packed = new Float32Array(packLensFlareParams(snapshot.value).buffer);
    expect(packed.byteLength).toBe(LENS_FLARE_PARAMS_BYTES);
    expect(Array.from(packed.subarray(0, 8))).toEqual(
      [8, 0.03, 0, 0, 2, 1, 0.5, 0].map(Math.fround),
    );
    expect(packed[8 + 3]).toBeCloseTo(snapshot.value.ghostScales[0] ?? NaN, 6);
    expect(
      Array.from(new Float32Array(packLensFlareParams(undefined).buffer).subarray(4, 7)),
    ).toEqual([0, 0, 0]);
    for (const program of LENS_FLARE_PROGRAMS)
      expect(program.params?.byteSize).toBe(LENS_FLARE_PARAMS_BYTES);
    expect(lensFlareGuardBandSize({ width: 1921, height: 1 })).toEqual({ width: 301, height: 1 });
  });

  it('runs in linear HDR after Bloom and before exposure and tone mapping', () => {
    const request = {
      lane: 'direct' as const,
      temporal: true,
      meter: true,
      bloom: true,
      lensFlare: true,
      exposure: true,
      whiteBalance: false,
      lut: false,
      barrelDistortion: false,
      fxaa: false,
      lensEffects: false,
      outputEncoding: 'explicit-oetf' as const,
    };
    const plan = createStandardOutputPlan(request);
    const stages = plan.logicalStages;
    expect(stages.indexOf('lens-flare')).toBe(stages.indexOf('bloom') + 1);
    expect(stages.indexOf('lens-flare')).toBeLessThan(stages.indexOf('exposure-white-balance'));
    expect(plan.physicalStages.find((stage) => stage.name === 'lens-flare')).toEqual({
      name: 'lens-flare',
      input: 'linear-hdr',
      output: 'linear-hdr',
    });
    expect(validateStandardOutputPlan(plan).ok).toBe(true);
    expect(plan.incrementalResources).toEqual(
      expect.arrayContaining([
        'standard-lens-flare-prefilter',
        'standard-lens-flare-bokeh',
        'standard-lens-flare',
      ]),
    );
    const disabled = createStandardOutputPlan({ ...request, lensFlare: false });
    expect(disabled.logicalStages).not.toContain('lens-flare');
    expect(disabled.incrementalResources).not.toContain('standard-lens-flare');
  });
});
