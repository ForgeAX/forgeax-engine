import {
  createBoxGeometry,
  createCapsuleGeometry,
  createConeGeometry,
  createCylinderGeometry,
  createPlaneGeometry,
  createSphereGeometry,
  createTorusGeometry,
  meshFromInterleaved,
  withVertexColor,
} from '@forgeax/engine-geometry';
import { box3 } from '@forgeax/engine-math';
import { definePack } from '@forgeax/engine-pack/source';
import type { AssetError, MeshAsset, Result } from '@forgeax/engine-types';
import { ok } from '@forgeax/engine-types';
import {
  CONTENT_MESH_NAMES,
  CONTENT_PACKAGE_IDS,
  CONTENT_SOURCE_KEYS,
  type ContentMeshName,
  contentGuid,
} from '../src/ids.ts';

/** Turn an XY quad facing +Z into an XZ floor facing +Y; a rotation keeps winding. */
function faceUp(mesh: MeshAsset): MeshAsset {
  const rotate = (source: Float32Array | undefined, stride: number) => {
    const out = new Float32Array(source ?? []);
    for (let index = 0; index < out.length; index += stride) {
      const y = out[index + 1] ?? 0;
      out[index + 1] = out[index + 2] ?? 0;
      out[index + 2] = 0 - y;
    }
    return out;
  };
  const position = rotate(mesh.attributes.position as Float32Array, 3);
  return {
    ...mesh,
    attributes: {
      ...mesh.attributes,
      position,
      normal: rotate(mesh.attributes.normal as Float32Array, 3),
      tangent: rotate(mesh.attributes.tangent as Float32Array, 4),
    },
    aabb: box3.fromPositions(box3.create(), position),
  };
}

const FACTORIES: Readonly<Record<ContentMeshName, () => Result<MeshAsset, AssetError>>> = {
  cube: () => createBoxGeometry(1, 1, 1),
  sphere: () => createSphereGeometry(0.5, 48, 32),
  cylinder: () => createCylinderGeometry(0.5, 0.5, 1, 48, 1),
  cone: () => createConeGeometry(0.5, 1, 48, 1),
  torus: () => createTorusGeometry(0.375, 0.125, 24, 64),
  capsule: () => createCapsuleGeometry(0.25, 0.5, 8, 32),
  plane: () => {
    const quad = createPlaneGeometry(1, 1);
    return quad.ok ? ok(faceUp(quad.value)) : quad;
  },
  quad: () => createPlaneGeometry(1, 1),
  'nine-slice-quad': () => createPlaneGeometry(1, 1, 3, 3),
  triangle: () =>
    meshFromInterleaved(
      // position xyz, normal xyz, uv; counter-clockwise when viewed from +Z.
      new Float32Array([
        0, 0.5, 0, 0, 0, 1, 0.5, 0, -0.5, -0.5, 0, 0, 0, 1, 0, 1, 0.5, -0.5, 0, 0, 0, 1, 1, 1,
      ]),
      new Uint16Array([0, 1, 2]),
    ),
};

const WHITE = [1, 1, 1, 1] as const;

export default definePack({
  schemaVersion: '2.0.0',
  packageId: CONTENT_PACKAGE_IDS.meshes,
  name: 'Engine Content / Meshes',
  build: () => {
    const defaultMaterial = contentGuid(
      CONTENT_PACKAGE_IDS.materials,
      CONTENT_SOURCE_KEYS.defaultMaterial,
    );
    const outputs: Record<string, MeshAsset> = {};
    for (const name of CONTENT_MESH_NAMES) {
      const created = FACTORIES[name]();
      if (!created.ok) return created;
      const colored = withVertexColor(created.value, WHITE);
      if (!colored.ok) return colored;
      outputs[CONTENT_SOURCE_KEYS.mesh(name)] = {
        ...colored.value,
        materialSlots: [
          { slotName: 'Default', sourceKey: `engine-content:${name}`, defaultMaterial },
        ],
      };
    }
    return ok(outputs);
  },
});
