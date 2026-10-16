import { describe, expect, it } from 'vitest';
import {
  admitSsrM0,
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

const unavailable = () => admitSsrM0({ requested: true, identity });

describe('SSR fallback zero-work budget', () => {
  it('keeps unavailable and unrequested paths at exact zero work', () => {
    for (const result of [admitSsrM0({ requested: false, identity }), unavailable()]) {
      expect(result.status).toBe('fallback-only');
      expect(result.work).toEqual({
        attachmentCount: 0,
        passCount: 0,
        bindingCount: 0,
        resourceCount: 0,
        historyCount: 0,
        temporalDemand: 0,
      });
      expect(result.budget).toEqual({
        probeExecutions: 0,
        resetCount: 0,
        rebuildCount: 0,
      });
    }
  });

  it('keeps an unchanged admitted generation stable without reset or rebuild', () => {
    const fallback = {
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
    const temporal = { identity, successfulSubmit: true as const, generation: 4 };
    const first = admitSsrM0({
      requested: true,
      identity,
      reflectionFallback: fallback,
      format,
      temporal,
    });
    const stable = admitSsrM0({
      requested: true,
      identity,
      previousGeneration: first.generation,
      reflectionFallback: fallback,
      format,
      temporal,
    });
    expect(first.status).toBe('admitted');
    expect(stable).toEqual(first);
    expect(stable.budget).toEqual({ probeExecutions: 1, resetCount: 0, rebuildCount: 0 });
  });
});

it('keeps unavailable admission detached and bounded', () => {
  const result = unavailable();
  if (result.status !== 'fallback-only' || result.work.temporalDemand !== 0) {
    throw new Error('unavailable admission performed SSR work');
  }
});
