import { ok } from '@forgeax/engine-types';
import type { RenderFeature, RenderFeaturePlanContext } from '../features/types';
import type { RendererOptions } from '../render-contract';

type BoundsFrame = {
  readonly visibleCount: number;
};

type OverlayFrame = {
  readonly layer: 'overlay';
};

const boundsFeature = {
  identity: 'test.bounds',
  extract({ owner }) {
    return ok({ visibleCount: owner });
  },
  plan(data: BoundsFrame, context: RenderFeaturePlanContext) {
    const count: number = data.visibleCount;
    void count;
    void context;
    return ok({ work: [{ scope: 'frame', resources: [], passes: [] }] });
  },
} satisfies RenderFeature<BoundsFrame>;

const overlayFeature = {
  identity: 'test.overlay',
  extract() {
    return ok({ layer: 'overlay' as const });
  },
  plan(data: OverlayFrame, context: RenderFeaturePlanContext) {
    const layer: 'overlay' = data.layer;
    void layer;
    void context;
    return ok({ work: [{ scope: 'frame', resources: [], passes: [] }] });
  },
} satisfies RenderFeature<OverlayFrame>;

const rendererOptions = {
  features: [boundsFeature, overlayFeature],
} satisfies RendererOptions;

void rendererOptions;
