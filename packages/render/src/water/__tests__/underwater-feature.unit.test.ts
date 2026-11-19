import { World } from '@forgeax/engine-ecs';
import { ok } from '@forgeax/engine-types';
import type { WaterViewState } from '@forgeax/engine-water';
import { expect, it } from 'vitest';
import { abortFeatureFrame, prepareFeatureFrame } from '../../__tests__/feature-frame-driver';
import { createRenderFeatureHost } from '../../features/host';
import {
  createWaterUnderwaterFeature,
  WATER_UNDERWATER_FEATURE_IDENTITY,
} from '../underwater-feature';

it.each([
  false,
  true,
])('preserves selected visual PP intent when its material is unavailable (active=%s)', (visualPpActive) => {
  const state: WaterViewState = {
    viewId: 'main',
    traceGeneration: 1,
    sceneGeneration: 1,
    trace: { coarse: [], precise: [], usedPrecise: false },
    candidates: [],
    intersection: 'underwater',
    immersionDepthM: 2,
    audioUnderwater: true,
    visualPpActive,
    postProcess: {
      materialGuid: '019fcf2d-7100-7000-8000-000000000232',
      enabled: true,
      priority: 0,
      blendRadiusM: 1,
      blendWeight: 1,
    },
  };
  const feature = createWaterUnderwaterFeature();
  const host = createRenderFeatureHost([
    {
      ...feature,
      extract: () =>
        ok({
          views: [{ view: 'main', waterView: { kind: 'available' as const, world: 0, state } }],
          inspection: [],
        }),
    },
  ]).unwrap();
  try {
    const batch = prepareFeatureFrame(host, [
      { identity: 'main', render: true, world: new World(), frameNumber: 1, caps: {} as never },
    ]);
    expect(batch.frame.preparationPending === true).toBe(visualPpActive);
    if (visualPpActive) {
      expect(batch.frame.preparationPendingReason).toMatchObject({
        featureIdentity: WATER_UNDERWATER_FEATURE_IDENTITY,
        preparationStage: 'source-plan',
      });
      expect(batch.frame.errors).toEqual([
        expect.objectContaining({
          code: 'render-feature-stage-failed',
          detail: expect.objectContaining({
            cause: expect.objectContaining({ reason: 'selected-post-process-unavailable' }),
          }),
        }),
      ]);
      expect(batch.views.get('main')?.plans).toEqual([]);
    } else expect(batch.frame.errors).toEqual([]);
  } finally {
    abortFeatureFrame(host);
    host.dispose();
  }
});
