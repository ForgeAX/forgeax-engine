import { vec3 } from '@forgeax/engine-math';
import type { Buffer, RhiQueue } from '@forgeax/engine-rhi';
import { type MeshAsset, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { writePointsLinesViewUbo } from '../../record/view-ubo';
import type { CameraSnapshot } from '../../render-contract';
import { PointsLinesExpansionCache } from '../expansion-cache';
import type { PointsLinesStyle } from '../snapshot';
import { createPreparedPointsLinesSnapshot } from './snapshot-fixture';

function cloud(attributes: MeshAsset['attributes']): MeshAsset {
  const position = attributes.position as Float32Array;
  return {
    kind: 'mesh',
    vertices: position,
    attributes,
    aabb: new Float32Array([0, 0, 0, 1, 1, 1]),
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 0,
        vertexCount: position.length / 3,
        topology: 'point-list',
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'default' }],
  };
}

function snapshot(meshGeneration: number) {
  return createPreparedPointsLinesSnapshot({
    worldId: 0,
    entityKey: 1,
    component: 'Points',
    meshHandle: 5,
    meshGeneration,
    materialHandle: 6,
    materialGeneration: 1,
    style: { kind: 'points', size: 0.5, sizeUnits: 'world', shape: 'soft' },
    layer: 0,
    visible: true,
    sourceBounds: [0, 0, 0, 1, 1, 1],
    viewport: { width: 64, height: 64, dpr: 1 },
    projection: new Float32Array(16),
  });
}

/** Expanded point vertex: center(3), size scale + 2 unused, corner(2), RGBA tint(4). */
function vertex(vertices: Float32Array, point: number, corner: number): number[] {
  const offset = (point * 4 + corner) * 12;
  return [...vertices.subarray(offset, offset + 12)];
}

describe('Point sprites', () => {
  it('carries the per-point color stream and uv1 size scale into every sprite corner', () => {
    const cache = new PointsLinesExpansionCache();
    const geometry = cache.getOrCreate(
      snapshot(1),
      cloud({
        position: new Float32Array([1, 2, 3, 4, 5, 6]),
        color: new Float32Array([1, 0.5, 0, 0.25, 0, 0, 1, 1]),
        uv1: new Float32Array([2, 0, 0.5, 0]),
      }),
    );
    expect(geometry).toMatchObject({
      pointCount: 2,
      expandedVertexCount: 8,
      expandedIndexCount: 12,
    });
    expect(vertex(geometry.vertices, 0, 0)).toEqual([1, 2, 3, 2, 0, 0, -1, -1, 1, 0.5, 0, 0.25]);
    expect(vertex(geometry.vertices, 1, 3)).toEqual([4, 5, 6, 0.5, 0, 0, 1, 1, 0, 0, 1, 1]);
    expect([...geometry.indices.subarray(6)]).toEqual([4, 5, 6, 6, 5, 7]);
  });

  it('defaults to an opaque white tint and unit size without color or uv1 streams', () => {
    const geometry = new PointsLinesExpansionCache().getOrCreate(
      snapshot(1),
      cloud({ position: new Float32Array([0, 0, 0]) }),
    );
    expect(vertex(geometry.vertices, 0, 1)).toEqual([0, 0, 0, 1, 0, 0, -1, 1, 1, 1, 1, 1]);
  });

  it('drops a superseded generation so per-frame writes retain one expansion', () => {
    const cache = new PointsLinesExpansionCache();
    for (let generation = 1; generation <= 300; generation++) {
      const moved = new Float32Array([generation, 0, 0]);
      expect(cache.getOrCreate(snapshot(generation), cloud({ position: moved })).positions[0]).toBe(
        generation,
      );
    }
    expect(cache.size).toBe(1);
  });

  it('uploads world-size attenuation and the soft shape label', () => {
    let payload = new Float32Array();
    const queue = {
      writeBuffer: (_buffer: Buffer, _offset: number, data: Float32Array) => {
        payload = new Float32Array(data);
        return ok(undefined);
      },
    } as unknown as RhiQueue;
    const camera = {
      position: vec3.create(0, 0, 3),
      world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 3, 1]),
      fov: Math.PI / 2,
      aspect: 1,
      near: 0.1,
      far: 100,
      projection: 'perspective',
    } as CameraSnapshot;
    const style = (sizeUnits: 'pixels' | 'world'): PointsLinesStyle => ({
      kind: 'points',
      size: 0.25,
      sizeUnits,
      shape: 'soft',
    });
    writePointsLinesViewUbo(queue, {} as Buffer, camera, 200, 100, undefined, style('world'));
    // tan(fov / 2) = 1, so the vertical focal factor is half the target height.
    expect(payload[36]).toBeCloseTo(0.25);
    expect(payload[37]).toBe(0);
    expect(payload[38]).toBe(2);
    expect(payload[39]).toBeCloseTo(50, 4);
    writePointsLinesViewUbo(queue, {} as Buffer, camera, 200, 100, undefined, style('pixels'));
    expect(payload[39]).toBe(0);
  });
});
