import { rhi } from '@forgeax/engine-rhi-null';
import { err, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import {
  RenderFeaturePreparationFailedError,
  RenderFeatureStageFailedError,
} from '../errors/render';
import { createRenderFeatureHost } from '../features/host';
import type { RenderFeature } from '../features/types';

async function frame(feature: RenderFeature<{ required: boolean }>) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const host = createRenderFeatureHost([feature]).unwrap();
  const run = () =>
    host.runFrame([
      {
        worlds: [],
        owner: 0,
        identity: 'main',
        render: true,
        frameNumber: 1,
        generation: 0,
        caps: device.caps,
      },
    ]);
  return { host, run, device };
}

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
    pending.onAborted();
    required = false;
    const ordinary = f.run();
    expect(ordinary.frame.preparationPending).not.toBe(true);
    expect(ordinary.frame.preparationPendingReason).toBeUndefined();
    expect(ordinary.frame.errors).toHaveLength(1);
    ordinary.onAborted();
    required = true;
    missing = false;
    f.host.recover({ frameNumber: 2, caps: f.device.caps }).unwrap();
    const ready = f.run();
    expect(ready.frame.preparationPending).not.toBe(true);
    expect(ready.frame.preparationPendingFeatureIdentity).toBeUndefined();
    expect(ready.frame.preparationPendingReason).toBeUndefined();
    expect(ready.frame.errors).toEqual([]);
    ready.onAborted();
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
    value.onAborted();
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
    pending.onAborted();
    f.host.recover({ frameNumber: 2, caps: f.device.caps }).unwrap();
    expect(reason).toEqual(pending.frame.preparationPendingReason);
  } finally {
    f.host.dispose();
  }
});
