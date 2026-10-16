import { type MeshAsset, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { PointsLinesMaterialUnsupportedError } from '../../errors/render';
import { PointsLinesExpansionCache } from '../expansion-cache';
import { inspectPointsLines } from '../inspection';
import { type PointsLinesGpuResourceAdapter, PointsLinesPreparation } from '../prepare';
import { createPointsLinesLaneContract, createPointsLinesRecordPlan } from '../record';
import { createPointsLinesSnapshot } from '../snapshot';

function mesh(): MeshAsset {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
  return {
    kind: 'mesh',
    vertices: positions,
    indices: new Uint16Array([0, 1, 2, 3]),
    attributes: { position: positions },
    aabb: new Float32Array([0, 0, 0, 1, 1, 0]),
    submeshes: [
      { indexOffset: 0, indexCount: 4, vertexCount: 4, topology: 'line-list', materialSlot: 0 },
    ],
    materialSlots: [{ slotName: 'points-lines' }],
  };
}

function snapshot(viewport = { width: 320, height: 200, dpr: 1 }) {
  return createPointsLinesSnapshot({
    worldId: 2,
    entityKey: 7,
    component: 'Lines',
    meshHandle: 9,
    meshGeneration: 3,
    materialHandle: 12,
    materialGeneration: 4,
    style: { kind: 'lines', width: 4 },
    layer: 0,
    visible: true,
    sourceBounds: new Float32Array([0, 0, 0, 1, 1, 0]),
    viewport,
    projection: new Float32Array(16),
  });
}

describe('Points/Lines inspection and recovery integration', () => {
  it('publishes typed and JSON inspection for each shared lane', () => {
    const geometry = new PointsLinesExpansionCache().getOrCreate(snapshot(), mesh());
    for (const lane of ['direct', 'clustered', 'cpu-webgl2'] as const) {
      const plan = createPointsLinesRecordPlan(
        snapshot(),
        geometry,
        createPointsLinesLaneContract(lane, 'webgpu'),
      );
      const inspection = inspectPointsLines({
        snapshot: snapshot(),
        topology: 'line-list',
        lane,
        pointCount: geometry.pointCount,
        segmentCount: geometry.segmentCount,
        sourceBytes: geometry.sourceBytes,
        derivedBytes: geometry.derivedBytes,
        cache: { hit: false, rebuilds: 1, evictions: 0 },
        drawCount: plan.drawCount,
        uploadBytes: geometry.derivedBytes,
        lastKnownGood: true,
      });
      const json = JSON.parse(JSON.stringify(inspection)) as typeof inspection;
      expect(json).toMatchObject({
        entityKey: 7,
        worldId: 2,
        topology: 'line-list',
        lane,
        segmentCount: 2,
        drawCount: 1,
        lastKnownGood: true,
      });
      expect(json.derivedBytes).toBeGreaterThan(json.sourceBytes);
    }
  });

  it('keeps the same retained expansion through resize and recovers one LKG', () => {
    const resources: string[] = [];
    const adapter: PointsLinesGpuResourceAdapter<string> = {
      create: () => {
        const resource = `resource-${resources.length + 1}`;
        resources.push(resource);
        return ok(resource);
      },
      upload: () => ok(648),
      validate: () => ok(undefined),
      destroy: (resource) => resources.splice(resources.indexOf(resource), 1),
    };
    const preparation = new PointsLinesPreparation({
      cache: new PointsLinesExpansionCache(),
      adapter,
    });
    const first = preparation.prepare(snapshot(), mesh()).unwrap();
    const resized = preparation
      .prepare(snapshot({ width: 640, height: 360, dpr: 2 }), mesh())
      .unwrap();

    expect(resized.geometry).toBe(first.geometry);
    expect(preparation.inspect()).toMatchObject({
      status: 'resident',
      lastKnownGood: true,
      rebuilds: 1,
    });
    preparation.resetForDeviceLoss();
    expect(preparation.inspect()).toMatchObject({ status: 'rebuild-pending', liveBytes: 0 });
    preparation.prepare(snapshot({ width: 640, height: 360, dpr: 2 }), mesh()).unwrap();
    expect(preparation.inspect()).toMatchObject({
      status: 'resident',
      lastKnownGood: true,
      rebuilds: 2,
    });
    expect(resources).toEqual(['resource-1']);
  });

  it('keeps executable refusal hints on the same inspection surface', () => {
    const inspection = inspectPointsLines({
      snapshot: snapshot(),
      topology: 'line-list',
      lane: 'refused',
      pointCount: 0,
      segmentCount: 0,
      sourceBytes: 0,
      derivedBytes: 0,
      cache: { hit: false, rebuilds: 0, evictions: 0 },
      drawCount: 0,
      uploadBytes: 0,
      lastKnownGood: false,
      refusal: {
        ...new PointsLinesMaterialUnsupportedError({
          entity: 7,
          material: 'mat',
          pass: 'forward',
          module: 'test',
          reason: 'unsupported test material',
        }),
        generation: 4,
        lastKnownGood: false,
      },
    });
    expect(JSON.parse(JSON.stringify(inspection)).refusal.hint).toContain('Materials.unlit');
  });
});
