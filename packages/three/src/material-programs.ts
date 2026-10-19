import { type AssetRegistry, createMaterialLoader } from '@forgeax/engine-assets-runtime';
import { decompressZstd } from '@forgeax/engine-codec';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import type { MaterialAsset } from '@forgeax/engine-types';
import { unsupported } from './errors';

async function registerPrograms(assets: AssetRegistry): Promise<readonly string[]> {
  const { materialPrograms } = await import('./generated/materials.mjs');
  const compressed = Uint8Array.from(atob(materialPrograms), (character) =>
    character.charCodeAt(0),
  );
  const decoded = await decompressZstd(compressed);
  if (!decoded.ok) throw decoded.error;
  const publications: unknown = JSON.parse(new TextDecoder().decode(decoded.value));
  if (!Array.isArray(publications)) throw new Error('invalid material publication');
  return Promise.all(
    publications.map(async (publication) => {
      const record = validateCookedMaterialRecord(publication).unwrap();
      const ready = await createMaterialLoader({
        loadPublication: async () => ({
          guid: record.guid,
          record,
          artifacts: Object.fromEntries(
            record.programs.map(({ artifact }) => [artifact.path, artifact]),
          ),
        }),
      }).load({ guid: record.guid, specializationKey: record.specializationKey ?? '' });
      if (ready.status !== 'Ready') throw ready.error;
      assets.recordMaterialReadiness(record.guid, ready);
      return record.guid;
    }),
  );
}

/** Programs enter the renderer's ordinary asset owner; only source values vary. */
export async function prepareMaterialPrograms(
  assets: AssetRegistry,
): Promise<(material: MaterialAsset) => MaterialAsset> {
  const guids = await registerPrograms(assets);
  return (material) => {
    if (material.parent !== undefined) return material;
    const family =
      material.staticSwitches !== undefined
        ? 'physical'
        : material.passes?.some((pass) => pass.program.module === 'forgeax_material::unlit')
          ? 'unlit'
          : 'standard';
    const requiredTextures = (material.parameters ?? [])
      .filter(
        (parameter) =>
          parameter.type.startsWith('texture') && material.values?.[parameter.name] != null,
      )
      .map((parameter) => parameter.name);
    const prefix = `forgeax-three-${family}`;
    for (const guid of guids) {
      if (guid !== prefix && !guid.startsWith(`${prefix}-`)) continue;
      const ready = assets.getMaterialReadiness(guid);
      if (ready === undefined) continue;
      if (ready.status !== 'Ready') throw ready.error;
      const parameters = ready.parameterContract.parameters;
      const names = new Set(parameters.map((parameter) => parameter.name));
      if (!requiredTextures.every((name) => names.has(name))) continue;
      return assets
        .catalog(guid, {
          ...material,
          parameters,
          values: Object.fromEntries(
            Object.entries(material.values ?? {}).filter(([name]) => names.has(name)),
          ),
        })
        .unwrap();
    }
    return unsupported(
      `Material program bindings ${family}: ${requiredTextures.join(', ')}`,
    ).unwrap();
  };
}
