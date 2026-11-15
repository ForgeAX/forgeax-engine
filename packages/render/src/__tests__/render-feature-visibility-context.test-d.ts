import type { EntityHandle } from '@forgeax/engine-ecs';
import { ok } from '@forgeax/engine-types';
import type {
  RenderFeature,
  RenderFeatureExtractContext,
  RenderFeatureHiddenEntityReport,
} from '../features/types';

type Frame = { readonly count: number };

function consumeContext(context: RenderFeatureExtractContext): void {
  const report = context.reportHiddenEntity;
  const entity: EntityHandle = 0 as EntityHandle;
  if (context.visibilitySnapshot !== undefined && report !== undefined) {
    const hidden: RenderFeatureHiddenEntityReport = { entity };
    report(hidden);
  }
}

const feature = {
  identity: 'synthetic.visibility-context',
  extract(context) {
    consumeContext(context);
    return ok<Frame>({ count: context.world.inspect().entityCount });
  },
  plan: () => ok({ work: [{ scope: 'frame', resources: [], passes: [] }] }),
} satisfies RenderFeature<Frame>;

void feature;
