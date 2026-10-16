import { describe, expect, it } from 'vitest';
import {
  resolveTransmissionBackdropTopology,
  type TransmissionBackdropResourceFacts,
  TransmissionCandidateAdmission,
  type TransmissionCapabilityFacts,
} from '../backdrop';
import { inspectTransmissionFromAdmission } from '../inspection';

const capability: TransmissionCapabilityFacts = {
  format: 'rgba16float',
  renderAttachment: true,
  copySrc: true,
  textureBinding: true,
  mipView: true,
  filteringSampler: true,
  bindGroupLayout: true,
  msaaResolve: true,
  resourceCreation: true,
};

function resource(
  extent: { width: number; height: number },
  deviceGeneration: number,
): TransmissionBackdropResourceFacts {
  return {
    extent,
    format: 'rgba16float',
    mipCount: 1,
    bytes: extent.width * extent.height * 8,
    deviceGeneration,
  };
}

describe('transmission backdrop lifecycle', () => {
  it('retires a stale-size candidate instead of publishing it as compatible LKG', () => {
    const admission = new TransmissionCandidateAdmission();
    const demand = { activeCount: 1, needsRoughMips: false } as const;
    admission.admit(demand, capability, resource({ width: 4, height: 4 }, 1));
    const rejected = admission.admit(
      demand,
      { ...capability, copySrc: false },
      resource({ width: 8, height: 4 }, 1),
    );

    expect(rejected).toMatchObject({ ok: false, published: false, generation: 1 });
    expect(admission.inspectLifecycle()).not.toHaveProperty('resource');
    expect(
      inspectTransmissionFromAdmission({
        admission: admission.inspectLifecycle(),
        topology: resolveTransmissionBackdropTopology({ demand, sourceSampleCount: 1 }),
        extent: { width: 8, height: 4 },
        transmissionDrawCount: 1,
      }),
    ).toMatchObject({ lifecycle: 'failed', recovery: 'rebuild-required', bytes: 0 });
  });

  it('keeps demand through device loss and publishes a replacement generation', () => {
    const admission = new TransmissionCandidateAdmission();
    const demand = { activeCount: 1, needsRoughMips: true } as const;
    admission.admit(demand, capability, resource({ width: 4, height: 4 }, 1));
    admission.markDeviceLost();
    expect(admission.inspectLifecycle()).toMatchObject({
      demand,
      lifecycle: 'device-lost',
      lastKnownGood: false,
      recovery: 'rebuild-required',
    });

    const replacement = admission.admit(demand, capability, resource({ width: 8, height: 4 }, 2));
    expect(replacement).toMatchObject({ ok: true, published: true, generation: 2 });
    expect(admission.inspectLifecycle()).toMatchObject({
      lifecycle: 'resident',
      lastKnownGood: true,
      recovery: 'recovered',
      resource: { deviceGeneration: 2, extent: { width: 8, height: 4 } },
    });
  });

  it('returns exact zero physical work after the last active material is removed', () => {
    const admission = new TransmissionCandidateAdmission();
    admission.admit(
      { activeCount: 1, needsRoughMips: false },
      capability,
      resource({ width: 4, height: 4 }, 1),
    );
    const zero = admission.admit({ activeCount: 0, needsRoughMips: false }, capability);
    expect(zero).toMatchObject({ ok: true, published: true, generation: 2 });
    expect(admission.inspectLifecycle()).toMatchObject({
      demand: { activeCount: 0, needsRoughMips: false },
      lifecycle: 'inactive',
      lastKnownGood: false,
      recovery: 'recovered',
    });
  });
});
