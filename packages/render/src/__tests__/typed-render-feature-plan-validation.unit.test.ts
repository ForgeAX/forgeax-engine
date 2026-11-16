import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createRenderFeatureHost } from '../features/host';
import { renderFeaturePlanSignature } from '../features/plan';
import { createRenderFeatureGpuWorkOwner } from '../features/prepared-gpu-work';
import type { RenderFeature } from '../features/types';
import { validateRenderFeaturePlans } from '../record/typed-frame-graph';
import { submitFeatureFrame } from './feature-frame-driver';
import { runSingleViewFeatureFrame } from './single-view-feature-fixture';

describe('typed RenderFeature plan validation', () => {
  it('reports the exact failed admission predicate on the existing stage error', () => {
    const plan = { resources: [], passes: [] } as const;
    const result = validateRenderFeaturePlans([
      {
        scope: { view: 'main' },
        featureIdentity: 'water-advanced-producer',
        generation: 1,
        signature: renderFeaturePlanSignature(plan),
        plan,
      },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected typed plan admission to fail');
    expect(result.error).toMatchObject({
      code: 'render-feature-stage-failed',
      detail: {
        featureIdentity: 'water-advanced-producer',
        stage: 'plan',
        recovery: 'next-frame',
        cause: {
          kind: 'typed-render-feature-plan-admission',
          failedPredicates: {
            duplicateIdentity: false,
            signatureMismatch: false,
            executionMissing: true,
            executionIdentityMismatch: false,
            executionOrderNotIncreasing: false,
          },
          planned: {
            featureIdentity: 'water-advanced-producer',
            scope: { view: 'main' },
          },
        },
      },
    });
  });

  it('seals native buffer initialization revisions without invoking their copy closure', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const gpu = createRenderFeatureGpuWorkOwner({
      getDevice: () => device,
      getShaderModuleFactory: () => ({ createShaderModule: () => ok({} as never) }),
    });
    let copyCalls = 0;
    let version = 'sdf-field-v1';
    let byteLength = 16;
    const feature: RenderFeature<object> = {
      identity: 'water-advanced-producer',
      extract: () => ok({}),
      plan: () =>
        ok({
          work: [
            {
              scope: 'frame',
              resources: [
                {
                  kind: 'buffer',
                  name: 'rigid-sdf-fields',
                  allocationKey: version,
                  size: 16,
                  usage: ['storage'],
                  initialization: {
                    version,
                    byteLength,
                    copyInto() {
                      copyCalls += 1;
                      return true;
                    },
                  },
                },
              ],
              passes: [],
            },
          ],
        }),
    };
    const host = createRenderFeatureHost([feature]).unwrap();
    const world = new World();
    const frame = (frameNumber: number) =>
      runSingleViewFeatureFrame(host, {
        world,
        frameNumber,
        caps: device.caps,
        gpuWork: gpu,
        generation: 0,
      });
    try {
      const first = frame(1);
      expect(first.errors).toEqual([]);
      const firstCopiesBeforeTypedSeal = copyCalls;
      expect(validateRenderFeaturePlans(first.plans).ok).toBe(true);
      expect(copyCalls).toBe(firstCopiesBeforeTypedSeal);
      submitFeatureFrame(host);

      version = 'sdf-field-v2';
      byteLength = 12;
      const replacement = frame(2);
      expect(replacement.errors).toEqual([]);
      expect(replacement.plans[0]?.signature).toMatch(/^revision-/);
      const copiesBeforeTypedSeal = copyCalls;
      expect(validateRenderFeaturePlans(replacement.plans).ok).toBe(true);
      expect(copyCalls).toBe(copiesBeforeTypedSeal);
      expect(copyCalls).toBe(2);
      submitFeatureFrame(host);
    } finally {
      host.dispose();
      gpu.dispose().unwrap();
    }
  });
});
