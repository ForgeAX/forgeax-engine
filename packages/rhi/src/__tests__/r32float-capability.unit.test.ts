import { describe, expect, it } from 'vitest';
import {
  createUnavailableR32FloatReceipt,
  R32FLOAT_MIP_SAMPLED_STORAGE_PROFILE,
  type RhiTextureFormatProbeStage,
  validateR32FloatReceipt,
} from '../capability/texture-format';

const stages: readonly RhiTextureFormatProbeStage[] = [
  'texture-create',
  'mip-view',
  'sampled-storage-bind-group',
  'pipeline-bind',
  'finish',
  'submit',
  'completion',
  'readback',
];

describe('r32float-mip-sampled-storage profile', () => {
  it('keeps the profile closed and records every required stage', () => {
    const receipt = createUnavailableR32FloatReceipt({
      deviceGeneration: 7,
      failedStage: 'readback',
      detail: 'readback was not completed',
    });

    expect(receipt.profile).toBe(R32FLOAT_MIP_SAMPLED_STORAGE_PROFILE);
    expect(receipt.verdict).toBe('unavailable');
    expect(receipt.evidence).toBe('real');
    expect(receipt.deviceGeneration).toBe(7);
    expect(receipt.stages.map((stage) => stage.stage)).toEqual(stages);
    expect(receipt.stages.find((stage) => stage.stage === 'readback')).toMatchObject({
      verdict: 'unavailable',
      evidence: 'real',
      detail: 'readback was not completed',
    });
  });

  it.each(stages)('rejects a receipt missing the %s stage', (missingStage) => {
    const receipt = createUnavailableR32FloatReceipt({
      deviceGeneration: 1,
      failedStage: missingStage,
      detail: `missing ${missingStage}`,
    });
    const incomplete = {
      ...receipt,
      stages: receipt.stages.filter((stage) => stage.stage !== missingStage),
    };

    const result = validateR32FloatReceipt(incomplete);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('rhi-texture-format-capability-unavailable');
      expect(result.error.detail).toMatchObject({ stage: missingStage });
    }
  });

  it('rejects a receipt with an admitted verdict that lacks readback evidence', () => {
    const receipt = createUnavailableR32FloatReceipt({
      deviceGeneration: 3,
      failedStage: 'readback',
      detail: 'readback was not completed',
    });
    const admitted = {
      ...receipt,
      verdict: 'admitted' as const,
      stages: receipt.stages.map((stage) => ({
        ...stage,
        verdict: 'admitted' as const,
        evidence: 'real' as const,
      })),
      readback: undefined,
    };

    const result = validateR32FloatReceipt(admitted);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('rhi-texture-format-capability-unavailable');
      expect(result.error.detail).toMatchObject({ stage: 'readback' });
    }
  });

  it('rejects a profile with a filtered sample type or incomplete usage contract', () => {
    const receipt = createUnavailableR32FloatReceipt({
      deviceGeneration: 4,
      failedStage: 'sampled-storage-bind-group',
      detail: 'sampled/storage binding contract was rejected',
    });
    const invalid = {
      ...receipt,
      sampleType: 'float' as const,
      usages: ['texture-binding'] as const,
    };

    const result = validateR32FloatReceipt(
      invalid as unknown as Parameters<typeof validateR32FloatReceipt>[0],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('rhi-texture-format-capability-unavailable');
      expect(result.error.detail).toMatchObject({ stage: 'sampled-storage-bind-group' });
    }
  });
});
