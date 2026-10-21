import {
  type AssetRegistry,
  createMaterialLoader,
  installMaterialReadyShaders,
} from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { decompressZstd } from '@forgeax/engine-codec';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import type { AssetHandle, MaterialAsset } from '@forgeax/engine-types';
import { unsupported } from './errors';

async function registerPrograms(
  assets: AssetRegistry,
  publications: string,
): Promise<readonly AssetHandle<'material'>[]> {
  const compressed = Uint8Array.from(atob(publications), (character) => character.charCodeAt(0));
  const decoded = await decompressZstd(compressed);
  if (!decoded.ok) throw decoded.error;
  const records: unknown = JSON.parse(new TextDecoder().decode(decoded.value));
  if (!Array.isArray(records)) throw new Error('invalid material publication');
  return Promise.all(
    records.map(async (publication) => {
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
      const material: MaterialAsset = {
        kind: 'material',
        ...record.resolved,
        passes: record.resolved.passes as NonNullable<MaterialAsset['passes']>,
        parameters: ready.record.parameterContract.parameters,
        values: Object.fromEntries(
          Object.entries(record.resolved.values).filter(
            ([, value]) => value === null || typeof value !== 'object' || !('texture' in value),
          ),
        ),
      };
      assets.materialPayloadProjections.set(
        material,
        installMaterialReadyShaders(assets.shaderRegistry, ready, assets.materialArtifactRegistry),
      );
      return assets.create(material).unwrap();
    }),
  );
}

/** Cook admits the native skin ABI and optional Physical layer programs. */
export async function prepareMaterialPrograms(
  assets: AssetRegistry,
  additional: readonly string[] = [],
): Promise<(material: MaterialAsset, skinned?: boolean) => MaterialAsset> {
  const { materialPrograms } = await import('./generated/materials.mjs');
  const { physicalPrograms } = await import('./generated/physical.mjs');
  const handles = (
    await Promise.all(
      [materialPrograms, physicalPrograms, ...additional].map((publication) =>
        registerPrograms(assets, publication),
      ),
    )
  ).flat();
  const programs = handles.map((handle) => {
    const program = runtimeAssets(assets).borrow<MaterialAsset>(handle).unwrap();
    const projection = assets.getMaterialProjectionForPayload(program);
    if (projection === undefined) throw new Error('missing native material projection');
    assets.release(handle).unwrap();
    return { program, projection };
  });
  return (material, skinned = false) => {
    const family =
      material.staticSwitches?.clearcoat === true
        ? 'physical'
        : skinned
          ? 'skinned-unlit'
          : undefined;
    if (family === undefined) return material;
    const required = Object.keys(material.values ?? {}).filter((name) => {
      const value = material.values?.[name];
      return (
        value !== null && typeof value === 'object' && ('texture' in value || 'source' in value)
      );
    });
    const entry = programs.find(
      ({ projection, program }) =>
        projection.materialGuid.startsWith(`forgeax-three-${family}`) &&
        (family !== 'physical' ||
          program.parameters?.filter((parameter) => parameter.type.startsWith('texture')).length ===
            required.length) &&
        required.every((name) => program.parameters?.some((parameter) => parameter.name === name)),
    );
    if (entry === undefined)
      return unsupported(
        `Physical texture variant [${required.join(', ')}] needs build-time cookPhysicalMaterials() and forgeax.materialPrograms; a broader recipe would sample absent maps`,
      ).unwrap();
    const { program, projection } = entry;
    const names = new Set(program.parameters?.map((parameter) => parameter.name));
    const values = Object.fromEntries(
      Object.entries({ ...program.values, ...material.values }).filter(([name]) => names.has(name)),
    );
    const projected = { ...material, parameters: program.parameters, values } as MaterialAsset;
    const passProjection = {
      ...projection,
      passes: (projected.passes ?? []).map((pass) => {
        const source = projection.passes.find(
          (entry) =>
            entry.name ===
            (pass.name === 'forward-back' || pass.name === 'transmission-back'
              ? 'forward'
              : pass.name),
        );
        if (source === undefined) throw new Error(`Missing cooked material pass ${pass.name}`);
        return {
          ...source,
          name: pass.name,
          ...(pass.renderState === undefined ? {} : { renderState: pass.renderState }),
        };
      }),
    };
    assets.materialPayloadProjections.set(projected, passProjection);
    return projected;
  };
}
