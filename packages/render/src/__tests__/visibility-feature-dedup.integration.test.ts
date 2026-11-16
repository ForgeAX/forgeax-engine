import { World } from '@forgeax/engine-ecs';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createRenderFeatureHost } from '../features/host';
import type { RenderFeature } from '../features/types';
import { runSingleViewFeatureFrame } from './single-view-feature-fixture';

describe('render feature visibility report deduplication', () => {
  it('deduplicates a built-in and feature report by source entity handle', () => {
    const world = new World();
    const feature: RenderFeature<{ readonly count: number }> = {
      identity: 'synthetic.visibility-report',
      extract: (context) => {
        context.reportHiddenEntity?.({ entity: 3 as never });
        return ok({ count: context.world.inspect().entityCount });
      },
      plan: () => ok({ work: [{ scope: { view: 'main' }, resources: [], passes: [] }] }),
    };
    const host = createRenderFeatureHost([feature]).unwrap();

    const result = runSingleViewFeatureFrame(host, {
      world: world,
      frameNumber: 1,
      caps: {} as never,
      hiddenEntityReports: [{ entity: 3 as never }],
    });

    expect(result.hiddenEntityReports).toEqual([{ entity: 3 }]);
  });

  it('keeps source entity generations as separate reports', () => {
    const first = new World();
    const feature: RenderFeature<{ readonly count: number }> = {
      identity: 'synthetic.visibility-generations',
      extract: (context) => {
        context.reportHiddenEntity?.({ entity: 1 as never });
        context.reportHiddenEntity?.({ entity: 1048577 as never });
        return ok({ count: context.world.inspect().entityCount });
      },
      plan: () => ok({ work: [{ scope: { view: 'main' }, resources: [], passes: [] }] }),
    };
    const host = createRenderFeatureHost([feature]).unwrap();
    const result = runSingleViewFeatureFrame(host, {
      world: first,
      frameNumber: 1,
      caps: {} as never,
    });

    expect(result.hiddenEntityReports).toHaveLength(2);
    expect(result.hiddenEntityReports[0]?.entity).toBe(1);

    expect(result.hiddenEntityReports[1]?.entity).toBe(1048577);
  });
});
