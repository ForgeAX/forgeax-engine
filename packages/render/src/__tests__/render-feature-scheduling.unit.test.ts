import type { RhiCaps } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { RenderFeatureStageFailedError } from '../errors/render';
import { createRenderFeatureHost } from '../features/host';
import type { RenderFeature } from '../features/types';
import { runSingleViewFeatureFrame } from './single-view-feature-fixture';

const caps = {
  backendKind: 'null',
  compute: true,
  timestampQuery: true,
  timestampPeriodNanoseconds: null,
  indirectDrawing: true,
  textureCompressionBc: false,
  textureCompressionEtc2: false,
  textureCompressionAstc: false,
  multiDrawIndirect: false,
  pushConstants: false,
  textureBindingArray: false,
  samplerAliasing: true,
  firstInstanceIndirect: true,
  storageBuffer: true,
  storageTexture: true,
  rgba16floatRenderable: true,
  rg11b10ufloatRenderable: true,
  float32Filterable: true,
  textureImport: false,
  externalTexture: false,
  maxColorAttachments: 8,
  rayQuery: { supported: false, reason: 'backend-has-no-ray-query' },
} satisfies RhiCaps;

function feature(identity: string, events: string[], failStage?: 'extract' | 'plan') {
  const value = { identity };
  return {
    identity,
    extract: () => {
      events.push(`${identity}:extract`);
      return failStage === 'extract'
        ? err(new RenderFeatureStageFailedError(identity, 0, 'extract', 'next-frame'))
        : ok(value);
    },
    plan: () => {
      events.push(`${identity}:plan`);
      return failStage === 'plan'
        ? err(new RenderFeatureStageFailedError(identity, 0, 'plan', 'next-frame'))
        : ok({ work: [{ scope: { view: 'main' }, resources: [], passes: [] }] });
    },
  } satisfies RenderFeature<typeof value>;
}

describe('render feature stage scheduling', () => {
  it('runs each feature once in registration and stage order', () => {
    const events: string[] = [];
    const host = createRenderFeatureHost([
      feature('synthetic.first', events),
      feature('synthetic.second', events),
    ]).unwrap();

    const result = runSingleViewFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 7,
      caps,
    });

    expect(
      result.stageEvents.map(({ featureIdentity, stage }) => `${featureIdentity}:${stage}`),
    ).toEqual([
      'synthetic.first:extract',
      'synthetic.first:plan',
      'synthetic.second:extract',
      'synthetic.second:plan',
    ]);
  });

  it('retains fixed stage facts and replaces only reordered installation facts', () => {
    const events: string[] = [];
    const first = feature('synthetic.first', events);
    const second = feature('synthetic.second', events);
    const host = createRenderFeatureHost([first, second]).unwrap();
    const frame = (frameNumber: number) =>
      runSingleViewFeatureFrame(host, { worlds: [], owner: 0, frameNumber, caps });
    try {
      const before = frame(1);
      const next = frame(2);
      expect(next.stageEvents).not.toBe(before.stageEvents);
      for (let index = 0; index < before.stageEvents.length; index++) {
        expect(next.stageEvents[index]).toBe(before.stageEvents[index]);
        expect(Object.isFrozen(next.stageEvents[index])).toBe(true);
      }
      host.uninstall(first).unwrap();
      const reordered = frame(3);
      expect(reordered.stageEvents).toEqual([
        { featureIdentity: second.identity, order: 0, stage: 'extract' },
        { featureIdentity: second.identity, order: 0, stage: 'plan' },
      ]);
      expect(reordered.stageEvents[0]).not.toBe(before.stageEvents[2]);
      expect(before.stageEvents[2]?.order).toBe(1);
      const stable = frame(4);
      expect(stable.stageEvents[0]).toBe(reordered.stageEvents[0]);
      expect(stable.stageEvents[1]).toBe(reordered.stageEvents[1]);
    } finally {
      host.dispose();
    }
  });

  it.each([
    'extract',
    'plan',
  ] as const)('isolates a %s failure from the healthy feature', (failStage) => {
    const events: string[] = [];
    const host = createRenderFeatureHost([
      feature('synthetic.failed', events, failStage),
      feature('synthetic.healthy', events),
    ]).unwrap();

    const result = runSingleViewFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 8,
      caps,
    });

    expect(result.errors).toHaveLength(1);
    const error = result.errors[0];
    expect(error?.code).toBe('render-feature-stage-failed');
    if (error?.code === 'render-feature-stage-failed') {
      expect(error.detail).toMatchObject({
        featureIdentity: 'synthetic.failed',
        stage: failStage,
      });
    }
    expect(events).toContain('synthetic.healthy:extract');
    expect(events).toContain('synthetic.healthy:plan');
    const failedEvents = events.filter((event) => event.startsWith('synthetic.failed:'));
    const failedStageIndex = ['extract', 'plan'].indexOf(failStage);
    expect(failedEvents).toEqual(
      ['extract', 'plan']
        .slice(0, failedStageIndex + 1)
        .map((stage) => `synthetic.failed:${stage}`),
    );
  });
});
