import type { MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { PointsLinesExpansionCache } from '../expansion-cache';
import {
  createPointsLinesLaneAdapter,
  createPointsLinesLaneContract,
  createPointsLinesRecordPlan,
} from '../record';
import { createPointsLinesSnapshot } from '../snapshot';

function mesh(topology: 'point-list' | 'line-list', count: number): MeshAsset {
  const vertices = new Float32Array(
    Array.from({ length: count }, (_, index) => [index, index % 2, 0]).flat(),
  );
  return {
    kind: 'mesh',
    vertices,
    indices: new Uint16Array(Array.from({ length: count }, (_, index) => index)),
    attributes: { position: vertices },
    aabb: new Float32Array([0, 0, 0, count, 1, 0]),
    submeshes: [
      { indexOffset: 0, indexCount: count, vertexCount: count, topology, materialSlot: 0 },
    ],
    materialSlots: [{ slotName: 'points-lines' }],
  };
}

function snapshot(component: 'Points' | 'Lines' | undefined) {
  return createPointsLinesSnapshot({
    worldId: 1,
    entityKey: 7,
    component,
    meshHandle: 11,
    meshGeneration: 3,
    materialHandle: 13,
    materialGeneration: 2,
    style:
      component === 'Points'
        ? { kind: 'points', sizePx: 16, shape: 'circle' }
        : component === 'Lines'
          ? { kind: 'lines', width: 4 }
          : undefined,
    layer: 0,
    visible: true,
    sourceBounds: new Float32Array([0, 0, 0, 4, 1, 0]),
    viewport: { width: 640, height: 480, dpr: 2 },
    projection: new Float32Array(16),
  });
}

describe('Points/Lines structural lane contract', () => {
  it('marks RhiNull structural-only and preserves one shared lane contract', () => {
    const adapter = createPointsLinesLaneAdapter('direct', 'null');
    const geometry = new PointsLinesExpansionCache().getOrCreate(
      snapshot('Points'),
      mesh('point-list', 4),
    );
    const plan = adapter.createRecordPlan(snapshot('Points'), geometry);

    expect(adapter.contract.evidence).toBe('structural-only');
    expect(adapter.contract.authoring).toBe('shared');
    expect(plan.drawCount).toBe(1);
    expect(plan.shadowDrawCount).toBe(0);
    expect(plan.graph).toEqual({ additionalAttachments: 0, additionalPasses: 0 });
  });

  it('keeps the component-off path exact-zero', () => {
    const cache = new PointsLinesExpansionCache();
    const offPath = snapshot(undefined);
    const geometry = cache.getOrCreate(offPath, mesh('point-list', 4));
    const plan = createPointsLinesRecordPlan(
      offPath,
      geometry,
      createPointsLinesLaneContract('direct', 'webgpu'),
    );

    expect(offPath.dedicatedResourceBytes).toBe(0);
    expect(geometry.sourceBytes).toBe(0);
    expect(geometry.derivedBytes).toBe(0);
    expect(plan.vertexCount).toBe(0);
    expect(plan.indexCount).toBe(0);
    expect(plan.drawCount).toBe(0);
    expect(plan.graph).toEqual({ additionalAttachments: 0, additionalPasses: 0 });
    expect(plan.shadowDrawCount).toBe(0);
  });

  it('reuses one expansion for 100 entities and stays within triangle bounds', () => {
    const cache = new PointsLinesExpansionCache();
    const authoring = snapshot('Points');
    const source = mesh('point-list', 4);
    const first = cache.getOrCreate(authoring, source);

    for (let entity = 0; entity < 100; entity += 1) {
      expect(cache.getOrCreate(authoring, source)).toBe(first);
    }

    const plan = createPointsLinesRecordPlan(
      authoring,
      first,
      createPointsLinesLaneContract('clustered', 'webgpu'),
    );
    const primitiveCount = first.pointCount + first.segmentCount;
    expect(cache.size).toBe(1);
    expect(plan.vertexCount).toBeLessThanOrEqual(4 * primitiveCount);
    expect(plan.indexCount).toBeLessThanOrEqual(6 * primitiveCount);
    expect(plan.drawCount).toBe(1);
  });

  it('records WebGL2 capability provenance without compute storage or indirect', () => {
    const contract = createPointsLinesLaneContract('cpu-webgl2', 'wgpu-webgl2');

    expect(contract.capabilities).toEqual({ compute: false, storage: false, indirect: false });
    expect(contract.material).toMatchObject({
      source: 'MaterialAsset',
      shadingModel: 'unlit',
      clusteredLighting: false,
      lit: false,
    });
    expect(contract.graph.additionalAttachments).toBe(0);
    expect(contract.graph.additionalPasses).toBe(0);
  });
});
