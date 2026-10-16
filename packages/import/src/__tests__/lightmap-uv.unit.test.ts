import { packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import type { MeshAsset, VertexAttributeMap } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { type LightmapUvSet, validateLightmapUvs } from '../lightmap-uv.js';

type Uv = readonly [number, number];

/** One triangle-list mesh whose `uvSet` carries the given per-triangle UVs. */
function mesh(
  triangles: readonly (readonly [Uv, Uv, Uv])[],
  uvSet: LightmapUvSet | null = 'uv1',
): MeshAsset {
  const corners = triangles.flat();
  const vertexCount = corners.length;
  const position = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const lightmap = new Float32Array(vertexCount * 2);
  for (const [index, [u, v]] of corners.entries()) {
    position.set([u, v, 0], index * 3);
    lightmap.set([u, v], index * 2);
  }
  const attributes: VertexAttributeMap = {
    position,
    uv,
    ...(uvSet === null || uvSet === 'uv' ? {} : { [uvSet]: lightmap }),
  };
  const packed = packInterleavedVertexAttributes(attributes, vertexCount);
  if (!packed.ok) throw new Error(packed.error.message);
  return {
    kind: 'mesh',
    vertices: packed.value.vertices,
    indices: Uint32Array.from({ length: vertexCount }, (_, index) => index),
    attributes,
    submeshes: [
      {
        indexOffset: 0,
        indexCount: vertexCount,
        vertexCount,
        topology: 'triangle-list',
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'default' }],
  };
}

function quad(u0: number, v0: number, u1: number, v1: number): (readonly [Uv, Uv, Uv])[] {
  return [
    [
      [u0, v0],
      [u1, v0],
      [u1, v1],
    ],
    [
      [u0, v0],
      [u1, v1],
      [u0, v1],
    ],
  ];
}

/** 2x2 grid of quads: interior shared edges and vertices must not count as overlap. */
function gridChart(u0: number, v0: number, u1: number, v1: number): (readonly [Uv, Uv, Uv])[] {
  const um = (u0 + u1) / 2;
  const vm = (v0 + v1) / 2;
  return [
    ...quad(u0, v0, um, vm),
    ...quad(um, v0, u1, vm),
    ...quad(u0, vm, um, v1),
    ...quad(um, vm, u1, v1),
  ];
}

const lod0 = mesh([...gridChart(0.05, 0.05, 0.45, 0.45), ...gridChart(0.55, 0.05, 0.95, 0.45)]);

describe('validateLightmapUvs', () => {
  it('selects shared LOD0 storage when lower LOD charts stay inside LOD0 coverage', () => {
    const lod1 = mesh([...quad(0.05, 0.05, 0.45, 0.45), ...quad(0.55, 0.05, 0.95, 0.45)]);
    expect(validateLightmapUvs([lod0, lod1])).toEqual({ ok: true, value: { storage: 'shared' } });
    expect(validateLightmapUvs([lod0])).toEqual({ ok: true, value: { storage: 'shared' } });
  });

  it('falls back to per-LOD storage with lod-lightmap-uv-mismatch when a lower LOD leaves the charts', () => {
    // Every vertex lies on LOD0 charts, but the triangle bridges the gap between them.
    const bridging = mesh([
      [
        [0.4, 0.1],
        [0.6, 0.1],
        [0.6, 0.4],
      ],
    ]);
    const result = validateLightmapUvs([lod0, bridging]);
    expect(result).toMatchObject({
      ok: true,
      value: {
        storage: 'per-lod',
        diagnostic: {
          code: 'lod-lightmap-uv-mismatch',
          detail: { lodIndex: 1, uvSet: 'uv1', triangle: 0 },
        },
      },
    });
  });

  it('reports lightmap-uv-missing for the first level without the lightmap UV set', () => {
    const lod1 = mesh(quad(0.05, 0.05, 0.45, 0.45), null);
    expect(validateLightmapUvs([lod0, lod1])).toMatchObject({
      ok: false,
      error: { code: 'lightmap-uv-missing', detail: { lodIndex: 1, uvSet: 'uv1' } },
    });
  });

  it('reports lightmap-uv-out-of-range for non-unit or non-finite UVs', () => {
    const outside = mesh([
      [
        [0.1, 0.1],
        [1.2, 0.1],
        [0.1, 0.5],
      ],
    ]);
    expect(validateLightmapUvs([outside])).toMatchObject({
      ok: false,
      error: { code: 'lightmap-uv-out-of-range', detail: { lodIndex: 0, vertexIndex: 1 } },
    });
    const nan = mesh([
      [
        [0.1, 0.1],
        [0.2, Number.NaN],
        [0.1, 0.5],
      ],
    ]);
    expect(validateLightmapUvs([nan])).toMatchObject({
      ok: false,
      error: { code: 'lightmap-uv-out-of-range', detail: { vertexIndex: 1 } },
    });
  });

  it('reports lightmap-uv-overlap for overlapping LOD0 charts', () => {
    const overlapping = mesh([...quad(0.1, 0.1, 0.5, 0.5), ...quad(0.3, 0.3, 0.7, 0.7)]);
    expect(validateLightmapUvs([overlapping])).toMatchObject({
      ok: false,
      error: { code: 'lightmap-uv-overlap', detail: { lodIndex: 0 } },
    });
  });

  it('checks lower-level overlap only when that level is baked on its own', () => {
    const doubled = mesh([...quad(0.05, 0.05, 0.45, 0.45), ...quad(0.05, 0.05, 0.45, 0.45)]);
    expect(validateLightmapUvs([lod0, doubled])).toEqual({
      ok: true,
      value: { storage: 'shared' },
    });
    const doubledOutside = mesh([
      ...quad(0.05, 0.05, 0.45, 0.45),
      ...quad(0.05, 0.5, 0.45, 0.9),
      ...quad(0.05, 0.5, 0.45, 0.9),
    ]);
    expect(validateLightmapUvs([lod0, doubledOutside])).toMatchObject({
      ok: false,
      error: { code: 'lightmap-uv-overlap', detail: { lodIndex: 1 } },
    });
  });

  it('validates a declared non-default lightmap UV set', () => {
    const uv2 = mesh(quad(0.1, 0.1, 0.9, 0.9), 'uv2');
    expect(validateLightmapUvs([uv2], 'uv2')).toEqual({ ok: true, value: { storage: 'shared' } });
    expect(validateLightmapUvs([uv2])).toMatchObject({
      ok: false,
      error: { code: 'lightmap-uv-missing', detail: { uvSet: 'uv1' } },
    });
  });
});
