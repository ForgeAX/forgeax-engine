import type { RhiCaps } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { RenderFeatureStageFailedError } from '../errors/render';
import { createRenderFeatureHost } from '../features/host';
import type { RenderFeature } from '../features/types';
import { runSingleViewFeatureFrame } from './single-view-feature-fixture';

const caps = (compute: boolean): Readonly<RhiCaps> => ({ compute }) as unknown as RhiCaps;

describe('render feature retry rules', () => {
  it('recovers an empty optional feature and gates its next active plan on the replacement capabilities', () => {
    let enabled = false;
    const feature: RenderFeature<undefined> = {
      identity: 'synthetic.optional',
      requiredCapabilities: ['compute'],
      extract: () => ok(undefined),
      plan: () =>
        ok({
          work: [
            {
              scope: 'frame',
              resources: enabled
                ? [
                    {
                      kind: 'fullscreen-program',
                      name: 'optional.program',
                      source: 'synthetic',
                    },
                  ]
                : [],
              passes: [],
            },
          ],
        }),
    };
    const host = createRenderFeatureHost([feature], caps(false)).unwrap();
    const frame = (frameNumber: number) =>
      runSingleViewFeatureFrame(host, {
        worlds: [],
        owner: 0,
        frameNumber,
        caps: caps(false),
      });
    expect(frame(1).errors).toEqual([]);
    expect(host.recover({ frameNumber: 2, caps: caps(false) })).toEqual(ok(undefined));
    expect(frame(2).errors).toEqual([]);
    enabled = true;
    expect(frame(3).errors.map((error) => error.code)).toEqual([
      'render-feature-capability-missing',
    ]);
    enabled = false;
    expect(host.recover({ frameNumber: 4, caps: caps(false) })).toEqual(ok(undefined));
    expect(frame(4).errors).toEqual([]);
    expect(host.diagnostics()[0]?.latestError).toBeUndefined();
  });

  it('retries ordinary failures on the next frame and keeps latest error structured', () => {
    let attempts = 0;
    const feature: RenderFeature<{ readonly frame: number }> = {
      identity: 'synthetic.retry',
      extract: ({ frameNumber }) => ok({ frame: frameNumber }),
      plan: () => {
        attempts += 1;
        if (attempts === 1) {
          return err(new RenderFeatureStageFailedError('synthetic.retry', 0, 'plan', 'next-frame'));
        }
        return ok({ work: [{ scope: { view: 'main' }, resources: [], passes: [] }] });
      },
    };
    const host = createRenderFeatureHost([feature], caps(true)).unwrap();

    const failed = runSingleViewFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      caps: caps(true),
    });
    const error = failed.errors[0];
    expect(error?.code).toBe('render-feature-stage-failed');
    if (error?.code === 'render-feature-stage-failed') {
      expect(error.detail).toMatchObject({
        featureIdentity: 'synthetic.retry',
        stage: 'plan',
        recovery: 'next-frame',
      });
    }

    const retried = runSingleViewFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 2,
      caps: caps(true),
    });
    expect(retried.errors).toEqual([]);
    expect(host.diagnostics()[0]?.latestError).toBeUndefined();
    expect(host.diagnostics()[0]?.status).toBe('active');
  });

  it('does not retry a disabled feature until recover makes its capability available', () => {
    const feature: RenderFeature<{ readonly frame: number }> = {
      identity: 'synthetic.capability-retry',
      requiredCapabilities: ['compute'],
      extract: ({ frameNumber }) => ok({ frame: frameNumber }),
      plan: () =>
        ok({
          work: [
            {
              scope: { view: 'main' },
              resources: [
                {
                  kind: 'fullscreen-program' as const,
                  name: 'synthetic.capability-retry.program',
                  source: 'synthetic',
                },
              ],
              passes: [],
            },
          ],
        }),
    };
    const host = createRenderFeatureHost([feature], caps(false)).unwrap();

    runSingleViewFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      caps: caps(false),
    });
    expect(host.diagnostics()[0]?.status).toBe('disabled');
    expect(
      runSingleViewFeatureFrame(host, {
        worlds: [],
        owner: 0,
        frameNumber: 2,
        caps: caps(true),
      }).stageEvents,
    ).toEqual([]);

    expect(host.recover({ frameNumber: 3, caps: caps(true) })).toEqual(ok(undefined));
    expect(
      runSingleViewFeatureFrame(host, {
        worlds: [],
        owner: 0,
        frameNumber: 3,
        caps: caps(true),
      }).stageEvents,
    ).toHaveLength(2);
  });
});
