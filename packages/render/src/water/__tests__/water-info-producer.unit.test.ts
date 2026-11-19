import {
  createPlaneGeometry,
  deriveVertexLayoutProjection,
  interleavedMesh,
  packMeshTangentFrame32,
  withVertexColors,
} from '@forgeax/engine-geometry';
import type { MeshAsset } from '@forgeax/engine-types';
import { waterDependencyMeshView } from '@forgeax/engine-water/internal';
import { describe, expect, it } from 'vitest';
import { buildWaterInfoTriangleBuffer } from '../water-info-producer';

function snapshot(mesh: MeshAsset) {
  const freeze = (value: unknown): unknown => {
    if (ArrayBuffer.isView(value))
      return Object.freeze(Array.from(value as unknown as ArrayLike<number>));
    if (Array.isArray(value)) return Object.freeze(value.map(freeze));
    if (value && typeof value === 'object')
      return Object.freeze(
        Object.fromEntries(Object.entries(value).map(([k, v]) => [k, freeze(v)])),
      );
    return value;
  };
  return {
    payload: freeze(mesh),
    kinds: {
      vertices: 'float32' as const,
      indices: mesh.indices instanceof Uint16Array ? ('uint16' as const) : ('uint32' as const),
      attributes: Object.fromEntries(
        Object.entries(mesh.attributes).map(([key, value]) => [
          key,
          value instanceof Uint32Array ? ('uint32' as const) : ('float32' as const),
        ]),
      ),
    },
  };
}

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe('WaterInfo canonical mesh snapshots', () => {
  it('captures the same triangles from authored, canonical and packed tangent storage', () => {
    const authored = createPlaneGeometry(8, 6).unwrap();
    const rows = [
      authored,
      interleavedMesh(authored),
      packMeshTangentFrame32(authored).unwrap(),
    ].map((mesh) => {
      const source = snapshot(mesh);
      const view = waterDependencyMeshView(source.payload, source.kinds);
      expect(view).toBeDefined();
      if (!view) throw new Error('Valid mesh snapshot was rejected');
      return buildWaterInfoTriangleBuffer([{ mesh: view, worldMatrixM: identity, kind: 'water' }]);
    });
    expect(rows[0]?.length).toBeGreaterThan(0);
    expect(rows[1]).toEqual(rows[0]);
    expect(rows[2]).toEqual(rows[0]);
  });

  it('reads river color and position windows from the same frozen packed backing', () => {
    const authored = withVertexColors(
      createPlaneGeometry(8, 6).unwrap(),
      [0.25, 0, 0, 1, 0.5, 0.25, 0, 1, 0.75, 0.5, 0, 1, 1, 0.75, 0, 1],
    ).unwrap();
    const source = snapshot(interleavedMesh(authored));
    const view = waterDependencyMeshView(source.payload, source.kinds);
    expect(view?.color?.data).toBe(view?.position.data);
    expect(view?.position.count).toBe(4);
    expect(view?.color?.count).toBe(4);
    const color = view?.color;
    if (!color) throw new Error('Missing accepted flow color');
    expect(
      Array.from({ length: color.count }, (_, i) => color.data[color.offset + i * color.stride]),
    ).toEqual([0.25, 0.5, 0.75, 1]);
  });

  it('does not reject packed integer words that spell float NaNs', () => {
    const mesh = packMeshTangentFrame32(createPlaneGeometry(8, 6).unwrap()).unwrap();
    const frame = deriveVertexLayoutProjection(mesh.attributes).attributes.find(
      (a) => a.key === 'tangentFrame',
    );
    if (!frame) throw new Error('Missing packed tangent lane');
    new Uint32Array(mesh.vertices.buffer, mesh.vertices.byteOffset, mesh.vertices.length)[
      frame.offset / 4
    ] = 0xffffffff;
    const source = snapshot(mesh);
    expect(waterDependencyMeshView(source.payload, source.kinds)).toBeDefined();
  });

  it.each([
    'stride',
    'position',
    'index',
    'kind',
  ] as const)('rejects an invalid canonical %s', (failure) => {
    const mesh = interleavedMesh(createPlaneGeometry(8, 6).unwrap());
    if (failure === 'position') mesh.vertices[0] = Number.NaN;
    if (failure === 'index') {
      if (mesh.indices === undefined) throw new Error('Indexed plane fixture requires indices');
      mesh.indices[0] = 4;
    }
    const source = snapshot(
      failure === 'stride' ? { ...mesh, vertices: mesh.vertices.slice(1) } : mesh,
    );
    if (failure === 'kind') source.kinds.attributes.position = 'uint32';
    expect(waterDependencyMeshView(source.payload, source.kinds)).toBeUndefined();
  });
});
