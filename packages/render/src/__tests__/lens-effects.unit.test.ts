import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { withBuiltinRenderFeatures } from '../assembly/render-feature-post-processes';
import { Camera, LensEffects, resolveLensEffects } from '../components';
import { createRenderFeatureHost } from '../features/host';
import {
  chromaticAberrationActive,
  outputLensEffectsActive,
  packChromaticAberrationParams,
  packLensEffectsParams,
} from '../features/lens-effects';
import { createStandardOutputPlan } from '../pipeline/standard-output/graph';
import { extractCameraSnapshots } from '../render-system-extract';
import { setActiveCamera } from '../systems/active-camera';
import { prepareFeatureFrame } from './feature-frame-driver';

function fixture() {
  const world = new World();
  const camera = world
    .spawn(
      { component: Transform, data: {} },
      { component: Camera, data: {} },
      { component: LensEffects, data: {} },
    )
    .unwrap();
  return { world, camera, data: () => world.get(camera, LensEffects).unwrap() };
}

describe('camera LensEffects', () => {
  it('uses exact-zero extraction and detached camera data, including active-camera changes', () => {
    const { world, camera } = fixture();
    const other = world
      .spawn({ component: Transform, data: {} }, { component: Camera, data: {} })
      .unwrap();
    setActiveCamera(world, camera);
    expect(extractCameraSnapshots(world)[0]?.lensEffects).toBeUndefined();
    world.set(camera, LensEffects, { vignetteIntensity: 0.75, vignetteColor: [1, 0, 0] }).unwrap();
    const snapshot = extractCameraSnapshots(world)[0]?.lensEffects;
    expect(snapshot).toMatchObject({ vignetteIntensity: 0.75, vignetteColor: [1, 0, 0] });
    world.set(camera, LensEffects, { vignetteColor: [0, 1, 0] }).unwrap();
    expect(snapshot?.vignetteColor).toEqual([1, 0, 0]);
    expect(structuredClone(snapshot)).toEqual(snapshot);
    setActiveCamera(world, other);
    expect(extractCameraSnapshots(world)[0]?.lensEffects).toBeUndefined();
    world.removeComponent(camera, LensEffects).unwrap();
    setActiveCamera(world, camera);
    expect(extractCameraSnapshots(world)[0]?.lensEffects).toBeUndefined();
  });

  it.each([
    ['vignetteIntensity', -0.01],
    ['vignetteIntensity', 1.01],
    ['vignetteRadius', -1],
    ['vignetteRadius', 2],
    ['vignetteSoftness', 0],
    ['vignetteSoftness', 2],
    ['chromaticAberration', -1],
    ['chromaticAberration', 6],
    ['chromaticAberrationStartOffset', -0.1],
    ['chromaticAberrationStartOffset', 1.1],
    ['grainIntensity', -1],
    ['grainIntensity', 2],
    ['grainSize', 0],
    ['grainSize', 9],
  ] as const)('rejects %s=%s before graph admission', (field, value) => {
    const { data } = fixture();
    for (const invalid of [value, NaN, Infinity]) {
      const result = resolveLensEffects({ ...data(), [field]: invalid });
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error).toMatchObject({
          code: 'lens-effects-invalid-parameter',
          detail: { field, value: invalid },
        });
    }
  });

  it('rejects non-finite and out-of-range tint, even when intensity is zero', () => {
    const { data } = fixture();
    for (const value of [-1, 2, NaN, Infinity])
      expect(
        resolveLensEffects({ ...data(), vignetteColor: new Float32Array([value, 0, 0]) }).ok,
      ).toBe(false);
  });

  it('creates no resources for disabled cameras and packs a deterministic frame seed', () => {
    const host = createRenderFeatureHost(withBuiltinRenderFeatures([])).unwrap();
    try {
      const frame = prepareFeatureFrame(host, [
        {
          identity: 'main',
          render: true,
          worlds: [new World()],
          owner: 0,
          frameNumber: 1,
          caps: { rgba16floatRenderable: false } as never,
        },
      ]).frame;
      expect(frame.errors).toEqual([]);
      expect(frame.plans).toEqual([]);
      expect(frame.fullscreenEffects.size).toBe(0);
      const packed = packLensEffectsParams(undefined, 0xffffffff);
      expect(packed.byteLength).toBe(48);
      expect(new DataView(packed.buffer).getUint32(24, true)).toBe(0xffffffff);
      expect(packed).toEqual(packLensEffectsParams(undefined, 0xffffffff));
    } finally {
      host.dispose();
    }
  });

  it('composes after FXAA and barrel distortion with one final encoding', () => {
    const request = {
      temporal: true,
      meter: false,
      bloom: true,
      exposure: false,
      whiteBalance: false,
      lut: true,
      barrelDistortion: true,
      fxaa: true,
      lensEffects: true,
    };
    const plan = createStandardOutputPlan(request);
    expect(plan.logicalStages.slice(-4)).toEqual([
      'barrel-distortion',
      'fxaa',
      'lens-effects',
      'output-encoding',
    ]);
    expect(plan.physicalStages.find((stage) => stage.name === 'lens-effects')).toEqual({
      name: 'lens-effects',
      input: 'linear-ldr',
      output: 'linear-ldr',
    });
    expect(
      createStandardOutputPlan({ ...request, lensEffects: false }).incrementalResources,
    ).not.toContain('standard-lens-effects');
  });

  it('fringes the linear HDR scene before Bloom and tone mapping, as UE', () => {
    const plan = createStandardOutputPlan({
      temporal: true,
      meter: false,
      bloom: true,
      dof: true,
      chromaticAberration: true,
      exposure: false,
      whiteBalance: false,
      lut: false,
      fxaa: false,
      lensEffects: true,
    });
    expect(plan.logicalStages).toEqual([
      'temporal',
      'dof',
      'chromatic-aberration',
      'bloom',
      'tone',
      'lens-effects',
      'output-encoding',
    ]);
    expect(plan.physicalStages.find((stage) => stage.name === 'chromatic-aberration')).toEqual({
      name: 'chromatic-aberration',
      input: 'linear-hdr',
      output: 'linear-hdr',
    });
    expect(plan.incrementalResources).toContain('standard-chromatic-aberration');
  });

  it('schedules the fringe and the output pass independently', () => {
    const { data } = fixture();
    const only = (fields: Record<string, number>) =>
      resolveLensEffects({ ...data(), ...fields }).unwrap();
    const fringe = only({ chromaticAberration: 2 });
    expect([chromaticAberrationActive(fringe), outputLensEffectsActive(fringe)]).toEqual([
      true,
      false,
    ]);
    const vignette = only({ vignetteIntensity: 0.5 });
    expect([chromaticAberrationActive(vignette), outputLensEffectsActive(vignette)]).toEqual([
      false,
      true,
    ]);
    // UE ChromaticAberrationParams (PostProcessTonemap.cpp:709-733): percent over 1 - start.
    const packed = new Float32Array(
      packChromaticAberrationParams(
        only({ chromaticAberration: 4, chromaticAberrationStartOffset: 0.5 }),
      ).buffer,
    );
    expect(packed[0]).toBeCloseTo((0.04 * 0.007 * (611.3 - 464.3)) / 0.5, 6);
    expect(packed[1]).toBeCloseTo((0.04 * 0.007 * (549.1 - 464.3)) / 0.5, 6);
    expect(packed[2]).toBe(0.5);
  });
});
