import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { err, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import {
  RenderFeaturePreparationFailedError,
  RenderFeatureStageFailedError,
} from '../errors/render';
import { createRenderFeatureHost } from '../features/host';
import type { RenderFeature } from '../features/types';
import { admitViewFeaturePlan } from '../render-system-record';
import { EMPTY_VIEW_FEATURE_PLAN, ViewFeaturePlans } from '../world/feature-plan-systems';
import { renderSubmission } from '../world/render-world';
import type { ViewSettlementOwner } from '../world/view-settlement';
import { abortFeatureFrame, prepareFeatureFrame, submitFeatureFrame } from './feature-frame-driver';

async function frame(feature: RenderFeature<{ required: boolean }>) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const host = createRenderFeatureHost([feature]).unwrap();
  const run = (caps = device.caps) =>
    prepareFeatureFrame(host, [
      {
        world: new World(),
        identity: 'main',
        render: true,
        frameNumber: 1,
        generation: 0,
        caps,
      },
    ]);
  return { host, run, device };
}

it('reports the material owner code raised by a required feature plan', async () => {
  const f = await frame({
    identity: 'particle-program',
    requiresPreparation: () => true,
    extract: () => ok({ required: true }),
    plan: () => {
      throw Object.assign(new Error('Missing particle program'), {
        code: 'material-specialization-not-cooked',
      });
    },
  });
  try {
    expect(f.run().frame.preparationPendingReason).toMatchObject({
      preparationStage: 'source-plan',
      reason: 'material-specialization-not-cooked',
    });
  } finally {
    f.host.dispose();
  }
});

it('waits for a declared pending source without admitting or acknowledging work, then retries ready', async () => {
  let pending = true;
  const aborted = vi.fn(),
    submitted = vi.fn();
  const f = await frame({
    identity: 'pending-source',
    extract: () => ok({ required: true }),
    plan: () =>
      ok(
        pending
          ? {
              pendingSource: { resource: 'wave-set', reason: 'asset-dependency-pending' },
              work: [],
            }
          : { work: [{ scope: 'frame', resources: [], passes: [] }] },
      ),
    onFrameAborted: aborted,
    onFrameSubmitted: submitted,
  });
  try {
    const waiting = f.run();
    expect(waiting.frame.preparationPendingReason).toEqual({
      code: 'feature-preparation',
      featureIdentity: 'pending-source',
      preparationStage: 'source-plan',
      operation: 'resolve-source',
      resource: 'wave-set',
      reason: 'asset-dependency-pending',
    });
    expect(waiting.views.get('main')?.preparationPending).toBe(true);
    expect(waiting.frame.plans).toEqual([]);
    expect(waiting.frame.errors).toEqual([]);
    expect(f.host.diagnostics()[0]?.status).toBe('active');
    expect(aborted).toHaveBeenCalledTimes(1);
    submitFeatureFrame(f.host);
    expect(submitted).not.toHaveBeenCalled();
    expect(aborted).toHaveBeenCalledTimes(1);
    pending = false;
    const ready = f.run();
    expect(ready.frame.preparationPending).not.toBe(true);
    expect(ready.frame.plans).toHaveLength(1);
    submitFeatureFrame(f.host);
    expect(submitted).toHaveBeenCalledTimes(1);
  } finally {
    f.host.dispose();
  }
});

it('preserves a permanent source failure after a pending source', async () => {
  let pending = true;
  const failure = new RenderFeatureStageFailedError('pending-source', 0, 'plan', 'next-frame', {
    reason: 'asset-load-failed',
    guid: 'wave-set',
  });
  const f = await frame({
    identity: 'pending-source',
    extract: () => ok({ required: true }),
    plan: () =>
      pending
        ? ok({
            pendingSource: { resource: 'wave-set', reason: 'asset-dependency-pending' },
            work: [],
          })
        : err(failure),
  });
  try {
    const waiting = f.run();
    expect(waiting.frame.errors).toEqual([]);
    abortFeatureFrame(f.host);
    pending = false;
    const failed = f.run();
    expect(failed.frame.errors).toEqual([failure]);
    expect(f.host.diagnostics()[0]?.status).toBe('failed');
    expect(failed.frame.plans).toEqual([]);
  } finally {
    abortFeatureFrame(f.host);
    f.host.dispose();
  }
});

it('holds view graph admission until a pending shared source is ready', async () => {
  let pending = true;
  const f = await frame({
    identity: 'pending-shared-source',
    extract: () => ok({ required: true }),
    plan: () =>
      ok(
        pending
          ? { pendingSource: { resource: 'shared-field', reason: 'asset-pending' }, work: [] }
          : { work: [] },
      ),
  });
  const fire = vi.fn();
  const frameState = { frameNumber: 1 };
  const state = {
    get frame() {
      return renderSubmission(f.host.world).frame;
    },
    outcome: { kind: 'planned', plan: EMPTY_VIEW_FEATURE_PLAN },
    taken: false,
  };
  const view = f.host.world
    .spawn({
      component: ViewFeaturePlans,
      data: { state: f.host.world.allocUniqueRef('ViewFeaturePlans', state) },
    })
    .unwrap();
  const owner = {
    internals: {
      renderWorld: f.host.world,
      viewEntity: view,
      featureHost: f.host,
      errorRegistry: { fire },
    },
    frameState,
    recorded: { visibility: { explicitlyHidden: 0 } },
    recording: { pendingFeatureErrors: new Map() },
  } as unknown as ViewSettlementOwner;
  try {
    const waiting = f.run();
    expect(admitViewFeaturePlan(owner, waiting.views.get('main'))).toBeUndefined();
    expect(frameState).toMatchObject({ pipelinePreparationPending: true });
    expect(fire).not.toHaveBeenCalled();
    abortFeatureFrame(f.host);
    pending = false;
    const ready = f.run();
    expect(admitViewFeaturePlan(owner, ready.views.get('main'))).toBe(EMPTY_VIEW_FEATURE_PLAN);
  } finally {
    abortFeatureFrame(f.host);
    f.host.dispose();
  }
});

it.each([
  'uninstall',
  'dispose',
] as const)('settles pending source ownership once on %s', async (action) => {
  const aborted = vi.fn(),
    submitted = vi.fn();
  const feature: RenderFeature<{ required: boolean }> = {
    identity: 'pending-source',
    extract: () => ok({ required: true }),
    plan: () =>
      ok({ pendingSource: { resource: 'wave-set', reason: 'asset-dependency-pending' }, work: [] }),
    onFrameAborted: aborted,
    onFrameSubmitted: submitted,
  };
  const f = await frame(feature);
  const waiting = f.run();
  expect(waiting.frame.preparationPending).toBe(true);
  if (action === 'uninstall') f.host.uninstall(feature).unwrap();
  else f.host.dispose().unwrap();
  expect(aborted).toHaveBeenCalledTimes(1);
  expect(submitted).not.toHaveBeenCalled();
  if (action === 'uninstall') {
    submitFeatureFrame(f.host);
    f.host.dispose().unwrap();
  }
  expect(aborted).toHaveBeenCalledTimes(1);
  expect(submitted).not.toHaveBeenCalled();
});

it('retains explicit source preparation through a failed plan and retries without changing ordinary failures', async () => {
  let required = true,
    missing = true;
  const feature: RenderFeature<{ required: boolean }> = {
    identity: 'source-preparation',
    extract: () => ok({ required }),
    requiresPreparation: (data) => data.required,
    plan: () =>
      missing
        ? err(new RenderFeatureStageFailedError('source-preparation', 0, 'plan', 'next-frame'))
        : ok({ work: [] }),
  };
  const f = await frame(feature);
  try {
    const pending = f.run();
    expect(pending.frame.preparationPending).toBe(true);
    expect(pending.frame.preparationPendingFeatureIdentity).toBe('source-preparation');
    expect(pending.frame.preparationPendingReason).toEqual({
      code: 'feature-preparation',
      featureIdentity: 'source-preparation',
      preparationStage: 'source-plan',
    });
    expect(pending.frame.errors).toHaveLength(1);
    abortFeatureFrame(f.host);
    required = false;
    const ordinary = f.run();
    expect(ordinary.frame.preparationPending).not.toBe(true);
    expect(ordinary.frame.preparationPendingReason).toBeUndefined();
    expect(ordinary.frame.errors).toHaveLength(1);
    abortFeatureFrame(f.host);
    required = true;
    missing = false;
    f.host.recover({ frameNumber: 2, caps: f.device.caps }).unwrap();
    const ready = f.run();
    expect(ready.frame.preparationPending).not.toBe(true);
    expect(ready.frame.preparationPendingFeatureIdentity).toBeUndefined();
    expect(ready.frame.preparationPendingReason).toBeUndefined();
    expect(ready.frame.errors).toEqual([]);
    abortFeatureFrame(f.host);
  } finally {
    f.host.dispose();
  }
});

it('a failed source readiness guard cannot fail open and still aborts extracted ownership once', async () => {
  const aborted = vi.fn(),
    plan = vi.fn(() => ok({ work: [] }));
  const f = await frame({
    identity: 'guard-failure',
    extract: () => ok({ required: true }),
    requiresPreparation: () => {
      throw Error('guard unavailable');
    },
    plan,
    onFrameAborted: aborted,
  });
  try {
    const value = f.run();
    expect(value.frame.preparationPending).toBe(true);
    expect(value.frame.preparationPendingFeatureIdentity).toBe('guard-failure');
    expect(value.frame.preparationPendingReason).toEqual({
      code: 'feature-preparation',
      featureIdentity: 'guard-failure',
      preparationStage: 'source-guard',
    });
    expect(value.frame.errors).toHaveLength(1);
    expect(plan).not.toHaveBeenCalled();
    expect(aborted).toHaveBeenCalledTimes(1);
    abortFeatureFrame(f.host);
    expect(aborted).toHaveBeenCalledTimes(1);
  } finally {
    f.host.dispose();
  }
});

it('bounds one first-frame blocker without serializing an exception or calling unknown work compile', async () => {
  const identity = 'bounded'.repeat(100),
    token = 'resource'.repeat(100);
  const f = await frame({
    identity,
    extract: () => ok({ required: true }),
    requiresPreparation: () => true,
    plan: () =>
      err(
        new RenderFeaturePreparationFailedError(
          identity,
          0,
          'upload'.repeat(100),
          'vertex-data',
          token,
          'backend-not-resident'.repeat(100),
          'next-frame',
        ),
      ),
  });
  try {
    const pending = f.run();
    const reason = pending.frame.preparationPendingReason;
    expect(reason).toEqual({
      code: 'feature-preparation',
      featureIdentity: identity.slice(0, 256),
      preparationStage: 'resource-preparation',
      operation: 'upload'.repeat(100).slice(0, 64),
      resource: token.slice(0, 256),
      reason: 'backend-not-resident'.repeat(100).slice(0, 128),
    });
    expect(structuredClone(reason)).toEqual(reason);
    abortFeatureFrame(f.host);
    f.host.recover({ frameNumber: 2, caps: f.device.caps }).unwrap();
    expect(reason).toEqual(pending.frame.preparationPendingReason);
  } finally {
    f.host.dispose();
  }
});

it('aborts a pending source plan and prepared siblings without feedback, then accepts a fresh ready frame', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  let pending = false;
  const aborted = vi.fn(),
    submitted = vi.fn(),
    acknowledged = vi.fn();
  const features: RenderFeature<number>[] = ['prepared', 'dependency'].map((identity) => ({
    identity,
    placement: 'scene',
    extract: ({ frameNumber }) => ok(frameNumber),
    plan: () =>
      pending && identity === 'dependency'
        ? ok({
            pendingSource: { resource: 'dependency', reason: 'asset-pending' },
            work: [] as const,
          })
        : ok({
            work: [{ scope: 'frame' as const, resources: [], passes: [] }],
            sourceFeedback: identity,
          }),
    onFrameAborted: (source) => aborted(identity, source),
    onFrameSubmitted: (source) => submitted(identity, source),
    onSourceFrameSubmitted: (source, feedback) => acknowledged(identity, source, feedback),
  }));
  const host = createRenderFeatureHost(features).unwrap();
  const world = new World();
  const run = (frameNumber: number) => {
    const open = host.beginFrame([
      { world, identity: 'main', render: true, frameNumber, caps: device.caps },
    ]);
    for (const feature of features) host.prepareFeature(open, feature.identity);
    return host.finishFrame(open);
  };
  try {
    const first = run(1);
    const stale = new Set(first.frame.plans);
    expect(host.submitFrame(first, stale)).toEqual([]);
    expect(submitted).toHaveBeenCalledTimes(2);
    pending = true;
    const waiting = run(2);
    expect(waiting.frame.preparationPendingReason).toEqual({
      code: 'feature-preparation',
      featureIdentity: 'dependency',
      preparationStage: 'source-plan',
      operation: 'resolve-source',
      resource: 'dependency',
      reason: 'asset-pending',
    });
    expect(waiting.frame.errors).toEqual([]);
    expect(waiting.frame.plans.some((plan) => plan.featureIdentity === 'dependency')).toBe(false);
    expect(aborted).toHaveBeenCalledWith('dependency', 2);
    expect(host.submitFrame(waiting, new Set([...stale, ...waiting.frame.plans]))).toEqual([]);
    expect(aborted).toHaveBeenCalledWith('prepared', 2);
    expect(submitted).toHaveBeenCalledTimes(2);
    expect(acknowledged).toHaveBeenCalledTimes(2);
    expect(host.submitFrame(waiting, stale)).toEqual([]);
    expect(aborted).toHaveBeenCalledTimes(2);
    pending = false;
    const recovered = run(3);
    expect(recovered.frame.preparationPending).not.toBe(true);
    expect(recovered.frame.errors).toEqual([]);
    expect(host.submitFrame(recovered, new Set(recovered.frame.plans))).toEqual([]);
    expect(submitted).toHaveBeenCalledTimes(4);
    expect(acknowledged).toHaveBeenLastCalledWith('dependency', 3, 'dependency');
  } finally {
    host.dispose();
  }
});

it.each([
  { work: [{ scope: 'frame', resources: [], passes: [] }] },
  { sourceFeedback: 'premature acknowledgement' },
  { native: {} },
])('rejects a pending plan with forbidden content: %j', async (forbidden) => {
  const aborted = vi.fn();
  const f = await frame({
    identity: 'invalid-pending',
    extract: () => ok({ required: true }),
    plan: () =>
      ok({
        pendingSource: { resource: 'dependency', reason: 'asset-pending' },
        work: [],
        ...forbidden,
      } as never),
    onFrameAborted: aborted,
  });
  try {
    const value = f.run();
    expect(value.frame.errors).toMatchObject([{ code: 'render-feature-stage-failed' }]);
    expect(value.frame.plans).toEqual([]);
    expect(aborted).toHaveBeenCalledTimes(1);
    abortFeatureFrame(f.host);
  } finally {
    f.host.dispose();
  }
});

it('keeps unsupported capabilities as errors while a source dependency is pending', async () => {
  const aborted = vi.fn();
  const f = await frame({
    identity: 'pending-unsupported',
    requiredCapabilities: ['indirectDrawing'],
    extract: () => ok({ required: true }),
    plan: () =>
      ok({ pendingSource: { resource: 'dependency', reason: 'asset-pending' }, work: [] }),
    onFrameAborted: aborted,
  });
  try {
    const value = f.run({ ...f.device.caps, indirectDrawing: false });
    expect(value.frame.errors).toMatchObject([
      { code: 'render-feature-capability-missing', detail: { capability: 'indirectDrawing' } },
    ]);
    expect(value.frame.plans).toEqual([]);
    expect(f.host.diagnostics()[0]?.status).toBe('disabled');
    expect(aborted).toHaveBeenCalledTimes(1);
    abortFeatureFrame(f.host);
  } finally {
    f.host.dispose();
  }
});
