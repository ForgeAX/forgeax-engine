import { AssetGuid } from '@forgeax/engine/pack/guid';
import type { MeshAsset } from '@forgeax/engine/types';

/** Generated geometry retains its default material as an explicit Pack reference. */
export function geometryMeshReferences(mesh: MeshAsset): string[] {
  return [
    ...new Set(
      mesh.materialSlots.flatMap((slot) => {
        if (slot.defaultMaterial === undefined) return [];
        if (typeof slot.defaultMaterial === 'number')
          throw new Error('Generated geometry publication requires source material GUIDs');
        return [AssetGuid.format(slot.defaultMaterial).toLowerCase()];
      }),
    ),
  ];
}
