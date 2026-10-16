import { describe, expect, it } from 'vitest';
import type { ReflectionFallbackReceipt } from '../inspection-types';
import { inspectReflectionFallback } from '../reflection/inspection';

function receipt(
  source: ReflectionFallbackReceipt['source'],
  state: ReflectionFallbackReceipt['state'],
): ReflectionFallbackReceipt {
  return {
    rendererId: 'renderer:test',
    producerId: 'producer:test',
    renderableKey: '0:1',
    sourceKey: source,
    frameId: 7,
    source,
    sourceGeneration: 2,
    projectionGeneration: 3,
    deviceGeneration: 1,
    state,
    candidateVisible: false,
    coverage: source === 'neutral' ? 0 : 1,
    brdfSignature: 'standard-pbr-ibl-v1',
  };
}

describe('reflection fallback inspection', () => {
  it('routes an active probe failure to its compatible LKG', () => {
    const result = inspectReflectionFallback(receipt('probe', 'active'), {
      stage: 'completion',
      code: 'reflection-fallback-readback-failed',
      expected: 'mapped readback',
      detail: { frameId: 7 },
    });
    expect(result.recoveryAction).toBe('use-LKG');
    expect(result.failureStage).toBe('completion');
    expect(result.failureCode).toBe('reflection-fallback-readback-failed');
    expect(result.detail).toEqual({ frameId: 7 });
  });

  it('routes Skylight and neutral receipts without exposing live resources', () => {
    expect(inspectReflectionFallback(receipt('probe', 'lkg')).recoveryAction).toBe('use-LKG');
    expect(inspectReflectionFallback(receipt('skylight', 'lkg')).recoveryAction).toBe(
      'use-Skylight',
    );
    expect(inspectReflectionFallback(receipt('neutral', 'neutral')).recoveryAction).toBe(
      'use-neutral',
    );
    expect(JSON.stringify(inspectReflectionFallback(receipt('probe', 'active')))).not.toMatch(
      /texture|view|handle/i,
    );
  });

  it('derives recapture, rebuild, and retry from producer failure stage/code', () => {
    const current = receipt('probe', 'active');
    expect(
      inspectReflectionFallback(current, {
        stage: 'prepare',
        code: 'reflection-fallback-source-invalid',
        expected: 'valid source',
      }).recoveryAction,
    ).toBe('recapture');
    expect(
      inspectReflectionFallback(current, {
        stage: 'build',
        code: 'reflection-fallback-format-unavailable',
        expected: 'buildable format',
      }).recoveryAction,
    ).toBe('rebuild');
    expect(
      inspectReflectionFallback(current, {
        stage: 'submit',
        code: 'reflection-fallback-submit-failed',
        expected: 'successful submit',
      }).recoveryAction,
    ).toBe('retry');
  });
});
