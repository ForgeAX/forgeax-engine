import { createHash } from 'node:crypto';
import { World } from '@forgeax/engine-ecs';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { parse, validate } from '../../../naga/src/index';
import { ANTIALIAS_SMAA, antialiasFromF32, Camera } from '../components/camera';
import { createRenderFeatureHost, runRenderFeatureFrame } from '../features/host';
import { smaaLookupData } from '../features/smaa/lookup-data';
import { createSmaaRenderFeature, SMAA_PROGRAMS } from '../features/smaa/shaders';
import {
  createStandardOutputPlan,
  validateStandardOutputPlan,
} from '../pipeline/standard-output/graph';
import { extractCameraSnapshots } from '../render-system-extract';

describe('SMAA authoring and production programs', () => {
  it('projects the public Camera mode without temporal jitter or history', () => {
    const world = new World();
    world
      .spawn(
        { component: Transform, data: {} },
        { component: Camera, data: { antialias: ANTIALIAS_SMAA } },
      )
      .unwrap();
    propagateTransforms(world);
    expect(antialiasFromF32(ANTIALIAS_SMAA)).toBe('smaa');
    expect(extractCameraSnapshots(world)[0]?.antialias).toBe('smaa');
    expect(() => antialiasFromF32(5)).toThrow();
  });
  it.each([
    'direct',
    'clustered',
  ] as const)('places SMAA after spatial effects and before the single output encoding in %s', (lane) => {
    const plan = createStandardOutputPlan({
      lane,
      temporal: false,
      meter: false,
      bloom: true,
      exposure: false,
      whiteBalance: false,
      lut: true,
      outline: true,
      barrelDistortion: true,
      fxaa: false,
      smaa: true,
      outputEncoding: 'explicit-oetf',
    });
    expect(plan.logicalStages).toEqual([
      'bloom',
      'tone',
      'lut',
      'outline',
      'barrel-distortion',
      'smaa',
      'output-encoding',
    ]);
    expect(plan.physicalStages.at(-2)).toEqual({
      name: 'smaa',
      input: 'linear-ldr',
      output: 'linear-ldr',
    });
    expect(validateStandardOutputPlan(plan).ok).toBe(true);
    expect(plan.outputEncodingCount).toBe(1);
  });
  it.each(SMAA_PROGRAMS)('validates the actual $name shader with Naga', async (program) => {
    const parsed = await parse(program.source);
    if (!parsed.ok) throw parsed.error;
    const validated = await validate(parsed.value);
    if (!validated.ok) throw validated.error;
    expect(validated.ok).toBe(true);
  });
  it('prepares SMAA only for updating views that selected it', () => {
    const world = new World();
    world
      .spawn(
        { component: Transform, data: {} },
        { component: Camera, data: { antialias: ANTIALIAS_SMAA } },
      )
      .unwrap();
    propagateTransforms(world).unwrap();
    const selectedCamera = extractCameraSnapshots(world)[0];
    if (selectedCamera === undefined) throw new Error('Camera fixture missing');
    const host = createRenderFeatureHost([createSmaaRenderFeature()]).unwrap();
    const batch = runRenderFeatureFrame(
      host,
      [
        {
          identity: 'disabled',
          render: true,
          selectedCamera: { ...selectedCamera, antialias: 'none' as const },
        },
        { identity: 'active', render: true, selectedCamera },
        { identity: 'held', render: false, selectedCamera },
      ].map((view) => ({
        ...view,
        worlds: [world],
        owner: 0,
        frameNumber: 1,
        caps: { rgba16floatRenderable: true } as never,
      })),
    );
    try {
      expect(batch.frame.errors).toEqual([]);
      expect(batch.views.get('disabled')?.plans).toHaveLength(0);
      expect(batch.views.get('active')?.plans).toHaveLength(1);
      expect(batch.views.get('held')?.plans).toHaveLength(0);
    } finally {
      batch.onAborted();
      host.dispose();
    }
  });
  it('retains the exact upstream lookup bytes and independent decoded copies', () => {
    const data = smaaLookupData();
    expect(data.area.length).toBe(80 * 80 * 2);
    expect(data.search.length).toBe(66 * 33);
    expect(createHash('sha256').update(data.area).digest('hex')).toBe(
      'd6f73232a28d1261aa22173b223ccfca28c1eef17d470346aec26b1d4af20031',
    );
    expect(createHash('sha256').update(data.search).digest('hex')).toBe(
      'e5d85ae5a659337e6d6654b85d2741a0b08a2c7d2eda200151fb0b3bd41e6966',
    );
    data.area.fill(0);
    expect(smaaLookupData().area.some((n) => n > 0)).toBe(true);
  });
});
