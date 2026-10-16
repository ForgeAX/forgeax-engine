import { err, type MeshAsset, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { type PointsLinesExpandedGeometry, PointsLinesExpansionCache } from '../expansion-cache';
import { type PointsLinesGpuResourceAdapter, PointsLinesPreparation } from '../prepare';
import { createPointsLinesLaneContract, createPointsLinesRecordPlan } from '../record';
import { createPointsLinesSnapshot } from '../snapshot';

function mesh(generation = 1): MeshAsset {
  return {
    kind: 'mesh',
    vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
    indices: new Uint16Array([0, 1, 2, 3]),
    attributes: { position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]) },
    aabb: new Float32Array([0, 0, 0, 1, 1, 0]),
    submeshes: [
      { indexOffset: 0, indexCount: 4, vertexCount: 4, topology: 'line-list', materialSlot: 0 },
    ],
    materialSlots: [{ slotName: `lines-${generation}` }],
  };
}

function snapshot(meshGeneration = 1, materialGeneration = 1) {
  return createPointsLinesSnapshot({
    worldId: 0,
    entityKey: 4,
    component: 'Lines',
    meshHandle: 9,
    meshGeneration,
    materialHandle: 12,
    materialGeneration,
    style: { kind: 'lines', width: 3 },
    layer: 0,
    visible: true,
    sourceBounds: new Float32Array([0, 0, 0, 1, 1, 0]),
    viewport: { width: 320, height: 200, dpr: 1 },
    projection: new Float32Array(16),
  });
}

describe('Points/Lines expansion cache and LKG recovery', () => {
  it('reuses geometry when style changes and keeps style out of the cache key', () => {
    const cache = new PointsLinesExpansionCache();
    const first = cache.getOrCreate(snapshot(), mesh());
    const styled = cache.getOrCreate(
      createPointsLinesSnapshot({
        ...snapshot(),
        style: { kind: 'lines', width: 9 },
      }),
      mesh(),
    );
    const material = cache.getOrCreate(snapshot(1, 2), mesh());

    expect(first).toBe(styled);
    expect(first).toBe(material);
    expect(first.key).toContain('mesh:9:1');
    expect(styled.key).not.toContain('width=9');
    expect(styled.vertices).toEqual(first.vertices);
    expect(styled.positions).toEqual(first.positions);
    expect(first).toEqual<PointsLinesExpandedGeometry>(
      expect.objectContaining({ sourceVertexCount: 4, segmentCount: 2 }),
    );
  });

  it('destroys only a failed candidate and retains the previous live resource', () => {
    const calls: string[] = [];
    let failValidation = false;
    const adapter: PointsLinesGpuResourceAdapter<string> = {
      create: () => {
        calls.push('create');
        return ok(`resource-${calls.filter((call) => call === 'create').length}`);
      },
      upload: (resource) => {
        calls.push(`upload:${resource}`);
        return ok(64);
      },
      validate: (resource) => {
        calls.push(`validate:${resource}`);
        return failValidation ? err(new Error('candidate validation fault')) : ok(undefined);
      },
      destroy: (resource) => calls.push(`destroy:${resource}`),
    };
    const preparation = new PointsLinesPreparation({
      cache: new PointsLinesExpansionCache(),
      adapter,
    });

    const first = preparation.prepare(snapshot(), mesh());
    expect(first.ok).toBe(true);
    failValidation = true;
    const failed = preparation.prepare(snapshot(2), mesh(2));

    expect(failed.ok).toBe(false);
    expect(calls).toContain('destroy:resource-2');
    expect(preparation.inspect()).toMatchObject({
      status: 'resident',
      lastKnownGood: true,
      liveResource: 'resource-1',
      candidateBytes: 0,
    });
    expect(preparation.inspect().liveBytes).toBe(
      preparation.lastKnownGood()?.geometry.derivedBytes,
    );
    expect(preparation.lastKnownGood()?.resource).toBe('resource-1');
  });

  it('reuses geometry for a changed style and records its new physical-pixel draw plan', () => {
    let uploads = 0;
    const adapter: PointsLinesGpuResourceAdapter<string> = {
      create: (geometry) => ok(geometry.key),
      upload: (_resource, geometry) => {
        uploads += 1;
        return ok(geometry.derivedBytes);
      },
      validate: () => ok(undefined),
      destroy: () => undefined,
    };
    const preparation = new PointsLinesPreparation({
      cache: new PointsLinesExpansionCache(),
      adapter,
    });
    const first = preparation.prepare(snapshot(), mesh()).unwrap();
    const changedSnapshot = createPointsLinesSnapshot({
      ...snapshot(),
      style: { kind: 'lines', width: 9 },
    });
    const changed = preparation.prepare(changedSnapshot, mesh()).unwrap();
    const plan = createPointsLinesRecordPlan(
      changedSnapshot,
      changed.geometry,
      createPointsLinesLaneContract('direct', 'webgpu'),
    );

    expect(uploads).toBe(1);
    expect(changed.geometry).toBe(first.geometry);
    expect(plan.conservativeMargin).toBe(18);
    expect(changed.geometry.vertices).toEqual(first.geometry.vertices);
  });

  it('rebuilds from the retained snapshot after device loss without stale bytes', () => {
    const adapter: PointsLinesGpuResourceAdapter<string> = {
      create: () => ok('fresh'),
      upload: () => ok(64),
      validate: () => ok(undefined),
      destroy: () => undefined,
    };
    const preparation = new PointsLinesPreparation({
      cache: new PointsLinesExpansionCache(),
      adapter,
    });

    expect(preparation.prepare(snapshot(), mesh()).ok).toBe(true);
    preparation.resetForDeviceLoss();
    expect(preparation.inspect()).toMatchObject({ status: 'rebuild-pending', liveBytes: 0 });
    expect(preparation.prepare(snapshot(), mesh()).ok).toBe(true);
    expect(preparation.inspect()).toMatchObject({ status: 'resident', lastKnownGood: true });
  });

  it('abandons lost-device handles without invoking the dead-device destroy path', () => {
    let destroys = 0;
    const preparation = new PointsLinesPreparation({
      cache: new PointsLinesExpansionCache(),
      adapter: {
        create: () => ok('lost-device-resource'),
        upload: () => ok(64),
        validate: () => ok(undefined),
        destroy: () => {
          destroys += 1;
        },
      },
    });

    expect(preparation.prepare(snapshot(), mesh()).ok).toBe(true);
    preparation.abandonForDeviceLoss();
    preparation.abandonForDeviceLoss();

    expect(destroys).toBe(0);
    expect(preparation.inspect()).toMatchObject({ status: 'rebuild-pending', liveBytes: 0 });
  });
});
