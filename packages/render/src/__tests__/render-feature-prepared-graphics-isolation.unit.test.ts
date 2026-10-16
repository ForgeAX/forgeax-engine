import type { RhiCaps } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { RenderFeatureStageFailedError } from '../errors/render';
import { createRenderFeatureHost } from '../features/host';
import type { RenderFeatureWorkPlan } from '../features/plan';
import type { RenderFeature } from '../features/types';
import { runSingleViewFeatureFrame } from './single-view-feature-fixture';

const caps = { backendKind: 'null' } as unknown as Readonly<RhiCaps>;

function ordinaryFeature(identity: string): RenderFeature<{ readonly work: true }> {
  return {
    identity,
    extract: () => ok({ work: true }),
    plan: () => ok({ work: [{ scope: { view: 'main' }, resources: [], passes: [] }] }),
  };
}

function preparedFeature(
  identity: string,
  mode: 'healthy' | 'invalid' | 'empty',
): RenderFeature<{ readonly work: true }> {
  return {
    identity,
    extract: () => ok({ work: true }),
    plan: () => {
      if (mode === 'empty')
        return ok({ work: [{ scope: { view: 'main' }, resources: [], passes: [] }] });
      if (mode === 'invalid') {
        return err(new RenderFeatureStageFailedError(identity, 0, 'plan', 'next-frame'));
      }
      const value: RenderFeatureWorkPlan = { resources: [], passes: [] };
      return ok({ work: [{ scope: { view: 'main' }, ...value }] });
    },
  };
}

describe('prepared graphics feature isolation', () => {
  it('aborts only the failed feature while preserving healthy and base contributions', () => {
    const host = createRenderFeatureHost([
      preparedFeature('synthetic.failed', 'invalid'),
      ordinaryFeature('synthetic.healthy'),
    ]).unwrap();
    const result = runSingleViewFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      caps,
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      detail: { featureIdentity: 'synthetic.failed' },
    });
    expect(result.plans.map((contribution) => contribution.featureIdentity)).toEqual([
      'synthetic.healthy',
    ]);
    expect(result.plans[0]?.plan).toEqual({ resources: [], passes: [] });
  });

  it('treats an empty feature as successful no-work without a phantom graphics pass', () => {
    const host = createRenderFeatureHost([preparedFeature('synthetic.empty', 'empty')]).unwrap();
    const result = runSingleViewFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 2,
      caps,
    });
    expect(result.errors).toEqual([]);
    expect(result.plans[0]?.plan).toEqual({ resources: [], passes: [] });
    expect(host.diagnostics()[0]?.status).toBe('active');
  });
});
