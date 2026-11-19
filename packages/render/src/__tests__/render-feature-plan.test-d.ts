import type { TextureFormat } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { expectTypeOf } from 'vitest';
import type { RenderFeaturePlan, RenderFeatureWorkPlan } from '../features/plan';
import type { RenderFeature } from '../features/types';
import type { RenderFeatureRecovery } from '../features/vocabulary';
import type { RenderFeaturePlanContext, SceneDataTarget } from '../index';

declare const context: RenderFeaturePlanContext;
const resolved = context.views[0]?.sceneData.require('forgeax::scene-data::temporal-v1');
if (resolved === undefined) throw new Error('view catalog missing');
expectTypeOf(resolved).toEqualTypeOf<
  import('../temporal/scene-data').SceneDataTarget<'forgeax::scene-data::temporal-v1'>
>();

expectTypeOf(resolved).toMatchTypeOf<SceneDataTarget>();
expectTypeOf(resolved.access).toEqualTypeOf<'sampled-read'>();

const format: TextureFormat = 'rgba8unorm';

const plan: RenderFeatureWorkPlan = {
  resources: [],
  passes: [
    {
      kind: 'raster',
      name: 'draw',
      colorAttachments: [{ target: 'color', loadOp: 'load', storeOp: 'store' }],
      draws: [],
    },
  ],
};

const pendingPlan: RenderFeaturePlan = {
  pendingSource: { resource: 'wave-set', reason: 'asset-dependency-pending' },
  work: [],
};
const pendingWork = {
  pendingSource: pendingPlan.pendingSource,
  work: [{ scope: 'frame' as const, ...plan }],
};
// @ts-expect-error A pending source cannot declare graph work before its input is ready.
const invalidPendingWork: RenderFeaturePlan = pendingWork;
// @ts-expect-error A pending source cannot acknowledge source intents.
const pendingFeedback: RenderFeaturePlan = {
  pendingSource: pendingPlan.pendingSource,
  work: [],
  sourceFeedback: {},
};

const feature = {
  identity: 'synthetic.plan',
  extract: () => ok({ frame: 1 }),
  plan(data: { readonly frame: number }, planContext: RenderFeaturePlanContext) {
    void data;
    void planContext.frame;
    void planContext.caps;
    void planContext.views.map((view) => view.sceneData);
    // @ts-expect-error plan callbacks cannot access a raw device.
    void planContext.device;
    // @ts-expect-error plan callbacks cannot access a queue.
    void planContext.queue;
    // @ts-expect-error plan callbacks cannot access an encoder.
    void planContext.encoder;
    // @ts-expect-error plan callbacks cannot submit work.
    void planContext.submit;
    return ok({ work: [{ scope: { view: 'main' }, ...plan }] });
  },
} satisfies RenderFeature<{ readonly frame: number }>;

const missingPlan = {
  identity: 'synthetic.invalid',
  extract: () => ok(undefined),
};
// @ts-expect-error RenderFeature plan is mandatory.
const invalidFeature: RenderFeature<undefined> = missingPlan;

const invalidDispatch: RenderFeatureWorkPlan = {
  resources: [],
  passes: [
    {
      kind: 'compute',
      name: 'bad',
      program: 'missing',
      bindings: 'missing',
      dispatches: [
        {
          // @ts-expect-error dispatch variants are closed; callbacks are not executable descriptors.
          kind: 'callback',
          callback: () => undefined,
        },
      ],
    },
  ],
};

function recoveryLabel(recovery: RenderFeatureRecovery): string {
  switch (recovery) {
    case 'next-frame':
      return recovery;
    case 'renderer-recover':
      return recovery;
    case 'registration':
      return recovery;
  }
  const exhaustive: never = recovery;
  return exhaustive;
}

void format;
void pendingWork;
void invalidPendingWork;
void pendingFeedback;
void feature;
void invalidFeature;
void invalidDispatch;
void recoveryLabel;
