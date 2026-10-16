import { describe, expect, it } from 'vitest';
import {
  ProbeBlendSceneProjection,
  type ProbeSceneObjectInput,
  type ProbeSceneProbeInput,
} from '../scene/probe-blend';

const identityWorld = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function object(objectKey: number, generation = 0, x = 0): ProbeSceneObjectInput {
  return { objectKey, generation, position: [x, 0, 0] };
}

function probe(identity: string, x = 0, irradiance = 1): ProbeSceneProbeInput {
  return {
    identity,
    position: [x, 0, 0],
    radius: 2,
    irradiance: new Float32Array(27).fill(irradiance),
    admitted: true,
  };
}

describe('PersistentRenderScene probe projection', () => {
  it('creates one 160-byte record per object and reports candidate/accepted/LKG state', () => {
    const projection = new ProbeBlendSceneProjection();
    const first = projection.apply({
      objects: [object(7)],
      probes: [probe('probe-a')],
      skyIrradiance: [0.25, 0.5, 0.75],
    });

    expect(first.records).toHaveLength(1);
    expect(first.records[0]?.byteLength).toBe(160);
    expect(first.records[0]?.candidate).toBe(true);
    expect(first.records[0]?.accepted).toBe(true);
    expect(first.records[0]?.lastKnownGood).toBe(true);
    expect(first.records[0]?.bytes.byteLength).toBe(160);
    expect(identityWorld.byteLength).toBe(64);
  });

  it('does no visit, allocation, or upload for a no-change frame', () => {
    const projection = new ProbeBlendSceneProjection();
    const input = {
      objects: [object(7)],
      probes: [probe('probe-a')],
      skyIrradiance: [0.25, 0.5, 0.75] as const,
    };
    const first = projection.apply(input);
    const firstBufferProjection = projection.recordBufferProjection();
    const second = projection.apply(input);

    expect(second.dirtyReasons).toEqual([]);
    expect(second.visits).toBe(0);
    expect(second.allocations).toBe(0);
    expect(second.uploads).toBe(0);
    expect(second.records).toBe(first.records);
    expect(projection.recordBufferProjection()).toBe(firstBufferProjection);
    expect(projection.recordBufferProjection().records).toBe(firstBufferProjection.records);
  });

  it('marks object boundary, probe fact, World, and generation changes', () => {
    const projection = new ProbeBlendSceneProjection();
    projection.apply({
      objects: [object(7)],
      probes: [probe('probe-a')],
      sky: {
        available: true,
        identity: 'skylight:9',
        sourceKey: 'equirect:17',
        irradiance: [1, 1, 1],
      },
    });

    const objectBoundary = projection.apply({
      objects: [object(7), object(8)],
      probes: [probe('probe-a')],
      skyIrradiance: [1, 1, 1],
    });
    expect(objectBoundary.dirtyReasons).toContain('object-boundary');

    const probeFacts = projection.apply({
      objects: [object(7), object(8)],
      probes: [probe('probe-a', 0.25, 2)],
      skyIrradiance: [1, 1, 1],
    });
    expect(probeFacts.dirtyReasons).toContain('probe-fact');

    const world = projection.apply({
      objects: [object(7), object(8)],
      probes: [probe('probe-a', 0.25, 2)],
      skyIrradiance: [2, 1, 1],
      worldRevision: 1,
    });
    expect(world.dirtyReasons).toContain('world');

    const generation = projection.apply({
      objects: [object(7, 1), object(8)],
      probes: [probe('probe-a', 0.25, 2)],
      skyIrradiance: [2, 1, 1],
      worldRevision: 1,
    });
    expect(generation.dirtyReasons).toContain('generation');
  });

  it('marks only moved objects as affected by position dirty', () => {
    const projection = new ProbeBlendSceneProjection();
    projection.apply({
      objects: [object(7), object(8)],
      probes: [probe('probe-a')],
      skyIrradiance: [1, 1, 1],
    });
    const moved = projection.apply({
      objects: [object(7, 0, 0.25), object(8)],
      probes: [probe('probe-a')],
      skyIrradiance: [1, 1, 1],
    });

    expect(moved.dirtyReasons).toContain('object-position');
    expect(moved.affectedObjectKeys).toEqual([7]);
  });

  it('packs SH9 as nine vec4 lanes with zero padding', () => {
    const projection = new ProbeBlendSceneProjection();
    const coefficients = Array.from({ length: 27 }, (_, index) => index + 1);
    const result = projection.apply({
      objects: [object(7)],
      probes: [{ ...probe('probe-a'), irradiance: coefficients }],
      skyIrradiance: [0, 0, 0],
    });
    const values = new Float32Array(result.records[0]?.bytes.buffer ?? new ArrayBuffer(0));

    expect(Array.from(values.slice(4, 13))).toEqual([1, 2, 3, 0, 4, 5, 6, 0, 7]);
    expect(result.records[0]?.shPreblend).toEqual(coefficients);
  });

  it('uses no-LKG and outside-radius sentinels without inventing sky contributors', () => {
    const projection = new ProbeBlendSceneProjection();
    const result = projection.apply({
      objects: [object(7)],
      probes: [probe('probe-outside', 2)],
      skyIrradiance: [0.25, 0.5, 0.75],
      lastKnownGood: false,
    });

    expect(result.contributors).toEqual([]);
    expect(result.records[0]?.localBlendFraction).toBe(0);
    expect(result.records[0]?.sentinel).toBe('no-lkg');
    expect('skyResidualFraction' in (result.records[0] ?? {})).toBe(false);
  });

  it('publishes a zero-local sentinel only for an explicit retained consumer', () => {
    const projection = new ProbeBlendSceneProjection();
    const result = projection.apply({
      objects: [object(7)],
      probes: [],
      retainSkyResidualRecords: true,
      skyIrradiance: [0.25, 0.5, 0.75],
      lastKnownGood: false,
    });

    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      objectKey: 7,
      generation: 0,
      localBlendFraction: 0,
      candidate: true,
      accepted: false,
      lastKnownGood: false,
      sentinel: 'no-lkg',
    });
    expect(result.records[0]?.shPreblend).toEqual(new Array(27).fill(0));
  });

  it('exposes numeric record, admission, and fail-closed receipt facts', () => {
    const projection = new ProbeBlendSceneProjection();
    projection.apply({
      objects: [object(7)],
      probes: [probe('probe-a')],
      sky: {
        available: true,
        identity: 'skylight:9',
        sourceKey: 'equirect:17',
        irradiance: [1, 1, 1],
      },
    });
    const inspection = projection.inspect();

    expect(inspection).toMatchObject({
      activeContributorCount: 1,
      admittedProbeCount: 1,
      coverage: expect.any(Number),
      skyResidualFraction: expect.any(Number),
      finite: true,
      errorCode: undefined,
      receipt: {
        activeIdentities: ['probe-a'],
        admittedIdentities: ['probe-a'],
        rejectedIdentities: [],
        stableOrder: ['probe-a'],
        capacity: 64,
        scaleRadius: 2,
        finite: true,
      },
      sky: {
        available: true,
        identity: 'skylight:9',
        sourceKey: 'equirect:17',
        irradiance: [1, 1, 1],
      },
      dirtyVisitCount: 1,
      dirtyReasons: ['object-boundary'],
    });
    expect(inspection.records[0]).toMatchObject({
      objectKey: 7,
      generation: 0,
      byteLength: 160,
      candidate: true,
      accepted: true,
      lastKnownGood: true,
      probeBlendIndex: 7,
      qHatSum: expect.any(Number),
      rStar: 2,
      contributors: [
        {
          identity: 'probe-a',
          distance: 0,
          radius: 2,
          coverage: 1,
          q: 0.25,
          qHat: 1,
          alpha: 1,
        },
      ],
    });
    expect(inspection.records[0]?.shPreblend).toHaveLength(27);
  });
});
