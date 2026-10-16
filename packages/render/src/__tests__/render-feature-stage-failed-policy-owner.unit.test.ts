import { describe, expect, expectTypeOf, it } from 'vitest';
import { type RenderError, RenderFeatureStageFailedError } from '../errors/render';
import type {
  RenderFeatureErrorDescriptor,
  RenderFeatureRecovery,
  RenderFeatureStage,
  RenderFeatureStageFailedDetail,
} from '../features/types';

const evidence = [
  {
    featureIdentity: 'synthetic.next-frame',
    order: 3,
    stage: 'prepare',
    recovery: 'next-frame',
    expected: "feature 'synthetic.next-frame' completes its prepare stage without an error",
    hint: "correct 'synthetic.next-frame' prepare data and retry on the next frame",
    message: "render feature 'synthetic.next-frame' failed during prepare",
  },
  {
    featureIdentity: 'synthetic.renderer-recover',
    order: 4,
    stage: 'record',
    recovery: 'renderer-recover',
    expected: "feature 'synthetic.renderer-recover' completes its record stage without an error",
    hint: "wait for renderer recovery before retrying 'synthetic.renderer-recover'",
    message: "render feature 'synthetic.renderer-recover' failed during record",
  },
  {
    featureIdentity: 'synthetic.registration',
    order: 5,
    stage: 'recover',
    recovery: 'registration',
    expected: "feature 'synthetic.registration' completes its recover stage without an error",
    hint: "correct 'synthetic.registration' registration before retrying",
    message: "render feature 'synthetic.registration' failed during recover",
  },
] as const satisfies readonly {
  readonly featureIdentity: string;
  readonly order: number;
  readonly stage: RenderFeatureStage;
  readonly recovery: RenderFeatureRecovery;
  readonly expected: string;
  readonly hint: string;
  readonly message: string;
}[];

describe('RenderFeatureStageFailedError policy ownership', () => {
  it('preserves every recovery diagnostic and its type correlation', () => {
    expect(evidence.map(({ recovery }) => recovery)).toEqual([
      'next-frame',
      'renderer-recover',
      'registration',
    ]);
    expect(new Set(evidence.map(({ recovery }) => recovery)).size).toBe(3);

    for (const row of evidence) {
      const error = new RenderFeatureStageFailedError(
        row.featureIdentity,
        row.order,
        row.stage,
        row.recovery,
      );

      expectTypeOf(error).toEqualTypeOf<
        Extract<RenderError, { readonly code: 'render-feature-stage-failed' }>
      >();
      expectTypeOf(error.detail).toEqualTypeOf<RenderFeatureStageFailedDetail>();
      expectTypeOf(error.detail.recovery).toEqualTypeOf<RenderFeatureRecovery>();
      expectTypeOf<
        Extract<RenderFeatureErrorDescriptor, { readonly code: 'render-feature-stage-failed' }>
      >().toMatchTypeOf<{
        readonly code: 'render-feature-stage-failed';
        readonly expected: string;
        readonly hint: string;
        readonly detail: RenderFeatureStageFailedDetail;
      }>();

      expect(error.code).toBe('render-feature-stage-failed');
      expect(error.expected).toBe(row.expected);
      expect(error.hint).toBe(row.hint);
      expect(error.message).toBe(row.message);
      expect(error.detail).toEqual({
        featureIdentity: row.featureIdentity,
        order: row.order,
        stage: row.stage,
        recovery: row.recovery,
      });
    }
  });

  it('preserves Error identity, stack, own-key order, and descriptors', () => {
    const error = new RenderFeatureStageFailedError(
      'synthetic.descriptors',
      6,
      'dispose',
      'renderer-recover',
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(RenderFeatureStageFailedError);
    expect(error.name).toBe('RenderFeatureStageFailedError');
    expect(typeof error.stack).toBe('string');
    expect(error.stack).toContain(`RenderFeatureStageFailedError: ${error.message}`);
    expect(Object.keys(error)).toEqual(['code', 'expected', 'hint', 'detail', 'name']);
    expect(Object.getOwnPropertyNames(error)).toEqual([
      'stack',
      'message',
      'code',
      'expected',
      'hint',
      'detail',
      'name',
    ]);

    const descriptors = Object.getOwnPropertyDescriptors(error);
    for (const field of ['code', 'expected', 'hint', 'detail', 'name'] as const) {
      expect(descriptors[field]).toEqual({
        value: error[field],
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    expect(descriptors.message).toMatchObject({
      configurable: true,
      enumerable: false,
      writable: true,
    });
    expect(descriptors.stack).toMatchObject({
      configurable: true,
      enumerable: false,
    });
    expect(typeof descriptors.stack?.get).toBe('function');
    expect(typeof descriptors.stack?.set).toBe('function');
  });
});
