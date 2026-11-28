import { describe, expect, it, vi } from 'vitest';
import { sceneSnapshot, setSceneRow } from '../scene/__tests__/scene-row-writes';
import {
  ProbeBlendSceneProjection,
  type ProbeSceneObjectInput,
  type ProbeSceneProbeInput,
} from '../scene/probe-blend';
import { SceneSlotPage, SceneSlots } from '../scene/scene-slots';

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

  it('projects dynamic native translations without constructing Scene row views', () => {
    const scene = new SceneSlots();
    const projection = new ProbeBlendSceneProjection();
    const probes = [probe('fixed')];
    for (const key of [7, 70, 130])
      setSceneRow(scene, key, {
        generation: 0,
        entityKey: key,
        snapshot: sceneSnapshot(key, identityWorld),
      });
    const original = scene.capture();
    const read = vi.spyOn(SceneSlotPage.prototype, 'read');
    try {
      projection.apply({ objects: original, probes });
      const pose = identityWorld.slice();
      for (let frame = 1; frame <= 60; frame++) {
        pose[0] = 1 + frame;
        pose[12] = 0;
        scene.writePreparedPose(70, pose, 0, 2);
        pose[12] = frame % 2 === 0 ? 0 : 0.5;
        scene.writePreparedPose(130, pose, 0, 1);
        const delta = projection.apply({ objects: scene.capture(), probes });
        expect(delta.affectedObjectKeys).toEqual([130]);
        expect(delta.dirtyReasons).toEqual(['object-position']);
      }
      scene.remove(7);
      setSceneRow(scene, 70, {
        generation: 1,
        entityKey: 700,
        snapshot: sceneSnapshot(700, identityWorld),
      });
      // Lag the Probe reader far enough to retire its journal cursor.
      for (let frame = 1; frame <= 70; frame++) {
        pose[12] = frame % 2 === 0 ? 0.25 : 0.5;
        scene.writePreparedPose(130, pose, 0, 1);
        scene.capture();
      }
      const delta = projection.apply({ objects: scene.capture(), probes });
      expect(delta.affectedObjectKeys).toEqual([70, 130]);
      expect(delta.dirtyReasons).toEqual(
        expect.arrayContaining(['generation', 'object-position', 'object-boundary']),
      );
      expect(projection.getRecord(7)).toBeUndefined();
      expect(projection.getRecord(70)?.generation).toBe(1);
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
    expect(original.slotAt(130)?.snapshot.transform.world[12]).toBe(0);
  });

  it('observes in-place manual positions and radiance without mutating an issued read', () => {
    const projection = new ProbeBlendSceneProjection();
    const position: [number, number, number] = [0, 0, 0];
    const irradiance = new Float32Array(27).fill(1);
    const objects = [{ objectKey: 7, generation: 1, position }, object(10)];
    const inputs = { objects, probes: [{ ...probe('p'), irradiance }] };
    const original = projection.apply(inputs).records;
    const read = projection.captureRecordLookup();
    position[0] = 0.5;
    expect(projection.apply(inputs).affectedObjectKeys).toEqual([7]);
    expect(projection.getRecord(10)).toBe(original[1]);
    irradiance[5] = 4;
    expect(projection.apply(inputs).affectedObjectKeys).toEqual([7, 10]);
    expect(projection.getRecord(10)?.shPreblend[5]).toBe(4);
    expect(read(10)?.shPreblend[5]).toBe(1);
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

  it('packs changed SH into the record without allocating a typed array per scalar', () => {
    const projection = new ProbeBlendSceneProjection();
    const probes = [probe('light')];
    let scalarArrays = 0;
    vi.stubGlobal(
      'Float32Array',
      new Proxy(Float32Array, {
        construct(target, args, receiver) {
          if (Array.isArray(args[0]) && args[0].length === 1) scalarArrays++;
          return Reflect.construct(target, args, receiver);
        },
      }),
    );
    try {
      for (let frame = 0; frame < 4; frame++) {
        const result = projection.apply({
          objects: Array.from({ length: 8 }, (_, key) => object(key, 0, frame / 8)),
          probes,
        });
        expect(result.uploads).toBe(8);
        expect(result.records[7]?.localBlendFraction).toBe(Math.fround(1 - (frame / 16) ** 2));
      }
    } finally {
      vi.unstubAllGlobals();
    }
    expect(scalarArrays).toBe(0);
  });

  it('reports live receivers and their errors across edits and removal of a different slot', () => {
    const projection = new ProbeBlendSceneProjection();
    const probes = [
      ...Array.from({ length: 65 }, (_, key) => probe(String(key))),
      probe('far', 10),
    ];
    const first = object(2),
      far = object(9, 0, 10);
    projection.apply({ objects: [first, far], probes });
    const before = projection.captureRecordLookup()(2);
    const edited = projection.apply({ objects: [first, object(9, 0, 10.5)], probes });
    expect(edited.visits).toBe(1);
    expect(edited.error?.code).toBe('capacity-exceeded');
    expect(edited.activeContributorCount).toBe(65);
    expect(projection.getRecord(2)).toBe(before);
    const retired = projection.apply({ objects: [object(9, 0, 10.5)], probes });
    expect(retired.visits).toBe(0);
    expect(retired.error).toBeUndefined();
    expect(retired.receipt.activeIdentities).toEqual(['far']);
    expect(projection.inspect().coverage).toBe(1 - 0.25 ** 2);
    expect(edited.receipt.activeIdentities).toHaveLength(65);
  });

  it('evaluates only intersecting finite probe spheres as receivers and sources move', () => {
    const projection = new ProbeBlendSceneProjection();
    const probes = Array.from({ length: 512 }, (_, key) => probe(String(key), key * 8));
    const rows = (step: number) =>
      Array.from({ length: 32 }, (_, key) => object(key, 0, key * 8 + step / 8));
    const distance = vi.spyOn(Math, 'hypot');
    try {
      for (let step = 0; step < 8; step++) {
        distance.mockClear();
        const result = projection.apply({ objects: rows(step), probes });
        expect(distance).toHaveBeenCalledTimes(32);
        expect(result.records).toHaveLength(32);
        expect(result.records.every((row) => row.accepted)).toBe(true);
      }
      probes[511] = { ...probe('extra', 0), irradiance: new Float32Array(27).fill(NaN) };
      expect(projection.apply({ objects: rows(8), probes }).receipt.activeIdentities).toEqual([
        '0',
      ]);
      probes[511] = probe('extra', 0);
      const revised = projection.apply({ objects: rows(9), probes });
      expect(revised.receipt.activeIdentities).toEqual(['0', 'extra']);
      expect(projection.getRecord(31)?.accepted).toBe(true);
    } finally {
      distance.mockRestore();
    }
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

  it('keeps sky-only consumers out of the local probe record table', () => {
    const projection = new ProbeBlendSceneProjection();
    const result = projection.apply({
      objects: [object(7)],
      probes: [],
      skyIrradiance: [0.25, 0.5, 0.75],
      lastKnownGood: false,
    });

    expect(result.records).toHaveLength(0);
    expect(projection.recordBufferProjection().capacity).toBe(1);
    expect(result.uploads).toBe(0);
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
