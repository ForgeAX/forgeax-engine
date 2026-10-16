import { ok } from '@forgeax/engine-types';
import type { RenderFeature, RenderFeaturePlanContext } from '../features/types';

type AlphaFrame = {
  readonly visibleCount: number;
};

type BetaFrame = {
  readonly bounds: readonly [number, number, number, number];
};

const alphaFeature = {
  identity: 'synthetic.alpha',
  extract({ owner }) {
    return ok<AlphaFrame>({ visibleCount: owner });
  },
  plan(data: AlphaFrame, context: RenderFeaturePlanContext) {
    const count: number = data.visibleCount;
    void count;
    void context;
    return ok({ work: [{ scope: 'frame', resources: [], passes: [] }] });
  },
} satisfies RenderFeature<AlphaFrame>;

const betaFeature = {
  identity: 'synthetic.beta',
  extract() {
    return ok<BetaFrame>({ bounds: [0, 0, 1, 1] });
  },
  plan(data: BetaFrame, context: RenderFeaturePlanContext) {
    const bounds: BetaFrame['bounds'] = data.bounds;
    void bounds;
    void context;
    return ok({ work: [{ scope: 'frame', resources: [], passes: [] }] });
  },
} satisfies RenderFeature<BetaFrame>;

const heterogeneousFeatures = [
  alphaFeature,
  betaFeature,
] satisfies readonly RenderFeature<unknown>[];

for (const feature of heterogeneousFeatures) {
  const identity: string = feature.identity;
  void identity;
}

void alphaFeature;
void betaFeature;
