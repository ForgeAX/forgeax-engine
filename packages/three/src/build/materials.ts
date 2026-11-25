import type MeshPhysicalNodeMaterial from 'three/src/materials/nodes/MeshPhysicalNodeMaterial.js';
import type { MeshPhysicalMaterial } from 'three/src/Three.Core.js';
import { materialTextures, TEXTURE_SLOTS } from '../material';
import { cookPhysicalRecords } from './physical-cook';
import { packMaterialPrograms } from './program-publication';

export type PhysicalTextureSlot = Exclude<keyof typeof TEXTURE_SLOTS, 'matcap'>;

/** Inspect authored map membership at build time, using the player's normal/bump selection. */
export function physicalTextureRecipe(
  material: MeshPhysicalMaterial | MeshPhysicalNodeMaterial,
): readonly PhysicalTextureSlot[] {
  const parameters = new Set(
    materialTextures(material as MeshPhysicalMaterial).map(([parameter]) => parameter),
  );
  return (Object.keys(TEXTURE_SLOTS) as (keyof typeof TEXTURE_SLOTS)[])
    .filter(
      (slot): slot is PhysicalTextureSlot =>
        slot !== 'matcap' && parameters.has(TEXTURE_SLOTS[slot]),
    )
    .sort();
}

/** Build-time native Cook. Each set is an exact texture-membership variant;
 * numeric Physical values remain editable at runtime. Include each custom set
 * an application uses when adding or removing maps. */
export async function cookPhysicalMaterials(
  textureSets: readonly (readonly PhysicalTextureSlot[])[],
): Promise<string> {
  const records = await cookPhysicalRecords(textureSets);
  return packMaterialPrograms(records);
}

export { cookThreeSurface } from './surface';
