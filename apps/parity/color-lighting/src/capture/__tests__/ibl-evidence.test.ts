import { describe, expect, it } from 'vitest';
import { projectIblRawEvidence } from '../../report/capability-status';

describe('IBL raw evidence projection', () => {
  it('joins named readback metadata with capability and fallback provenance', () => {
    const evidence = projectIblRawEvidence({
      attachmentName: 'ibl.irradiance',
      layer: 2,
      capabilitySnapshot: { rgba16floatRenderable: true },
      fallbackArtifact: null,
      lastKnownGood: 'ibl.irradiance@rgba16float',
      readback: {
        status: 'ready',
        bytes: new Uint8Array([0, 1, 2, 3]),
        format: 'rgba16float',
        size: { width: 1, height: 1 },
        rawHash: '00010203',
        frameId: 7,
        lifetime: { frameId: 7, state: 'active' },
      },
    });

    expect(evidence).toMatchObject({
      status: 'ready',
      attachmentName: 'ibl.irradiance',
      layer: 2,
      format: 'rgba16float',
      rawHash: '00010203',
      capabilitySnapshot: { rgba16floatRenderable: true },
      fallbackArtifact: null,
      lastKnownGood: 'ibl.irradiance@rgba16float',
    });
  });

  it('fails closed when raw readback is absent even if capability is present', () => {
    const evidence = projectIblRawEvidence({
      attachmentName: 'ibl.irradiance',
      layer: 2,
      capabilitySnapshot: { rgba16floatRenderable: true },
      fallbackArtifact: null,
      lastKnownGood: 'ibl.irradiance@rgba16float',
      readback: { status: 'failed' },
    });

    expect(evidence.status).toBe('failed');
    expect(evidence.rawHash).toBeNull();
  });
});
