import { meshGeometryDraws } from '../gpu-driven/mesh-batches';
import type { RenderableSnapshot } from '../render-system-extract';
import type { MeshFrame, MeshGeometry } from './mesh-frame';
import { effectiveMeshMaterials, meshMaterialGeometry } from './mesh-materials';

// Pose-only source replacements share one weak instance table per Mesh version.
const draws = new WeakMap<MeshGeometry, WeakMap<RenderableSnapshot, RenderableSnapshot>>();

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
  const cached = instances.get(source);
  if (cached !== undefined) return cached;
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
  instances.set(source, result);
  return result;
}
