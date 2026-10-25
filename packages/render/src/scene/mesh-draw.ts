import { meshGeometryDraws } from '../gpu-driven/mesh-batches';
import type { RenderableSnapshot } from '../render-system-extract';
import {
  GenerationalWeakMap,
  identityOrdinal,
  versionedGet,
  versionedSet,
} from './generational-weak-map';
import type { MeshFrame } from './mesh-frame';
import { effectiveMeshMaterials, meshMaterialGeometry } from './mesh-materials';

// Pose-only source replacements are new snapshots every frame. One generational
// table names the Mesh version by ordinal, so neither a dead source nor an
// obsolete Mesh version stays resident until a full collection.
const draws = new GenerationalWeakMap<
  RenderableSnapshot,
  readonly { readonly version: number; readonly value: RenderableSnapshot }[]
>();

/**
 * The effective draw materials only, without a draw snapshot. Pose-only
 * replacements reuse the per-Mesh override binding, so temporal and GPU Scene
 * readers avoid rebuilding the complete draw row for every moved instance.
 */
export function meshDrawMaterials(
  source: RenderableSnapshot,
  meshes: MeshFrame,
): Pick<RenderableSnapshot, 'material' | 'materials'> {
  if (source.terrain !== undefined || source.materialOverrides === undefined) return source;
  const mesh = meshes.get(source.worldId, source.assetHandle);
  return mesh === undefined
    ? source
    : effectiveMeshMaterials(source, mesh, meshMaterialGeometry(source));
}

/** Draw consumption combines instance facts with the frame's shared geometry and bindings. */
export function meshDrawSnapshot(
  source: RenderableSnapshot,
  meshes: MeshFrame,
): RenderableSnapshot {
  const mesh = meshes.get(source.worldId, source.assetHandle);
  if (mesh === undefined || source.terrain !== undefined || source.materialOverrides === undefined)
    return source;
  const meshOrdinal = identityOrdinal(mesh);
  const cached = versionedGet(draws, source, meshOrdinal);
  if (cached !== undefined) return cached.value;
  const { lods: _lods, lodHysteresis: _hysteresis, localAabb: _bounds, ...current } = source;
  const materials = effectiveMeshMaterials(source, mesh, meshMaterialGeometry(source));
  const result: RenderableSnapshot = {
    ...current,
    ...materials,
    ...(source.morph === undefined && source.gpuDrivenDraws !== undefined
      ? {
          gpuDrivenDraws: meshGeometryDraws(
            mesh,
            materials.materials,
            source.skinBinding === undefined ? 'rigid' : 'skin',
          ),
        }
      : {}),
    ...(mesh.bounds === undefined ? {} : { localAabb: mesh.bounds }),
    ...(mesh.lods === undefined ? {} : { lods: mesh.lods }),
    ...(mesh.lodHysteresis === undefined ? {} : { lodHysteresis: mesh.lodHysteresis }),
  };
  versionedSet(draws, source, { version: meshOrdinal, value: result });
  return result;
}
