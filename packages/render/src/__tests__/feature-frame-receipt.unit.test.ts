import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createRenderFeatureHost } from '../features/host';
import type { RenderFeature } from '../features/types';
import type { FrameReceipt } from '../render-contract';
import { renderSubmission } from '../world/render-world';
import { prepareFeatureFrame, submitFeatureFrame } from './feature-frame-driver';

it('isolates receipt hooks after an accepted submission and attributes every failure', async () => {
  const calls: string[] = [];
  const errors: unknown[] = [];
  const features: RenderFeature<null>[] = ['throwing', 'sibling'].map((identity) => ({
    identity,
    extract: () => ok(null),
    plan: () => ok({ work: [{ scope: 'frame', resources: [], passes: [] }] }),
    onFrameReceipt: () => {
      calls.push(identity);
      if (identity === 'throwing') throw new Error('receipt hook failed');
    },
  }));
  const host = createRenderFeatureHost(features, undefined, (error) => errors.push(error)).unwrap();
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const completed = Promise.resolve(ok(undefined));
  const receipt: FrameReceipt = {
    frameId: 1,
    deviceGeneration: 0,
    presentation: 'ready',
    completed,
  };
  try {
    prepareFeatureFrame(host, [
      { identity: 'main', render: true, worlds: [], owner: 1, frameNumber: 1, caps: device.caps },
    ]);
    submitFeatureFrame(host);
    expect(renderSubmission(host.world).accepted).toBe(true);
    expect(() => host.deliverFrameReceipt(receipt, async () => ok([]))).not.toThrow();
    expect(calls).toEqual(['throwing', 'sibling']);
    expect(renderSubmission(host.world).accepted).toBe(true);
    expect(errors).toMatchObject([
      {
        code: 'render-feature-stage-failed',
        detail: { featureIdentity: 'throwing', stage: 'receipt' },
      },
    ]);
    expect(host.diagnostics().find((row) => row.identity === 'throwing')).toMatchObject({
      status: 'failed',
    });
  } finally {
    host.dispose().unwrap();
  }
});
