import type { MeshAsset } from '@forgeax/engine-types';
import { lodTopologyReport } from '../lod-topology';

/** Throws when any LOD (LOD0 included) has a non-manifold edge or a boundary set that differs from LOD0's. */
export function assertLodTopology(lods: readonly MeshAsset[]): void {
  const failures: string[] = [];
  for (const r of lodTopologyReport(lods)) {
    if (r.nonManifoldEdges > 0)
      failures.push(`lod${r.lod}: ${r.nonManifoldEdges} non-manifold edges`);
    if (!r.boundarySetEqualsLod0) failures.push(`lod${r.lod}: boundary set differs from lod0`);
  }
  if (failures.length > 0) throw new Error(`LOD topology gate failed: ${failures.join('; ')}`);
}
