import { describe, expect, it } from 'vitest';
import {
  admitSsrM0,
  projectSsrDependencies,
  SSR_FORMAT_STAGES,
  type SsrAdmissionIdentity,
  type SsrFormatReceipt,
  type SsrReflectionFallbackReceipt,
} from '../ssr/admission';

const identity: SsrAdmissionIdentity = {
  sourceHead: 'head',
  sourceTree: 'tree',
  lockSha256: 'lock',
  buildSha256: 'build',
};

const reflectionFallback = {
  identity,
  source: 'probe' as const,
  sourceGeneration: 4,
  projectionGeneration: 4,
  deviceGeneration: 2,
  state: 'active' as const,
  candidateVisible: false as const,
  coverage: 1,
  brdfSignature: 'standard-pbr-ibl-v1',
} satisfies SsrReflectionFallbackReceipt;

const format = {
  identity,
  profile: 'r32float-mip-sampled-storage' as const,
  verdict: 'admitted' as const,
  evidence: 'real' as const,
  stages: SSR_FORMAT_STAGES.map((stage) => ({
    stage,
    verdict: 'admitted' as const,
    evidence: 'real' as const,
  })),
  deviceGeneration: 2,
  sampleType: 'unfilterable-float' as const,
  usages: ['texture-binding', 'storage-binding', 'copy-src'] as const,
  readback: { byteLength: 4, values: [1] },
  probeExecutions: 1,
} satisfies SsrFormatReceipt;

const temporal = {
  identity,
  successfulSubmit: true as const,
  generation: 4,
};

describe('SSR M0 admission matrix', () => {
  it('keeps an unrequested unbound renderer on the ordinary zero-work path', () => {
    const result = projectSsrDependencies({
      requested: false,
      identity: undefined,
      reflectionFallback: undefined,
      format: undefined,
      temporal: undefined,
    });
    expect(result.status).toBe('fallback-only');
    expect(result.failure?.code).toBe('ssr-not-requested');
    expect(result.work.temporalDemand).toBe(0);
  });

  it('keeps unrequested SSR at fallback-only with exact zero work', () => {
    const result = admitSsrM0({ requested: false, identity });
    expect(result.status).toBe('fallback-only');
    expect(result.work).toEqual({
      attachmentCount: 0,
      passCount: 0,
      bindingCount: 0,
      resourceCount: 0,
      historyCount: 0,
      temporalDemand: 0,
    });
  });

  it.each([
    ['producer', { format, temporal }, 'rebuild'],
    ['format', { reflectionFallback, temporal }, 'retry'],
  ] as const)('blocks when the %s receipt is absent', (_, receipts, action) => {
    const result = admitSsrM0({ requested: true, identity, ...receipts });
    expect(result.status).toBe('fallback-only');
    expect(result.work.temporalDemand).toBe(0);
    expect(result.failure?.detail.action).toBe(action);
  });

  it('admits fresh spatial SSR before any temporal history has been submitted', () => {
    const result = admitSsrM0({ requested: true, identity, reflectionFallback, format });
    expect(result.status).toBe('admitted');
    expect(result.work.historyCount).toBe(0);
    expect(result.work.temporalDemand).toBe(0);
  });

  it('publishes a typed owner recovery action on every blocked path', () => {
    const notRequested = admitSsrM0({ requested: false, identity });
    expect(notRequested.failure?.detail.action).toBe('retry');

    const mismatched = admitSsrM0({
      requested: true,
      identity,
      reflectionFallback: {
        ...reflectionFallback,
        identity: { ...identity, sourceHead: 'old-head' },
      },
      format,
      temporal,
    });
    expect(mismatched.failure?.detail).toMatchObject({
      owner: 'producer',
      action: 'rebuild',
      identityField: 'sourceHead',
    });

    const stale = admitSsrM0({
      requested: true,
      identity,
      reflectionFallback,
      format,
      temporal,
      previousGeneration: reflectionFallback.projectionGeneration + 1,
    });
    expect(stale.failure?.detail.action).toBe('retry');
  });

  it('rejects malformed coverage or extent without creating SSR work', () => {
    const malformed = admitSsrM0({
      requested: true,
      identity,
      reflectionFallback: {
        ...reflectionFallback,
        coverage: 2,
        extent: [0, 1, 1],
      },
      format,
      temporal,
    });
    expect(malformed.status).toBe('fallback-only');
    expect(malformed.failure?.code).toBe('ssr-reflection-fallback-unavailable');
    expect(malformed.work).toEqual({
      attachmentCount: 0,
      passCount: 0,
      bindingCount: 0,
      resourceCount: 0,
      historyCount: 0,
      temporalDemand: 0,
    });
  });

  it('blocks structural-only format evidence and every identity mismatch', () => {
    const structuralOnly = {
      ...format,
      verdict: 'structural-only' as const,
    };
    const blocked = admitSsrM0({
      requested: true,
      identity,
      reflectionFallback,
      format: structuralOnly,
      temporal,
    });
    expect(blocked.status).toBe('fallback-only');

    const structuralReceipt = {
      ...format,
      evidence: 'structural' as const,
    };
    const structuralBlocked = admitSsrM0({
      requested: true,
      identity,
      reflectionFallback,
      format: structuralReceipt,
      temporal,
    });
    expect(structuralBlocked.status).toBe('fallback-only');

    for (const field of Object.keys(identity) as (keyof SsrAdmissionIdentity)[]) {
      const mismatched = admitSsrM0({
        requested: true,
        identity,
        reflectionFallback: {
          ...reflectionFallback,
          identity: { ...identity, [field]: `old-${field}` },
        },
        format,
        temporal,
      });
      expect(mismatched.status, field).toBe('fallback-only');
    }
  });

  it('admits only three matching receipts and reports nonzero work', () => {
    const result = admitSsrM0({
      requested: true,
      identity,
      reflectionFallback,
      format,
      temporal,
    });
    expect(result.status).toBe('admitted');
    expect(result.work).toEqual({
      attachmentCount: 1,
      passCount: 1,
      bindingCount: 1,
      resourceCount: 1,
      historyCount: 0,
      temporalDemand: 0,
    });
  });
});
