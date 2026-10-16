import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { ok } from '@forgeax/engine-types';
import type {
  RenderFeature,
  RenderFeatureExtractContext,
  RenderFeatureHiddenEntityReport,
  RenderFeatureWorldVisibilitySnapshot,
} from '../features/types';

type Frame = { readonly count: number };

function consumeContext(context: RenderFeatureExtractContext): void {
  const snapshots: readonly RenderFeatureWorldVisibilitySnapshot[] =
    context.visibilitySnapshots ?? [];
  const report = context.reportHiddenEntity;
  const world: World | undefined = snapshots[0]?.world;
  const entity: EntityHandle = 0 as EntityHandle;
  if (world !== undefined && report !== undefined) {
    const hidden: RenderFeatureHiddenEntityReport = { world, entity };
    report(hidden);
  }
}

const feature = {
  identity: 'synthetic.visibility-context',
  extract(context) {
    consumeContext(context);
    return ok<Frame>({ count: context.worlds.length });
  },
  plan: () => ok({ work: [{ scope: 'frame', resources: [], passes: [] }] }),
} satisfies RenderFeature<Frame>;

void feature;
