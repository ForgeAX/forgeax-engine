import type { RhiCaps } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { RenderFeatureStageFailedError } from '../errors/render';
import { createRenderFeatureHost } from '../features/host';
import type { RenderFeature } from '../features/types';
import { runSingleViewFeatureFrame } from './single-view-feature-fixture';

const caps = (compute: boolean): Readonly<RhiCaps> =>
  ({ backendKind: 'null', compute }) as unknown as RhiCaps;

function feature(mode: 'healthy' | 'failed'): RenderFeature<{ readonly ready: true }> {
  return {
    identity: `synthetic.diagnostics.${mode}`,
    requiredCapabilities: ['compute'],
    extract: () => ok({ ready: true }),
    plan: () =>
      mode === 'failed'
        ? err(
            new RenderFeatureStageFailedError(
              `synthetic.diagnostics.${mode}`,
              0,
              'plan',
              'next-frame',
            ),
          )
        : ok({
            work: [
              {
                scope: { view: 'main' },
                resources: [
                  {
                    kind: 'fullscreen-program' as const,
                    name: 'synthetic.diagnostics.program',
                    source: 'synthetic',
                  },
                ],
                passes: [],
              },
            ],
          }),
  };
}

describe('render feature prepared diagnostics', () => {
  it('projects disabled and failed states with code-directed recovery data', () => {
    const disabledHost = createRenderFeatureHost([feature('healthy')]).unwrap();
    runSingleViewFeatureFrame(disabledHost, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      caps: caps(false),
    });
    const disabled = disabledHost.diagnostics()[0];
    expect(disabled).toMatchObject({
      status: 'disabled',
      latestError: {
        code: 'render-feature-capability-missing',
        detail: { capability: 'compute' },
      },
    });
    expect(disabled?.latestError?.expected).toContain('compute');
    expect(disabled?.latestError?.hint).toContain('disable');

    const failedHost = createRenderFeatureHost([feature('failed')]).unwrap();
    runSingleViewFeatureFrame(failedHost, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      caps: caps(true),
    });
    const failed = failedHost.diagnostics()[0];
    expect(failed).toMatchObject({
      status: 'failed',
      latestError: {
        code: 'render-feature-stage-failed',
        detail: { stage: 'plan', recovery: 'next-frame' },
      },
    });
    expect(failed?.latestError?.hint).toContain('next frame');
  });

  it('makes disposed diagnostics terminal and keeps repeated lifecycle calls side-effect free', () => {
    const host = createRenderFeatureHost([feature('healthy')]).unwrap();
    expect(host.recover({ frameNumber: 2, caps: caps(true) })).toEqual(ok(undefined));
    expect(host.recover({ frameNumber: 2, caps: caps(true) })).toEqual(ok(undefined));

    expect(host.dispose()).toEqual(ok(undefined));
    expect(host.dispose()).toEqual(ok(undefined));
    const diagnostics = host.diagnostics()[0];
    expect(diagnostics).toMatchObject({
      identity: 'synthetic.diagnostics.healthy',
      status: 'disposed',
    });
    const recoverAfterDispose = host.recover({ frameNumber: 3, caps: caps(true) });
    expect(recoverAfterDispose.ok).toBe(false);
    if (!recoverAfterDispose.ok) {
      expect(recoverAfterDispose.error).toMatchObject({
        code: 'render-feature-stage-failed',
        detail: { stage: 'recover', recovery: 'registration' },
      });
      expect(recoverAfterDispose.error.hint).toContain('registration');
    }
  });
});
