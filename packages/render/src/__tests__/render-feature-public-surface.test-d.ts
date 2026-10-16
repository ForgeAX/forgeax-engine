import type {
  RenderError,
  RenderFeature,
  RenderFeatureErrorDescriptor,
  RenderFeatureExtractContext,
  RenderFeaturePlan,
  RenderFeaturePlanContext,
} from '@forgeax/engine-render';
import { ok } from '@forgeax/engine-types';

type FrameData = {
  readonly visibleCount: number;
};

const feature = {
  identity: 'test.public-surface',
  extract(context: RenderFeatureExtractContext) {
    const owner: number = context.owner;
    return ok<FrameData>({ visibleCount: owner });
  },
  plan(data: FrameData, context: RenderFeaturePlanContext) {
    const count: number = data.visibleCount;
    const frameNumber: number = context.frame.frameNumber;
    const plan: RenderFeaturePlan = { work: [] };
    void count;
    void frameNumber;
    return ok(plan);
  },
} satisfies RenderFeature<FrameData>;

const errorDescriptor = (error: RenderError): RenderFeatureErrorDescriptor | undefined => {
  switch (error.code) {
    case 'render-feature-registration-conflict':
      return error;
    case 'render-feature-stage-failed':
      return error;
    case 'render-feature-capability-missing':
      return error;
    case 'render-feature-pass-order-conflict':
      return error;
    default:
      return undefined;
  }
};

void errorDescriptor;
void feature;

// The renderer host and construction context are internal implementation seams.
// @ts-expect-error host internals are not part of the render root surface
type _NoPublicFeatureHost = typeof import('@forgeax/engine-render')['RenderFeatureHost'];
// @ts-expect-error frame input is not a producer-facing public declaration
type _NoPublicFrameInput = typeof import('@forgeax/engine-render')['RenderFeatureFrameInput'];
// @ts-expect-error bundler manifest wiring is not a render feature API
type _NoPublicBundlerOptions = typeof import('@forgeax/engine-render')['BundlerOptions'];
// @ts-expect-error remote inspection/RPC symbols do not belong to the render root
type _NoPublicRpcClient = typeof import('@forgeax/engine-render')['InspectorClient'];
