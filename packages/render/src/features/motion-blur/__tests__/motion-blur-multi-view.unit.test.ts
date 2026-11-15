import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { makeZeroCameraFallbackSnapshot } from '../../../record/frame-snapshot';
import { createSceneDataCatalog } from '../../../temporal/scene-data-catalog';
import type { RenderFeaturePlanView } from '../../plan';
import { createMotionBlurFeature } from '../motion-blur-feature';
import { validateMotionBlurParams } from '../motion-blur-params';

function planView(
  identity: string,
  width: number,
  height: number,
  render = true,
  motionBlur?: RenderFeaturePlanView['motionBlur'],
): RenderFeaturePlanView {
  return {
    identity,
    render,
    ...(motionBlur === undefined ? {} : { motionBlur }),
    frame: { frameNumber: 1, width, height },
    targets: [
      { name: 'motion-input', kind: 'color', format: 'rgba16float', sampleCount: 1 },
      { name: 'motion-output', kind: 'color', format: 'rgba16float', sampleCount: 1 },
    ],
    sceneData: createSceneDataCatalog({
      featureIdentity: 'forgeax.motion-blur',
      generation: 0,
      planIdentity: identity,
      rgba16floatRenderable: true,
    }),
  };
}

describe('motion blur frame roster', () => {
  it('plans view-owned dimensions and accepted frame intervals, excluding held views', () => {
    const feature = createMotionBlurFeature();
    const frame = feature
      .extract({
        world: new World(),
        frameNumber: 1,
        views: [
          {
            identity: 'left',
            render: true,
            selectedCamera: {
              ...makeZeroCameraFallbackSnapshot(),
              motionBlur: validateMotionBlurParams({ shutterAngle: 120 }).unwrap(),
            },
          },
          {
            identity: 'right',
            render: true,
            selectedCamera: {
              ...makeZeroCameraFallbackSnapshot(),
              motionBlur: validateMotionBlurParams({ shutterAngle: 240 }).unwrap(),
            },
          },
          {
            identity: 'held',
            render: false,
            selectedCamera: {
              ...makeZeroCameraFallbackSnapshot(),
              motionBlur: validateMotionBlurParams({ shutterAngle: 180 }).unwrap(),
            },
          },
        ],
      })
      .unwrap();
    expect(frame.right).not.toHaveProperty('frameDeltaSeconds');
    expect(frame.right).not.toHaveProperty('reset');
    const plan = feature
      .plan(frame, {
        caps: {
          compute: true,
          storageBuffer: true,
          storageTexture: true,
          rgba16floatRenderable: true,
        } as never,
        frame: { frameNumber: 1 },
        generation: 0,
        views: [
          planView('right', 160, 80, true, {
            params: undefined,
            frameDeltaSeconds: 1 / 15,
            reset: true,
          }),
          planView('left', 640, 320, true, { params: undefined, frameDeltaSeconds: 1 / 60 }),
          planView('held', 32, 32, false),
        ],
      })
      .unwrap();
    expect(plan.work.map((work) => work.scope)).toEqual([{ view: 'right' }, { view: 'left' }]);
    for (const [index, work] of plan.work.entries()) {
      const params = work.resources.find(
        (resource) => resource.kind === 'buffer' && resource.name === 'motion-blur-compute-params',
      );
      if (params?.kind !== 'buffer' || params.data === undefined)
        throw new Error('motion parameters missing');
      const data = new DataView(params.data.buffer, params.data.byteOffset, params.data.byteLength);
      expect(data.getFloat32(0, true)).toBe(index === 0 ? 240 : 120);
      expect(data.getFloat32(24, true)).toBeCloseTo(index === 0 ? 1 / 15 : 1 / 60);
      expect(data.getUint32(12, true)).toBe(index === 0 ? 1 : 0);
      const tiles = work.resources.find(
        (resource) => resource.kind === 'buffer' && resource.name === 'motion-blur-tile-summary',
      );
      expect(tiles).toMatchObject({ size: index === 0 ? 10 * 5 * 32 : 40 * 20 * 32 });
    }
  });
});
