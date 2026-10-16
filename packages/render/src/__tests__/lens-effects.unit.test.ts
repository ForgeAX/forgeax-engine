import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { Camera, LensEffects, resolveLensEffects } from '../components';
import { createRenderFeatureHost, runRenderFeatureFrame } from '../features/host';
import { createLensEffectsRenderFeature, packLensEffectsParams } from '../features/lens-effects';
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
    ['chromaticAberration', 33],
    ['chromaticAberrationAngle', -4],
    ['chromaticAberrationAngle', 4],
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
    const host = createRenderFeatureHost([createLensEffectsRenderFeature()]).unwrap();
    try {
      const frame = runRenderFeatureFrame(host, [
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
      lane: 'direct' as const,
      temporal: true,
      meter: false,
      bloom: true,
      exposure: false,
      whiteBalance: false,
      lut: true,
      barrelDistortion: true,
      fxaa: true,
      lensEffects: true,
      outputEncoding: 'explicit-oetf' as const,
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
    expect(validateStandardOutputPlan(plan).ok).toBe(true);
    expect(plan.outputEncodingCount).toBe(1);
    expect(
      createStandardOutputPlan({ ...request, lensEffects: false }).incrementalResources,
    ).not.toContain('standard-lens-effects');
  });
});
