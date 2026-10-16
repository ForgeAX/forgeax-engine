import type { RhiCaps } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { RenderFeatureStageFailedError } from '../errors/render';
import { createRenderFeatureHost } from '../features/host';
import type { RenderFeature } from '../features/types';
import { runSingleViewFeatureFrame } from './single-view-feature-fixture';

const caps = (compute: boolean): Readonly<RhiCaps> => ({ compute }) as unknown as RhiCaps;

function gatedFeature(): RenderFeature<{ readonly frame: number }> {
  return {
    identity: 'synthetic.gated',
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
                name: 'synthetic.gated.program',
                source: 'synthetic',
              },
            ],
            passes: [],
          },
        ],
      }),
  };
}

describe('render feature diagnostics and capability gate', () => {
  it('notifies only lifecycle projection changes and stops after unsubscribe', () => {
    const host = createRenderFeatureHost([gatedFeature()], caps(true)).unwrap();
    let notifications = 0;
    const unsubscribe = host.subscribeDiagnostics(() => {
      notifications += 1;
    });

    expect(host.setStatus('synthetic.gated', 'active')).toEqual(ok(undefined));
    expect(notifications).toBe(0);

    expect(host.setStatus('synthetic.gated', 'disabled')).toEqual(ok(undefined));
    expect(notifications).toBe(1);
    expect(host.setStatus('synthetic.gated', 'active')).toEqual(ok(undefined));
    expect(notifications).toBe(2);

    unsubscribe();
    expect(host.setStatus('synthetic.gated', 'disabled')).toEqual(ok(undefined));
    expect(notifications).toBe(2);
  });

  it('isolates a throwing diagnostics observer from renderer lifecycle changes', () => {
    const host = createRenderFeatureHost([gatedFeature()], caps(true)).unwrap();
    let healthyNotifications = 0;
    host.subscribeDiagnostics(() => {
      throw new Error('observer failed');
    });
    host.subscribeDiagnostics(() => {
      healthyNotifications += 1;
    });

    expect(host.setStatus('synthetic.gated', 'disabled')).toEqual(ok(undefined));
    expect(host.diagnostics()[0]?.status).toBe('disabled');
    expect(healthyNotifications).toBe(1);
    expect(() => host.dispose()).not.toThrow();
  });

  it('installs a late feature once and keeps identity conflicts explicit', () => {
    const host = createRenderFeatureHost([], caps(true)).unwrap();
    const feature = gatedFeature();
    expect(host.install(feature)).toEqual(ok(undefined));
    expect(host.install(feature)).toEqual(ok(undefined));
    expect(host.size).toBe(1);
    expect(host.install(gatedFeature())).toMatchObject({
      ok: false,
      error: { code: 'render-feature-registration-conflict' },
    });
    expect(
      runSingleViewFeatureFrame(host, {
        worlds: [],
        owner: 0,
        frameNumber: 1,
        caps: caps(true),
      }).stageEvents,
    ).toHaveLength(2);
  });

  it('disables without a capability and re-enables only after recover re-evaluation', () => {
    const host = createRenderFeatureHost([gatedFeature()], caps(false)).unwrap();
    const first = runSingleViewFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      caps: caps(false),
    });

    expect(first.stageEvents).toEqual([
      { featureIdentity: 'synthetic.gated', order: 0, stage: 'extract' },
      { featureIdentity: 'synthetic.gated', order: 0, stage: 'plan' },
    ]);
    expect(first.errors).toHaveLength(1);
    expect(first.errors[0]?.code).toBe('render-feature-capability-missing');
    expect(host.diagnostics()[0]?.status).toBe('disabled');

    const stillDisabled = runSingleViewFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 2,
      caps: caps(true),
    });
    expect(stillDisabled.stageEvents).toEqual([]);

    expect(host.recover({ frameNumber: 3, caps: caps(true) })).toEqual(ok(undefined));
    expect(host.diagnostics()[0]?.status).toBe('active');
    expect(
      runSingleViewFeatureFrame(host, {
        worlds: [],
        owner: 0,
        frameNumber: 3,
        caps: caps(true),
      }).stageEvents,
    ).toHaveLength(2);
  });

  it('replaces the latest stage failure after retry and returns deep readonly snapshots', () => {
    let shouldFail = true;
    const feature: RenderFeature<{ readonly ready: true }> = {
      identity: 'synthetic.latest-error',
      extract: () => ok({ ready: true }),
      plan: () => {
        if (shouldFail) {
          return err(
            new RenderFeatureStageFailedError('synthetic.latest-error', 0, 'plan', 'next-frame'),
          );
        }
        return ok({ work: [{ scope: { view: 'main' }, resources: [], passes: [] }] });
      },
    };
    const host = createRenderFeatureHost([feature], caps(true)).unwrap();

    runSingleViewFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      caps: caps(true),
    });
    const failed = host.diagnostics();
    expect(failed[0]?.latestError?.code).toBe('render-feature-stage-failed');
    expect(Object.isFrozen(failed)).toBe(true);
    expect(Object.isFrozen(failed[0])).toBe(true);
    expect(Object.isFrozen(failed[0]?.latestError)).toBe(true);
    expect(Object.isFrozen(failed[0]?.latestError?.detail)).toBe(true);

    shouldFail = false;
    runSingleViewFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 2,
      caps: caps(true),
    });
    expect(host.diagnostics()[0]?.status).toBe('active');
    expect(host.diagnostics()[0]?.latestError).toBeUndefined();
  });
});
