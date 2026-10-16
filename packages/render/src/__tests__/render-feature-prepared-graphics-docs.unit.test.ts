import type { RenderFeature, RenderFeatureErrorDescriptor } from '@forgeax/engine-render';
import { ok } from '@forgeax/engine-types';
import { describe, expect, expectTypeOf, it } from 'vitest';

type PreparedFrame = {
  readonly items: readonly unknown[];
};

function describeRenderFeatureError(error: RenderFeatureErrorDescriptor): string {
  switch (error.code) {
    case 'render-feature-registration-conflict':
      return `${error.detail.featureIdentity}:${error.detail.conflictingOrder}`;
    case 'render-feature-stage-failed':
      return `${error.detail.featureIdentity}:${error.detail.stage}:${error.detail.recovery}`;
    case 'render-feature-capability-missing':
      return `${error.detail.featureIdentity}:${error.detail.capability}`;
    case 'render-feature-pass-order-conflict':
      return `${error.detail.passIdentity}:${error.detail.dependencyIdentity}`;
    case 'render-feature-preparation-failed':
      return `${error.detail.resourceKind}:${error.detail.resourceName}`;
    case 'render-feature-prepared-state-mismatch':
      switch (error.detail.reason) {
        case 'missing-prepared-state':
          return `${error.detail.resourceKind}:${error.detail.missingResource}`;
        case 'foreign-feature':
          return `${error.detail.expectedFeatureIdentity}:${error.detail.actualFeatureIdentity}`;
        case 'foreign-kind':
          return `${error.detail.expectedKind}:${error.detail.actualKind}`;
        case 'generation-mismatch':
          return `${error.detail.expectedGeneration}:${error.detail.actualGeneration}`;
        case 'layout-mismatch':
          return `${error.detail.expectedLayout}:${error.detail.actualLayout}`;
        case 'format-mismatch':
          return `${error.detail.expectedFormat}:${error.detail.actualFormat}`;
      }
      break;
    case 'render-feature-draw-recording-failed':
      return `${error.detail.resourceKind}:${error.detail.backendReason}`;
  }
}

function publicPreparedRecipe(frame: PreparedFrame): RenderFeature<PreparedFrame> {
  const feature: RenderFeature<PreparedFrame> = {
    identity: 'docs.prepared-graphics',
    extract: () => ok(frame),
    plan: (data) => {
      void data.items.length;
      return ok({ work: [{ scope: 'frame', resources: [], passes: [] }] });
    },
  };
  return feature;
}

describe('public prepared graphics recipe', () => {
  it('keeps the public imports and callback inference type-safe', () => {
    const frame: PreparedFrame = { items: [] };
    expectTypeOf(publicPreparedRecipe).parameter(0).toMatchTypeOf<PreparedFrame>();
    expectTypeOf(publicPreparedRecipe).returns.toMatchTypeOf<RenderFeature<PreparedFrame>>();
    expect(typeof publicPreparedRecipe).toBe('function');
    expect(frame.items).toHaveLength(0);
  });

  it('keeps structured error fields available without message parsing', () => {
    const error: RenderFeatureErrorDescriptor = {
      code: 'render-feature-stage-failed',
      expected: "feature 'docs.prepared-graphics' completes its plan stage without an error",
      hint: "correct 'docs.prepared-graphics' plan data and retry on the next frame",
      detail: {
        featureIdentity: 'docs.prepared-graphics',
        order: 0,
        stage: 'plan',
        recovery: 'next-frame',
      },
    };
    expect(describeRenderFeatureError(error)).toBe('docs.prepared-graphics:plan:next-frame');
    expect(error.expected).toContain('plan');
    expect(error.hint).toContain('next frame');
    expect(error.detail.recovery).toBe('next-frame');
  });
});
