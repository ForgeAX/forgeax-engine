import type { RhiCaps } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  type RenderError,
  RenderFeatureDrawRecordingFailedError,
  RenderFeaturePreparationFailedError,
  RenderFeatureStageFailedError,
} from '../errors/render';
import { createRenderFeatureHost, type RenderFeatureHost } from '../features/host';
import type { RenderFeature } from '../features/types';
import { runSingleViewFeatureFrame } from './single-view-feature-fixture';

const caps = { backendKind: 'null' } as unknown as Readonly<RhiCaps>;

type Fault = 'create' | 'prepared-resource' | 'draw-recording';

function healthyFeature(probe: { plan: number }): RenderFeature<{
  readonly ready: true;
}> {
  return {
    identity: 'synthetic.m10.healthy',
    extract: () => ok({ ready: true }),
    plan: () => {
      probe.plan += 1;
      return ok({ work: [{ scope: { view: 'main' }, resources: [], passes: [] }] });
    },
  };
}

function faultyFeature(
  fault: Fault,
  probe: { plan: number },
): { readonly feature: RenderFeature<{ readonly ready: true }>; readonly repair: () => void } {
  let repaired = false;
  const identity = `synthetic.m10.${fault}`;
  const failure = (): RenderError => {
    switch (fault) {
      case 'create':
        return new RenderFeatureStageFailedError(identity, 1, 'plan', 'next-frame');
      case 'prepared-resource':
        return new RenderFeaturePreparationFailedError(
          identity,
          1,
          'planVertexData',
          'vertex-data',
          `${identity}::triangle`,
          'backend-upload-failed',
          'next-frame',
        );
      case 'draw-recording':
        return new RenderFeatureDrawRecordingFailedError(
          identity,
          1,
          'planDraw',
          'vertex-data',
          'backend-recording-failed',
          'synthetic backend rejected setVertexBuffer',
          'next-frame',
        );
    }
  };
  return {
    feature: {
      identity,
      extract: () => ok({ ready: true }),
      plan: () => {
        probe.plan += 1;
        if (!repaired) return err(failure());
        return ok({ work: [{ scope: { view: 'main' }, resources: [], passes: [] }] });
      },
    },
    repair: () => {
      repaired = true;
    },
  };
}

function frame(host: RenderFeatureHost, frameNumber: number) {
  return runSingleViewFeatureFrame(host, {
    worlds: [],
    owner: 0,
    frameNumber,
    caps,
  });
}

describe('RenderFeature stage fault recovery lifecycle', () => {
  it('retains the original exception when a feature stage throws', () => {
    const cause = new TypeError('feature plan exploded');
    const host = createRenderFeatureHost(
      [
        {
          identity: 'synthetic.m10.throwing',
          extract: () => ok({ ready: true }),
          plan: () => {
            throw cause;
          },
        },
      ],
      caps,
    ).unwrap();

    const result = frame(host, 1);
    expect(result.errors[0]).toMatchObject({
      code: 'render-feature-stage-failed',
      detail: { featureIdentity: 'synthetic.m10.throwing', cause },
    });
    expect(host.diagnostics()[0]?.latestError).toMatchObject({ detail: { cause } });
  });

  it.each<Fault>([
    'create',
    'prepared-resource',
    'draw-recording',
  ])('keeps a healthy sibling visible and clears feature-local %s diagnostics after repair', (fault) => {
    const healthyProbe = { plan: 0 };
    const faultyProbe = { plan: 0 };
    const faulty = faultyFeature(fault, faultyProbe);
    const healthy = healthyFeature(healthyProbe);
    const host = createRenderFeatureHost([healthy, faulty.feature], caps).unwrap();
    const first = frame(host, 1);
    const firstError = first.errors.find((error) => {
      switch (error.code) {
        case 'render-feature-stage-failed':
        case 'render-feature-preparation-failed':
        case 'render-feature-draw-recording-failed':
          return error.detail.featureIdentity.includes(fault);
        default:
          return false;
      }
    });
    expect(firstError).toBeDefined();
    expect(firstError).toMatchObject({
      code:
        fault === 'create'
          ? 'render-feature-stage-failed'
          : fault === 'prepared-resource'
            ? 'render-feature-preparation-failed'
            : 'render-feature-draw-recording-failed',
      detail: { featureIdentity: `synthetic.m10.${fault}`, order: 1 },
    });
    expect(firstError?.hint.length).toBeGreaterThan(0);
    expect(first.plans.map((entry) => entry.featureIdentity)).toEqual(['synthetic.m10.healthy']);
    expect(host.diagnostics().map((entry) => entry.status)).toEqual(['active', 'failed']);
    expect(host.diagnostics()[1]?.latestError).toMatchObject({
      detail: { featureIdentity: `synthetic.m10.${fault}` },
    });

    faulty.repair();
    const second = frame(host, 2);
    expect(second.errors).toEqual([]);
    expect(second.plans.map((entry) => entry.featureIdentity)).toEqual([
      'synthetic.m10.healthy',
      `synthetic.m10.${fault}`,
    ]);
    expect(host.diagnostics().map((entry) => entry.status)).toEqual(['active', 'active']);
    expect(host.diagnostics()[1]?.latestError).toBeUndefined();
    expect(healthyProbe.plan).toBe(2);
    expect(faultyProbe.plan).toBe(2);

    expect(host.dispose()).toEqual(ok(undefined));
    expect(host.dispose()).toEqual(ok(undefined));
    expect(host.diagnostics().map((entry) => entry.status)).toEqual(['disposed', 'disposed']);
  });
});
