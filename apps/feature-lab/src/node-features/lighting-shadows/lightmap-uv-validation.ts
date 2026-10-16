import { packInterleavedVertexAttributes } from '@forgeax/engine/geometry';
import { validateLightmapUvs } from '@forgeax/engine/import';
import type { MeshAsset, VertexAttributeMap } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';

type Uv = readonly [number, number];
type Triangle = readonly [Uv, Uv, Uv];

function mesh(
  triangles: readonly Triangle[],
  uvSet: 'uv1' | 'uv2' | null = 'uv1',
): MeshAsset | undefined {
  const corners = triangles.flat();
  const vertexCount = corners.length;
  const position = new Float32Array(vertexCount * 3);
  const lightmap = new Float32Array(vertexCount * 2);
  for (const [index, [u, v]] of corners.entries()) {
    position.set([u, v, 0], index * 3);
    lightmap.set([u, v], index * 2);
  }
  const attributes: VertexAttributeMap = {
    position,
    uv: new Float32Array(vertexCount * 2),
    ...(uvSet === null ? {} : { [uvSet]: lightmap }),
  };
  const packed = packInterleavedVertexAttributes(attributes, vertexCount);
  if (!packed.ok) return undefined;
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

function quad(u0: number, v0: number, u1: number, v1: number): Triangle[] {
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

function outcome(levels: readonly (MeshAsset | undefined)[], uvSet?: 'uv1' | 'uv2'): string {
  if (levels.some((level) => level === undefined)) return 'fixture-failed';
  const result = validateLightmapUvs(levels as [MeshAsset, ...MeshAsset[]], uvSet);
  if (!result.ok) return result.error.code;
  return result.value.storage === 'per-lod' ? `per-lod:${result.value.diagnostic.code}` : 'shared';
}

export default defineFeature({
  title: 'Lightmap UV validation',
  catalog: 'Lightmap UV validation',
  kind: 'headless',
  summary:
    'validateLightmapUvs checks the lightmap UV set (uv1 by default) on every LOD: presence, finite [0,1] range and non-overlapping charts, then picks shared LOD0 storage or per-LOD storage with a lod-lightmap-uv-mismatch diagnostic.',
  expect:
    'All checks pass: clean LODs share LOD0, a bridging lower LOD falls back to per-lod, and missing / out-of-range / overlapping UVs return their closed error codes.',
  run(checks) {
    const lod0 = mesh([...quad(0.05, 0.05, 0.45, 0.45), ...quad(0.55, 0.05, 0.95, 0.45)]);
    checks.equal('single clean level is shared', outcome([lod0]), 'shared');
    checks.equal(
      'lower LOD inside LOD0 charts is shared',
      outcome([lod0, mesh(quad(0.05, 0.05, 0.45, 0.45))]),
      'shared',
    );
    const bridging = mesh([
      [
        [0.4, 0.1],
        [0.6, 0.1],
        [0.6, 0.4],
      ],
    ]);
    checks.equal(
      'bridging lower LOD falls back to per-lod',
      outcome([lod0, bridging]),
      'per-lod:lod-lightmap-uv-mismatch',
    );
    checks.equal(
      'missing uv1',
      outcome([lod0, mesh(quad(0.1, 0.1, 0.4, 0.4), null)]),
      'lightmap-uv-missing',
    );
    const outside = mesh([
      [
        [0.1, 0.1],
        [1.2, 0.1],
        [0.1, 0.5],
      ],
    ]);
    checks.equal('out-of-range uv', outcome([outside]), 'lightmap-uv-out-of-range');
    checks.equal(
      'overlapping charts',
      outcome([mesh([...quad(0.1, 0.1, 0.5, 0.5), ...quad(0.3, 0.3, 0.7, 0.7)])]),
      'lightmap-uv-overlap',
    );
    const uv2 = mesh(quad(0.1, 0.1, 0.9, 0.9), 'uv2');
    checks.equal('declared uv2 set validates', outcome([uv2], 'uv2'), 'shared');
    checks.equal('default uv1 missing on a uv2 mesh', outcome([uv2]), 'lightmap-uv-missing');
  },
});
