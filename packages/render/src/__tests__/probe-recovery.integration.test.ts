import { describe, expect, it } from 'vitest';
import { PROBE_MAX_CONTRIBUTORS, ProbeBlendSceneProjection } from '../scene/probe-blend';

function probe(identity: string) {
  return {
    identity,
    position: [0, 0, 0] as const,
    radius: 2,
    irradiance: new Float32Array(27).fill(1),
    admitted: true,
  };
}

describe('probe recovery carrier', () => {
  it('recovers from capacity-exceeded with a deterministic stable prefix', () => {
    const projection = new ProbeBlendSceneProjection();
    const object = { objectKey: 4, generation: 0, position: [0, 0, 0] as const };
    const overflow = projection.apply({
      objects: [object],
      probes: Array.from({ length: PROBE_MAX_CONTRIBUTORS + 1 }, (_, index) => probe(`p-${index}`)),
      skyIrradiance: [0.1, 0.2, 0.3],
    });
    const recovered = projection.apply({
      objects: [{ ...object, generation: 1 }],
      probes: Array.from({ length: PROBE_MAX_CONTRIBUTORS }, (_, index) => probe(`p-${index}`)),
      skyIrradiance: [0.1, 0.2, 0.3],
    });

    expect(overflow.error?.code).toBe('capacity-exceeded');
    expect(overflow.records).toHaveLength(1);
    expect(overflow.records[0]).toMatchObject({
      objectKey: object.objectKey,
      generation: object.generation,
      accepted: true,
    });
    expect(overflow.records[0]?.sentinel).toBeUndefined();
    expect(overflow.records[0]?.shPreblend).not.toEqual(new Array(27).fill(0));
    expect(recovered.error).toBeUndefined();
    expect(recovered.records).toHaveLength(1);
    expect(recovered.records[0]?.generation).toBe(1);
    expect(recovered.receipt.rejectedIdentities).toEqual([]);
  });

  it('rebuilds all object lanes after a scene resize boundary', () => {
    const projection = new ProbeBlendSceneProjection();
    const probes = [probe('p-0')];
    projection.apply({
      objects: [{ objectKey: 4, generation: 0, position: [0, 0, 0] }],
      probes,
      skyIrradiance: [0.1, 0.2, 0.3],
    });
    const resized = projection.apply({
      objects: [
        { objectKey: 4, generation: 0, position: [0, 0, 0] },
        { objectKey: 5, generation: 0, position: [0, 0, 0] },
      ],
      probes,
      skyIrradiance: [0.1, 0.2, 0.3],
    });

    expect(resized.dirtyReasons).toContain('object-boundary');
    expect(resized.records.map((record) => record.objectKey)).toEqual([4, 5]);
    expect(resized.records.every((record) => record.byteLength === 160)).toBe(true);
  });

  it('drops stale local records and visits every object when Sky changes', () => {
    const projection = new ProbeBlendSceneProjection();
    const object = { objectKey: 4, generation: 0, position: [0, 0, 0] as const };
    const sky = {
      available: true,
      identity: 'skylight:1',
      sourceKey: 'equirect:2',
      irradiance: [0.1, 0.2, 0.3] as const,
    };
    projection.apply({ objects: [object], probes: [probe('p-0')], sky });

    const changedSky = projection.apply({
      objects: [object],
      probes: [probe('p-0')],
      sky: { ...sky, irradiance: [0.4, 0.5, 0.6] },
    });
    expect(changedSky.dirtyReasons).toContain('sky');
    expect(changedSky.affectedObjectKeys).toEqual([object.objectKey]);
    expect(projection.inspect().sky.irradiance).toEqual([0.4, 0.5, 0.6]);

    const noLocalProbes = projection.apply({
      objects: [object],
      probes: [],
      sky: changedSkyInputSky(),
    });
    expect(noLocalProbes.records).toEqual([]);
    expect(projection.getRecord(object.objectKey)).toBeUndefined();
    expect(projection.inspect().records).toEqual([]);
  });
});

function changedSkyInputSky() {
  return {
    available: true,
    identity: 'skylight:1',
    sourceKey: 'equirect:2',
    irradiance: [0.4, 0.5, 0.6] as const,
  };
}
