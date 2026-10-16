import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { RenderFeatureStageFailedError } from '../errors/render';
import { createRenderFeatureHost, getRenderFeaturePlanExecutionProjection } from '../features/host';
import type { RenderFeature, RenderFeatureSubmission } from '../features/types';
import { runSingleViewFeatureFrame } from './single-view-feature-fixture';

function noWorkFeature(identity: string): RenderFeature<{ readonly empty: true }> {
  return {
    identity,
    extract: () => ok({ empty: true }),
    plan: () => ok({ work: [{ scope: { view: 'main' }, resources: [], passes: [] }] }),
  };
}

function failedFeature(identity: string): RenderFeature<{ readonly empty: true }> {
  return {
    identity,
    extract: () => err(new RenderFeatureStageFailedError(identity, 0, 'extract', 'next-frame')),
    plan: () => ok({ work: [{ scope: { view: 'main' }, resources: [], passes: [] }] }),
  };
}

describe('render feature zero-work boundaries', () => {
  it('keeps hidden draws in execution topology but only receipts submitted draws', () => {
    let submission: RenderFeatureSubmission | undefined;
    let mask: readonly boolean[] = [];
    let signature: string | undefined;
    const host = createRenderFeatureHost([
      {
        identity: 'masked.draws',
        extract: () => ok(undefined),
        plan: () =>
          ok({
            work: [
              {
                scope: { view: 'main' },
                resources: [
                  {
                    kind: 'graphics-program',
                    name: 'program',
                    program: { shader: 'draw', vertexLayout: 'none', colorFormats: ['rgba8unorm'] },
                  },
                  { kind: 'graphics-bindings', name: 'bindings', program: 'program', values: {} },
                ],
                passes: [
                  {
                    kind: 'raster',
                    name: 'draw',
                    colorAttachments: [{ target: 'swapchain', loadOp: 'load', storeOp: 'store' }],
                    draws: mask.map((enabled, index) => ({
                      enabled,
                      program: 'program',
                      bindings: ['bindings'],
                      vertexData: [],
                      vertexLayout: 'none',
                      draw: {
                        kind: 'draw',
                        vertexCount: 3,
                        instanceCount: 1,
                        firstVertex: index * 3,
                      },
                    })),
                  },
                ],
              },
            ],
          }),
        onFrameSubmitted: (_frame, receipt) => {
          submission = receipt;
        },
      },
    ]).unwrap();
    try {
      for (const [index, current] of [
        [true, true, true],
        [true, false, true],
        [true, true, true],
        [false, false, false],
        [true, false, true],
      ].entries()) {
        mask = current;
        const frame = runSingleViewFeatureFrame(host, {
          worlds: [],
          owner: 0,
          frameNumber: index + 1,
          caps: {} as never,
        });
        expect(frame.errors).toEqual([]);
        const planned = frame.plans[0];
        if (planned === undefined) throw new Error('Missing planned view');
        if (signature !== undefined) expect(planned.signature).toBe(signature);
        signature = planned.signature;
        const execution = getRenderFeaturePlanExecutionProjection(planned)?.passes[0];
        expect(execution?.graphics?.draws.map((draw) => draw.enabled)).toEqual(mask);
        frame.onSubmitted();
        const submitted = submission?.works[0]?.passes[0]?.graphics?.draws;
        expect(submitted).toHaveLength(mask.filter(Boolean).length);
        expect(submitted).toEqual(
          execution?.graphics?.draws.filter((draw) => draw.enabled !== false),
        );
        expect(execution?.graphics?.draws).toHaveLength(3);
      }
    } finally {
      host.dispose();
    }
  });
  it('acknowledges only submitted plans and never repeats an acknowledgment', () => {
    const submitted: number[] = [];
    const host = createRenderFeatureHost([
      {
        identity: 'synthetic.receipt',
        extract: (context) => ok(context.frameNumber),
        plan: () => ok({ work: [{ scope: { view: 'main' }, resources: [], passes: [] }] }),
        onFrameSubmitted: (frame: number) => {
          submitted.push(frame);
        },
      },
    ]).unwrap();
    const frame = (frameNumber: number) =>
      runSingleViewFeatureFrame(host, {
        worlds: [],
        owner: 0,
        frameNumber,
        caps: {} as never,
      });
    const rejected = frame(1);
    rejected.onAborted();
    const accepted = frame(2);
    expect(submitted).toEqual([]);
    accepted.onSubmitted();
    accepted.onSubmitted();
    expect(submitted).toEqual([2]);
    expect(rejected.plans).toHaveLength(1);
    host.dispose();
  });
  it('keeps an empty registry free of work, errors, and proxy noise', () => {
    const host = createRenderFeatureHost([]).unwrap();
    const result = runSingleViewFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 11,
      caps: {} as never,
    });

    expect(result.stageEvents).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.plans).toEqual([]);
  });

  it('keeps empty data and zero-pass features as an empty plan', () => {
    const host = createRenderFeatureHost([noWorkFeature('synthetic.empty')]).unwrap();
    const result = runSingleViewFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 12,
      caps: {} as never,
    });

    expect(result.errors).toEqual([]);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]?.plan).toEqual({ resources: [], passes: [] });
    expect(
      result.stageEvents.map(({ featureIdentity, stage }) => `${featureIdentity}:${stage}`),
    ).toEqual(['synthetic.empty:extract', 'synthetic.empty:plan']);
  });

  it('does not remove healthy work when one feature fails or is disabled', () => {
    const host = createRenderFeatureHost([
      failedFeature('synthetic.failed'),
      noWorkFeature('synthetic.healthy'),
      noWorkFeature('synthetic.disabled'),
    ]).unwrap();
    host.setStatus('synthetic.disabled', 'disabled');

    const result = runSingleViewFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 13,
      caps: {} as never,
    });

    expect(result.errors).toHaveLength(1);
    expect(
      result.stageEvents.map(({ featureIdentity, stage }) => `${featureIdentity}:${stage}`),
    ).toEqual(['synthetic.failed:extract', 'synthetic.healthy:extract', 'synthetic.healthy:plan']);
    expect(result.plans).toHaveLength(1);
  });
});
