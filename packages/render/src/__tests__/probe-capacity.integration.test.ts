import { describe, expect, it } from 'vitest';
import {
  PROBE_MAX_CONTRIBUTORS,
  ProbeBlendSceneProjection,
  type ProbeSceneProbeInput,
} from '../scene/probe-blend';
import {
  PROBE_BLEND_RECORD_BYTE_SIZE,
  PROBE_BLEND_RECORD_CAPACITY,
} from '../scene/probe-blend-record';

function makeProbe(index: number): ProbeSceneProbeInput {
  return {
    identity: `probe-${String(index).padStart(2, '0')}`,
    position: [0, 0, 0],
    radius: 2,
    irradiance: new Float32Array(27).fill(index + 1),
    admitted: true,
  };
}

describe('probe admitted capacity', () => {
  it('admits a stable prefix when active candidates exceed capacity', () => {
    const projection = new ProbeBlendSceneProjection();
    const result = projection.apply({
      objects: [{ objectKey: 1, generation: 0, position: [0, 0, 0] }],
      probes: Array.from({ length: PROBE_MAX_CONTRIBUTORS + 1 }, (_, index) => makeProbe(index)),
      skyIrradiance: [0.1, 0.2, 0.3],
    });

    expect(result.error?.code).toBe('capacity-exceeded');
    expect(result.records[0]?.sentinel).toBeUndefined();
    expect(result.records[0]?.accepted).toBe(true);
    expect(result.activeContributorCount).toBe(PROBE_MAX_CONTRIBUTORS + 1);
    expect(result.admittedProbeCount).toBe(PROBE_MAX_CONTRIBUTORS);
    expect(result.receipt.activeIdentities).toHaveLength(PROBE_MAX_CONTRIBUTORS + 1);
    expect(result.receipt.admittedIdentities).toHaveLength(PROBE_MAX_CONTRIBUTORS);
    expect(result.receipt.rejectedIdentities).toHaveLength(1);
    expect(result.receipt.overflowReason).toBe('active-count-exceeds-capacity');
    expect(PROBE_BLEND_RECORD_CAPACITY).toBe(PROBE_MAX_CONTRIBUTORS);
  });

  it('retains the previous accepted record when a later admission overflows', () => {
    const projection = new ProbeBlendSceneProjection();
    const accepted = projection.apply({
      objects: [{ objectKey: 1, generation: 0, position: [0, 0, 0] }],
      probes: Array.from({ length: PROBE_MAX_CONTRIBUTORS }, (_, index) => makeProbe(index)),
      skyIrradiance: [0.1, 0.2, 0.3],
    });
    const overflow = projection.apply({
      objects: [{ objectKey: 1, generation: 0, position: [0, 0, 0] }],
      probes: Array.from({ length: PROBE_MAX_CONTRIBUTORS + 1 }, (_, index) => makeProbe(index)),
      skyIrradiance: [0.1, 0.2, 0.3],
    });

    expect(overflow.error?.code).toBe('capacity-exceeded');
    expect(overflow.records).toEqual(accepted.records);
    expect(overflow.admittedProbeCount).toBe(PROBE_MAX_CONTRIBUTORS);
  });

  it('lets the admission prefix include every admitted active contributor', () => {
    const projection = new ProbeBlendSceneProjection();
    const result = projection.apply({
      objects: [{ objectKey: 1, generation: 0, position: [0, 0, 0] }],
      probes: Array.from({ length: PROBE_MAX_CONTRIBUTORS }, (_, index) => makeProbe(index)),
      skyIrradiance: [0.1, 0.2, 0.3],
    });

    expect(result.error).toBeUndefined();
    expect(result.contributors).toHaveLength(PROBE_MAX_CONTRIBUTORS);
    expect(result.receipt.admittedIdentities).toEqual(
      Array.from(
        { length: PROBE_MAX_CONTRIBUTORS },
        (_, index) => `probe-${String(index).padStart(2, '0')}`,
      ),
    );
    expect(result.records[0]?.byteLength).toBe(PROBE_BLEND_RECORD_BYTE_SIZE);
  });

  it('keeps stable identity order and recomputes C/S/SH after admitted clipping', () => {
    const projection = new ProbeBlendSceneProjection();
    const result = projection.apply({
      objects: [{ objectKey: 1, generation: 0, position: [0, 0, 0] }],
      probes: [makeProbe(2), makeProbe(0), makeProbe(1)],
      skyIrradiance: [0.4, 0.5, 0.6],
    });

    expect(result.contributors.map(({ identity }) => identity)).toEqual([
      'probe-00',
      'probe-01',
      'probe-02',
    ]);
    expect(result.coverage).toBeGreaterThan(0);
    expect(result.skyResidualFraction).toBeGreaterThanOrEqual(0);
    expect(result.records[0]?.shPreblend).toHaveLength(27);
  });
});
