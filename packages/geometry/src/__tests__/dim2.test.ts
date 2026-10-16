import {
  compute2dBounds,
  create2dGeometry,
  create2dRingGeometry,
  PROCEDURAL_FLOATS_PER_VERTEX,
  type Shape2d,
} from '@forgeax/engine-geometry';
import { describe, expect, it } from 'vitest';

const FILLED_SHAPES: readonly Shape2d[] = [
  { kind: 'circle', radius: 1, resolution: 12 },
  { kind: 'circular-sector', radius: 1, angle: 1.25, resolution: 12 },
  { kind: 'circular-segment', radius: 1, angle: 1.25, resolution: 12 },
  { kind: 'ellipse', halfWidth: 1.5, halfHeight: 0.75, resolution: 12 },
  { kind: 'annulus', innerRadius: 0.5, outerRadius: 1, resolution: 12 },
  { kind: 'capsule', radius: 0.35, halfLength: 0.65, resolution: 12 },
  { kind: 'rhombus', halfWidth: 1.2, halfHeight: 0.8 },
  { kind: 'rectangle', width: 2, height: 1 },
  { kind: 'regular-polygon', radius: 1, sides: 6 },
  {
    kind: 'triangle',
    vertices: [
      [0, 1],
      [-1, -1],
      [1, -1],
    ],
  },
];

describe('2D primitive geometry', () => {
  it('builds every filled Bevy 2D shape as a triangle MeshAsset', () => {
    for (const shape of FILLED_SHAPES) {
      const result = create2dGeometry(shape);
      expect(result.ok, shape.kind).toBe(true);
      if (!result.ok) continue;
      expect(result.value.submeshes).toEqual([
        expect.objectContaining({ topology: 'triangle-list', indexCount: expect.any(Number) }),
      ]);
      const submesh = result.value.submeshes[0];
      expect(submesh).toBeDefined();
      if (!submesh) continue;
      expect(result.value.vertices.length).toBe(submesh.vertexCount * PROCEDURAL_FLOATS_PER_VERTEX);
      const position = result.value.attributes.position;
      expect(position).toBeInstanceOf(Float32Array);
      if (!(position instanceof Float32Array)) continue;
      expect(position.length).toBe(submesh.vertexCount * 3);
      expect(result.value.aabb).toHaveLength(6);
    }
  });

  it('builds segment and polyline as line-list meshes', () => {
    const segment = create2dGeometry({
      kind: 'segment',
      vertices: [
        [-1, 0],
        [1, 0],
      ],
    });
    const polyline = create2dGeometry({
      kind: 'polyline',
      vertices: [
        [-1, 0],
        [0, 1],
        [1, 0],
      ],
    });
    expect(segment.ok).toBe(true);
    expect(polyline.ok).toBe(true);
    if (!segment.ok || !polyline.ok) return;
    expect(segment.value.submeshes[0]?.topology).toBe('line-list');
    expect(polyline.value.submeshes[0]?.indexCount).toBe(4);
  });

  it('builds the closed ring variants from one shape contract', () => {
    for (const shape of FILLED_SHAPES.filter((candidate) => candidate.kind !== 'annulus')) {
      const result = create2dRingGeometry(shape, 0.1);
      expect(result.ok, shape.kind).toBe(true);
      if (!result.ok) continue;
      expect(result.value.submeshes[0]?.topology).toBe('triangle-list');
      expect(result.value.submeshes[0]?.indexCount).toBeGreaterThan(0);
    }
  });

  it('fails fast for invalid dimensions and unsupported rings', () => {
    expect(create2dGeometry({ kind: 'circle', radius: 0 }).ok).toBe(false);
    expect(create2dGeometry({ kind: 'regular-polygon', radius: 1, sides: 2 }).ok).toBe(false);
    expect(create2dGeometry({ kind: 'polyline', vertices: [[0, 0]] }).ok).toBe(false);
    expect(
      create2dRingGeometry({ kind: 'annulus', innerRadius: 0.2, outerRadius: 1 }, 0.1).ok,
    ).toBe(false);
    expect(create2dRingGeometry({ kind: 'circle', radius: 1 }, 1).ok).toBe(false);
  });

  it('projects circular-mask UVs around a requested texture angle', () => {
    const shape: Shape2d = {
      kind: 'circular-sector',
      radius: 2,
      angle: Math.PI / 2,
      resolution: 8,
    };
    const result = create2dGeometry(shape, { uv: { kind: 'circular-mask', angle: Math.PI / 2 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const uv = result.value.attributes.uv;
    expect(uv).toBeInstanceOf(Float32Array);
    if (!(uv instanceof Float32Array)) return;
    for (const value of uv) expect(value).toBeGreaterThanOrEqual(0);
    for (const value of uv) expect(value).toBeLessThanOrEqual(1);
    expect(
      create2dGeometry(
        { kind: 'rectangle', width: 1, height: 1 },
        { uv: { kind: 'circular-mask', angle: 0 } },
      ).ok,
    ).toBe(false);
  });

  it('computes transformed AABB and bounding circle from the same shape contract', () => {
    const result = compute2dBounds(
      { kind: 'circular-sector', radius: 2, angle: Math.PI / 2, resolution: 16 },
      { translation: [3, -4], rotation: Math.PI / 2 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.aabb[0]).toBeLessThanOrEqual(3);
    expect(result.value.aabb[1]).toBeLessThanOrEqual(-4);
    expect(result.value.aabb[2]).toBeGreaterThanOrEqual(3);
    expect(result.value.aabb[3]).toBeGreaterThanOrEqual(-4);
    expect(result.value.circle[0]).toBeCloseTo(3, 4);
    expect(result.value.circle[1]).toBeCloseTo(-4, 4);
    expect(result.value.circle[2]).toBeCloseTo(2, 4);
  });
});
