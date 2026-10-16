import { describe, expect, it } from 'vitest';
import {
  evaluateTransmissionCapability,
  TransmissionCandidateAdmission,
  type TransmissionCapabilityFacts,
} from '../backdrop';

function facts(overrides: Partial<TransmissionCapabilityFacts> = {}): TransmissionCapabilityFacts {
  return {
    format: 'rgba16float',
    renderAttachment: true,
    copySrc: true,
    textureBinding: true,
    mipView: true,
    filteringSampler: true,
    bindGroupLayout: true,
    msaaResolve: true,
    resourceCreation: true,
    ...overrides,
  };
}

describe('TransmissionBackdrop joint capability verdict', () => {
  it('requires every real resource and usage fact', () => {
    const fields = [
      'format',
      'renderAttachment',
      'copySrc',
      'textureBinding',
      'mipView',
      'filteringSampler',
      'bindGroupLayout',
      'msaaResolve',
      'resourceCreation',
    ] as const;

    for (const field of fields) {
      const input = field === 'format' ? { format: 'bgra8unorm' } : { [field]: false };
      const verdict = evaluateTransmissionCapability(facts(input));
      expect(verdict.ok, field).toBe(false);
      expect(verdict.missing).toContain(field);
    }
  });

  it('does not branch on backend name or a synthetic transmission boolean', () => {
    const baseline = evaluateTransmissionCapability(facts());
    const sameFacts = evaluateTransmissionCapability({
      ...facts(),
      backendKind: 'wgpu-native',
    });

    expect(baseline).toEqual(sameFacts);
    expect(baseline.ok).toBe(true);
  });

  it('returns a successful receipt only for the complete joint capability', () => {
    expect(evaluateTransmissionCapability(facts())).toEqual({ ok: true, missing: [] });
  });

  it('does not publish demand or generation when candidate admission fails', () => {
    const admission = new TransmissionCandidateAdmission();
    expect(admission.admit({ activeCount: 1, needsRoughMips: true }, facts())).toMatchObject({
      ok: true,
      generation: 1,
    });

    const rejected = admission.admit(
      { activeCount: 2, needsRoughMips: true },
      facts({ copySrc: false }),
    );
    expect(rejected).toMatchObject({
      ok: false,
      missing: ['copySrc'],
      published: false,
      generation: 1,
      demand: { activeCount: 1, needsRoughMips: true },
    });
    expect(admission.inspect()).toEqual({
      generation: 1,
      demand: { activeCount: 1, needsRoughMips: true },
    });
  });
});
