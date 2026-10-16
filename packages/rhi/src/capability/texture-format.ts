import { err, ok, type Result, RhiError } from '../errors';

/** The only format profile currently admitted by the reflection fallback path. */
export const R32FLOAT_MIP_SAMPLED_STORAGE_PROFILE = 'r32float-mip-sampled-storage' as const;

export type RhiTextureFormatProfile = typeof R32FLOAT_MIP_SAMPLED_STORAGE_PROFILE;
export type RhiTextureFormatProbeVerdict = 'admitted' | 'unavailable' | 'structural-only';
export type RhiTextureFormatProbeEvidence = 'real' | 'structural';
export type RhiTextureFormatProbeStage =
  | 'texture-create'
  | 'mip-view'
  | 'sampled-storage-bind-group'
  | 'pipeline-bind'
  | 'finish'
  | 'submit'
  | 'completion'
  | 'readback';

export const R32FLOAT_PROBE_STAGES: readonly RhiTextureFormatProbeStage[] = [
  'texture-create',
  'mip-view',
  'sampled-storage-bind-group',
  'pipeline-bind',
  'finish',
  'submit',
  'completion',
  'readback',
];

export interface RhiTextureFormatProbeStageReceipt {
  readonly stage: RhiTextureFormatProbeStage;
  readonly verdict: RhiTextureFormatProbeVerdict;
  readonly evidence: RhiTextureFormatProbeEvidence;
  readonly detail?: string | undefined;
}

export interface RhiTextureFormatReadback {
  readonly byteLength: number;
  readonly values: readonly number[];
}

export interface RhiTextureFormatCapabilityReceipt {
  readonly profile: RhiTextureFormatProfile;
  readonly verdict: RhiTextureFormatProbeVerdict;
  readonly evidence: RhiTextureFormatProbeEvidence;
  readonly deviceGeneration: number;
  readonly stages: readonly RhiTextureFormatProbeStageReceipt[];
  readonly sampleType: 'unfilterable-float';
  readonly usages: readonly ['texture-binding', 'storage-binding', 'copy-src'];
  readonly readback?: RhiTextureFormatReadback | undefined;
  readonly probeExecutions: number;
}

export interface CreateUnavailableR32FloatReceiptOptions {
  readonly deviceGeneration: number;
  readonly failedStage: RhiTextureFormatProbeStage;
  readonly detail: string;
  readonly evidence?: RhiTextureFormatProbeEvidence | undefined;
}

export function createUnavailableR32FloatReceipt(
  options: CreateUnavailableR32FloatReceiptOptions,
): RhiTextureFormatCapabilityReceipt {
  const failureIndex = R32FLOAT_PROBE_STAGES.indexOf(options.failedStage);
  const evidence = options.evidence ?? 'real';
  return {
    profile: R32FLOAT_MIP_SAMPLED_STORAGE_PROFILE,
    verdict: 'unavailable',
    evidence,
    deviceGeneration: options.deviceGeneration,
    stages: R32FLOAT_PROBE_STAGES.map((stage, index) => ({
      stage,
      verdict: index < failureIndex ? 'admitted' : 'unavailable',
      evidence,
      ...(stage === options.failedStage ? { detail: options.detail } : {}),
    })),
    sampleType: 'unfilterable-float',
    usages: ['texture-binding', 'storage-binding', 'copy-src'],
    probeExecutions: 1,
  };
}

export function validateR32FloatReceipt(
  receipt: RhiTextureFormatCapabilityReceipt,
): Result<RhiTextureFormatCapabilityReceipt, RhiError> {
  const missing = R32FLOAT_PROBE_STAGES.find(
    (stage) => !receipt.stages.some((entry) => entry.stage === stage),
  );
  if (missing !== undefined) {
    return unavailable(receipt, missing, `required stage ${missing} is missing`);
  }
  if (receipt.profile !== R32FLOAT_MIP_SAMPLED_STORAGE_PROFILE) {
    return unavailable(receipt, 'texture-create', 'profile is not the closed r32float profile');
  }
  if (receipt.sampleType !== 'unfilterable-float') {
    return unavailable(
      receipt,
      'sampled-storage-bind-group',
      'sample type must be unfilterable-float',
    );
  }
  if (
    receipt.usages.length !== 3 ||
    receipt.usages[0] !== 'texture-binding' ||
    receipt.usages[1] !== 'storage-binding' ||
    receipt.usages[2] !== 'copy-src'
  ) {
    return unavailable(
      receipt,
      'sampled-storage-bind-group',
      'sampled, storage, and readback usages are required',
    );
  }
  if (receipt.verdict === 'admitted' && receipt.readback === undefined) {
    return unavailable(receipt, 'readback', 'admitted profiles require real readback evidence');
  }
  return ok(receipt);
}

function unavailable(
  receipt: RhiTextureFormatCapabilityReceipt,
  stage: RhiTextureFormatProbeStage,
  detail: string,
): Result<never, RhiError> {
  return err(
    new RhiError({
      code: 'rhi-texture-format-capability-unavailable',
      expected: `r32float profile stage ${stage} to be complete`,
      hint: 'retain fallback-only rendering and retry the owner-owned device probe',
      detail: {
        stage,
        deviceGeneration: receipt.deviceGeneration,
        reason: detail,
      },
    }),
  );
}
