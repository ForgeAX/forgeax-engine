import type { RenderFeature } from '@forgeax/engine-render';
import type { RhiCaps } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { RenderFeatureStageFailedError } from '../../../render/src/errors/render';
import { createRenderFeatureHost, runRenderFeatureFrame } from '../../../render/src/features/host';

const caps = (compute: boolean): Readonly<RhiCaps> => ({ compute }) as unknown as RhiCaps;

function recoverableFeature(calls: string[]): RenderFeature<{ readonly frame: number }> {
  return {
    identity: 'synthetic.recoverable',
    requiredCapabilities: ['compute'],
    extract: ({ frameNumber }) => {
      calls.push(`extract:${frameNumber}`);
      return ok({ frame: frameNumber });
    },
    plan: (data) => {
      calls.push(`plan:${data.frame}`);
      return ok({ work: [] });
    },
  };
}

describe('render feature recovery lifecycle', () => {
  it('retries failed slots, gates missing capabilities, and re-evaluates on recover', () => {
    const calls: string[] = [];
    const host = createRenderFeatureHost([recoverableFeature(calls)], caps(true)).unwrap();

    const first = runRenderFeatureFrame(host, [
      { identity: 'main', render: true, worlds: [], owner: 0, frameNumber: 1, caps: caps(true) },
    ]).frame;
    expect(first.stageEvents.map((event) => event.stage)).toEqual(['extract', 'plan']);

    host.setStatus(
      'synthetic.recoverable',
      'failed',
      new RenderFeatureStageFailedError('synthetic.recoverable', 0, 'prepare', 'next-frame'),
    );
    const retry = runRenderFeatureFrame(host, [
      { identity: 'main', render: true, worlds: [], owner: 0, frameNumber: 2, caps: caps(true) },
    ]).frame;
    expect(retry.errors).toEqual([]);
    expect(calls.slice(-2)).toEqual(['extract:2', 'plan:2']);

    host.setStatus('synthetic.recoverable', 'disabled');
    const skipped = runRenderFeatureFrame(host, [
      { identity: 'main', render: true, worlds: [], owner: 0, frameNumber: 3, caps: caps(true) },
    ]).frame;
    expect(skipped.stageEvents).toEqual([]);

    const recovered = host.recover({ frameNumber: 4, caps: caps(true) });
    expect(recovered).toEqual(ok(undefined));
    expect(calls.at(-1)).toBe('plan:2');

    const resumed = runRenderFeatureFrame(host, [
      { identity: 'main', render: true, worlds: [], owner: 0, frameNumber: 4, caps: caps(true) },
    ]).frame;
    expect(resumed.errors).toEqual([]);
    expect(resumed.stageEvents).toHaveLength(2);
  });

  it('keeps registration through a pipeline switch and makes dispose terminal', () => {
    const calls: string[] = [];
    const host = createRenderFeatureHost([recoverableFeature(calls)], caps(true)).unwrap();

    const beforeSwitch = host.features;
    const afterSwitch = host.features;
    expect(afterSwitch).toBeTruthy();
    expect(afterSwitch[0]?.identity).toBe(beforeSwitch[0]?.identity);

    expect(host.dispose()).toEqual(ok(undefined));
    expect(host.dispose()).toEqual(ok(undefined));
    const afterDispose = host.recover({ frameNumber: 1, caps: caps(true) });
    expect(afterDispose.ok).toBe(false);
    if (!afterDispose.ok && afterDispose.error.code === 'render-feature-stage-failed') {
      expect(afterDispose.error.code).toBe('render-feature-stage-failed');
      expect(afterDispose.error.detail.stage).toBe('recover');
    }
    expect(
      runRenderFeatureFrame(host, [
        { identity: 'main', render: true, worlds: [], owner: 0, frameNumber: 2, caps: caps(true) },
      ]).frame.stageEvents,
    ).toEqual([]);
    expect(calls).toEqual([]);
  });
});
