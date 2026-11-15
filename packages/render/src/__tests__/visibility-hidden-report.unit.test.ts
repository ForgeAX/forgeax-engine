import { World } from '@forgeax/engine-ecs';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createRenderFeatureHost } from '../features/host';
import type { RenderFeature, RenderFeatureHiddenEntityReport } from '../features/types';
import { runSingleViewFeatureFrame } from './single-view-feature-fixture';

describe('render feature hidden entity report contract', () => {
  it('keeps the full source entity handle as the only merge key', () => {
    const report = { entity: 9 as never } satisfies RenderFeatureHiddenEntityReport;
    expect(Object.keys(report).sort()).toEqual(['entity']);
  });
  it('deduplicates reports without changing frustum statistics', () => {
    const world = new World();
    const feature: RenderFeature<{ readonly count: number }> = {
      identity: 'synthetic.hidden-report',
      extract: (context) => {
        context.reportHiddenEntity?.({ entity: 9 as never });
        context.reportHiddenEntity?.({ entity: 9 as never });
        return ok({ count: context.world.inspect().entityCount });
      },
      plan: () => ok({ work: [{ scope: { view: 'main' }, resources: [], passes: [] }] }),
    };
    const host = createRenderFeatureHost([feature]).unwrap();
    const result = runSingleViewFeatureFrame(host, {
      world: world,
      frameNumber: 1,
      caps: {} as never,
    });

    expect(result.hiddenEntityReports).toHaveLength(1);
    expect(result).not.toHaveProperty('frustumStats');
  });
});
