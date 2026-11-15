import { World } from '@forgeax/engine-ecs';
import type { RhiCaps } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createRenderFeatureHost } from '../features/host';
import type { RenderFeature } from '../features/types';
import { runSingleViewFeatureFrame } from './single-view-feature-fixture';

const missingCaps = {
  backendKind: 'null',
  compute: false,
  timestampQuery: false,
  timestampPeriodNanoseconds: null,
  indirectDrawing: false,
  textureCompressionBc: false,
} as RhiCaps;

/** Active work that asks presentation to wait for its prepared pipelines. */
function preparedComputeFeature(): RenderFeature<{ readonly draw: boolean }> {
  return {
    identity: 'synthetic.capability.prepared',
    requiredCapabilities: ['compute'],
    requiresPreparation: () => true,
    extract: () => ok({ draw: true }),
    plan: () =>
      ok({
        work: [
          {
            scope: { view: 'main' },
            resources: [
              {
                kind: 'fullscreen-program' as const,
                name: 'synthetic.capability.prepared.program',
                source: 'synthetic',
              },
            ],
            passes: [],
          },
        ],
      }),
  };
}

it('presents without a feature the device cannot prepare and reports it once', () => {
  const host = createRenderFeatureHost([preparedComputeFeature()]).unwrap();
  const world = new World();
  const first = runSingleViewFeatureFrame(host, {
    world,
    frameNumber: 1,
    caps: missingCaps,
  });
  // The capability cannot appear on this device, so waiting would never present.
  expect(first.preparationPending).toBeUndefined();
  expect(first.errors).toMatchObject([{ code: 'render-feature-capability-missing' }]);
  expect(first.errors).toHaveLength(1);
  expect(host.diagnostics()[0]).toMatchObject({
    status: 'disabled',
    latestError: { code: 'render-feature-capability-missing', detail: { capability: 'compute' } },
  });

  const later = runSingleViewFeatureFrame(host, {
    world,
    frameNumber: 2,
    caps: missingCaps,
  });
  expect(later.preparationPending).toBeUndefined();
  expect(later.errors).toEqual([]);
  expect(later.plans).toEqual([]);
  expect(host.diagnostics()[0]?.status).toBe('disabled');
});
