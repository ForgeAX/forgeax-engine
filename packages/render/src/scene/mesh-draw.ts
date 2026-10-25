import { meshGeometryDraws } from '../gpu-driven/mesh-batches';
import type { RenderableSnapshot } from '../render-system-extract';
import type { MeshFrame, MeshGeometry } from './mesh-frame';
import { effectiveMeshMaterials, meshMaterialGeometry } from './mesh-materials';

// Pose-only source replacements share one weak instance table per Mesh version.
// Two generations: a projection stays shared while consecutive frames read it,
// and a cold complete read never stays resident beside every source row.
type DrawTables = WeakMap<MeshGeometry, WeakMap<RenderableSnapshot, RenderableSnapshot>>;
let draws: DrawTables = new WeakMap();
let previousDraws: DrawTables = new WeakMap();

/** Start a new read generation; projections the last generation read stay shared. */
export function rotateMeshDraws(): void {
  previousDraws = draws;
  draws = new WeakMap();
}

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
  let instances = draws.get(mesh);
  if (instances === undefined) {
    instances = new WeakMap();
    draws.set(mesh, instances);
  }
  const cached = instances.get(source) ?? previousDraws.get(mesh)?.get(source);
  if (cached !== undefined) {
    instances.set(source, cached);
    return cached;
  }
  const { lods: _lods, lodHysteresis: _hysteresis, localAabb: _bounds, ...current } = source;
  const materials = effectiveMeshMaterials(source, mesh, meshMaterialGeometry(source));
  const result: RenderableSnapshot = {
    ...current,
    ...materials,
    ...(source.gpuDrivenDraws !== undefined
      ? {
          gpuDrivenDraws: meshGeometryDraws(
            mesh,
            materials.materials,
            source.skinBinding === undefined ? 'rigid' : 'skin',
          ),
        }
      : {}),
    // Morphed rows keep their weight-expanded producer bounds.
    ...(source.morph !== undefined
      ? source.localAabb === undefined
        ? {}
        : { localAabb: source.localAabb }
      : mesh.bounds === undefined
        ? {}
        : { localAabb: mesh.bounds }),
    ...(mesh.lods === undefined ? {} : { lods: mesh.lods }),
    ...(mesh.lodHysteresis === undefined ? {} : { lodHysteresis: mesh.lodHysteresis }),
  };
  instances.set(source, result);
  return result;
}
