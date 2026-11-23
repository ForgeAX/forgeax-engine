import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import type { Buffer, RhiQueue } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { type MeshAsset, ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { Materials } from '../../materials';
import { worldRenderResources } from '../../publication/resource-scope';
import type { ValidatedRenderable } from '../../record/frame-snapshot';
import type { RenderSystemInternals } from '../../record/render-context';
import { writePointsLinesViewUbo } from '../../record/view-ubo';
import type { CameraSnapshot } from '../../render-contract';
import { RenderView } from '../../world/render-views';
import { createRenderWorld } from '../../world/render-world';
import { adoptViewPointsLines } from '../../world/view-points-lines';
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

  it('shares quad indices across equal point counts without changing held vertices', () => {
    const cache = new PointsLinesExpansionCache();
    const first = cache.getOrCreate(
      snapshot(1),
      cloud({ position: new Float32Array([1, 2, 3]), color: new Float32Array([1, 0, 0, 1]) }),
    );
    const next = cache.getOrCreate(
      snapshot(2),
      cloud({ position: new Float32Array([4, 5, 6]), color: new Float32Array([0, 1, 0, 1]) }),
    );
    const resized = cache.getOrCreate(
      snapshot(3),
      cloud({ position: new Float32Array([4, 5, 6, 7, 8, 9]) }),
    );
    expect(next.indices).toBe(first.indices);
    expect(resized.indices).not.toBe(next.indices);
    expect([...resized.indices]).toEqual([0, 1, 2, 2, 1, 3, 4, 5, 6, 6, 5, 7]);
    expect(vertex(first.vertices, 0, 0)).toEqual([1, 2, 3, 1, 0, 0, -1, -1, 1, 0, 0, 1]);
    expect(vertex(next.vertices, 0, 0)).toEqual([4, 5, 6, 1, 0, 0, -1, -1, 0, 1, 0, 1]);
  });

  it('uploads only vertices for a resident same-count edit and uploads resized indices', async () => {
    const assets = new AssetRegistry();
    const world = new World({ assets });
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const writes = vi.spyOn(device.queue, 'writeBuffer');
    const renderWorld = createRenderWorld();
    const view = renderWorld.spawn({ component: RenderView, data: { primary: true } }).unwrap();
    const owner = adoptViewPointsLines(renderWorld, view, { device } as RenderSystemInternals);
    const mesh = assets.create(cloud({ position: new Float32Array([1, 2, 3]) })).unwrap();
    const material = assets.create(Materials.unlit([1, 1, 1, 1])).unwrap();
    const entry = {
      source: {
        assetHandle: mesh,
        pointsLines: { ...snapshot(1), meshHandle: mesh, materialHandle: material },
      },
      world: worldRenderResources(world),
    } as unknown as ValidatedRenderable;
    try {
      const first = owner.prepare(entry, false);
      expect(first).toBeDefined();
      if (first === undefined) throw new Error('expected drawable points');
      expect(writes.mock.calls.map(([buffer]) => buffer)).toEqual([
        first.vertexBuffer,
        first.indexBuffer,
      ]);

      writes.mockClear();
      assets.replace(mesh, cloud({ position: new Float32Array([4, 5, 6]) })).unwrap();
      expect(owner.prepare(entry, false)?.indexBuffer).toBe(first.indexBuffer);
      expect(writes.mock.calls.map(([buffer]) => buffer)).toEqual([first.vertexBuffer]);

      writes.mockClear();
      assets.replace(mesh, cloud({ position: new Float32Array([4, 5, 6, 7, 8, 9]) })).unwrap();
      const resized = owner.prepare(entry, false);
      expect(resized).toBeDefined();
      expect(resized?.indexBuffer).not.toBe(first.indexBuffer);
      expect(writes.mock.calls.map(([buffer]) => buffer)).toEqual([
        resized?.vertexBuffer,
        resized?.indexBuffer,
      ]);
    } finally {
      owner.dispose();
      assets.dispose();
    }
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
