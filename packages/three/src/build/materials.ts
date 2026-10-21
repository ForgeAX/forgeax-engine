import { compressZstd } from '@forgeax/engine-codec/encode';
import { serializeCookedMaterialRecord, validateCookedMaterialRecord } from '@forgeax/engine-pack';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { withClipping } from '@forgeax/engine-types';
import { MeshPhysicalMaterial } from 'three/src/Three.Core.js';
import { projectMaterial, TEXTURE_SLOTS } from '../material';

export type PhysicalTextureSlot = Exclude<keyof typeof TEXTURE_SLOTS, 'matcap'>;

/** Build-time native Cook. Each set is an exact texture-membership variant;
 * numeric Physical values remain editable at runtime. No shader compiler ships
 * in the player entry. Include both sets when an application adds/removes a map. */
export async function cookPhysicalMaterials(
  textureSets: readonly (readonly PhysicalTextureSlot[])[],
): Promise<string> {
  const cooker = createMaterialPackCooker([], { profile: 'webgpu-storage' });
  const records = [];
  const seen = new Set<string>();
  for (const slots of textureSets) {
    const parameters = [
      ...new Set(
        slots.map((slot) => {
          const parameter = TEXTURE_SLOTS[slot];
          if (parameter === undefined || slot === ('matcap' as PhysicalTextureSlot))
            throw new Error(`Unknown Physical texture slot: ${slot}`);
          return parameter;
        }),
      ),
    ].sort();
    if (parameters.includes('normalTexture') && parameters.includes('bumpTexture'))
      parameters.splice(parameters.indexOf('bumpTexture'), 1);
    const key = parameters.join('-');
    if (seen.has(key)) continue;
    seen.add(key);
    const source = projectMaterial(
      new MeshPhysicalMaterial(),
      Object.fromEntries(
        parameters.map((parameter) => [parameter, { texture: 'forgeax-three-build-placeholder' }]),
      ),
    ).unwrap();
    const cooked = await cooker.cook({
      guid: `forgeax-three-physical${key ? `-${key}` : ''}`,
      source: withClipping(source, { planes: [] }),
    });
    if (
      cooked.payload === null ||
      typeof cooked.payload !== 'object' ||
      !('cooked' in cooked.payload)
    )
      throw new Error('Native Cook did not publish a material record');
    records.push(validateCookedMaterialRecord(cooked.payload.cooked).unwrap());
  }
  const encoded = new TextEncoder().encode(
    `[${records.map(serializeCookedMaterialRecord).join(',')}]`,
  );
  const compressed = await compressZstd(encoded);
  if (!compressed.ok) throw compressed.error;
  return Buffer.from(compressed.value).toString('base64');
}
