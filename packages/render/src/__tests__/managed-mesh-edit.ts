import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import type { AssetHandle, MeshAsset } from '@forgeax/engine-types';
import { assert } from 'vitest';
import type { GpuResidencyCache } from '../device/gpu-residency';
import type { RenderResourceScope } from '../publication/resource-scope';

/** Exercise the same accepted asset evidence consumed by managed residency. */
export function editResidentMesh(
  assets: AssetRegistry,
  store: GpuResidencyCache,
  handle: AssetHandle<'mesh'>,
  edit: () => void,
  scope: RenderResourceScope | number = 0,
) {
  const observer = assets.observe().unwrap();
  try {
    edit();
    const batch = observer.read().unwrap();
    const change = batch.changes.find((item) => item.handle === handle);
    assert(change);
    const source = runtimeAssets(assets).borrow<MeshAsset>(handle).unwrap();
    store.adoptMeshChange(change, source, scope).unwrap();
    batch.accept();
    return store.ensureResident(handle, source, scope).unwrap();
  } finally {
    observer.dispose();
  }
}

/** Grow the box witness without changing its indexed triangles. */
export function duplicateMeshVertices(source: MeshAsset): MeshAsset {
  const repeat = (values: Float32Array) => {
    const result = new Float32Array(values.length * 2);
    result.set(values);
    result.set(values, values.length);
    return result;
  };
  return {
    ...source,
    vertices: repeat(source.vertices),
    attributes: Object.fromEntries(
      Object.entries(source.attributes).map(([name, values]) => {
        assert(values instanceof Float32Array);
        return [name, repeat(values)];
      }),
    ),
    submeshes: source.submeshes.map((submesh) => ({
      ...submesh,
      vertexCount: submesh.vertexCount * 2,
    })),
  };
}
