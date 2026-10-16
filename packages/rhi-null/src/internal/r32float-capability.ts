import {
  ok,
  R32FLOAT_PROBE_STAGES,
  type Result,
  type RhiError,
  type RhiTextureFormatCapabilityReceipt,
} from '@forgeax/engine-rhi';

/** Structural command-shape evidence; no RhiNull pixel admission is possible. */
export function probeR32FloatCapability(
  deviceGeneration: number,
): Promise<Result<RhiTextureFormatCapabilityReceipt, RhiError>> {
  return Promise.resolve(
    ok({
      profile: 'r32float-mip-sampled-storage',
      verdict: 'structural-only',
      evidence: 'structural',
      deviceGeneration,
      stages: R32FLOAT_PROBE_STAGES.map((stage) => ({
        stage,
        verdict: 'structural-only' as const,
        evidence: 'structural' as const,
      })),
      sampleType: 'unfilterable-float' as const,
      usages: ['texture-binding', 'storage-binding', 'copy-src'] as const,
      probeExecutions: 1,
    }),
  );
}
