import { type AssetRegistry, createMaterialLoader } from '@forgeax/engine-assets-runtime';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import type { MaterialAsset } from '@forgeax/engine-types';

export const CHANNEL_PHYSICAL_GUID = 'lighting-channels-physical';

/** Admit the real producer's bytes before a statically selected material draws. */
export async function prepareChannelPhysicalMaterial(
  assets: AssetRegistry,
  source: MaterialAsset,
  serialized: string,
): Promise<void> {
  const record = validateCookedMaterialRecord(JSON.parse(serialized)).unwrap();
  if (!record.resolved.parameters.some((parameter) => parameter.name === 'clearcoat'))
    throw new Error('physical lighting fixture must publish enabled clearcoat');
  const ready = await createMaterialLoader({
    loadPublication: async () => ({
      guid: CHANNEL_PHYSICAL_GUID,
      record,
      artifacts: Object.fromEntries(
        record.programs.map(({ artifact }) => [
          artifact.path,
          { mediaType: artifact.mediaType, bytes: artifact.bytes },
        ]),
      ),
    }),
    loadReference: async () => true,
  }).load({ guid: CHANNEL_PHYSICAL_GUID, specializationKey: record.specializationKey ?? '' });
  if (ready.status !== 'Ready') throw new Error(JSON.stringify(ready));
  assets.catalog(CHANNEL_PHYSICAL_GUID, source).unwrap();
  assets.recordMaterialReadiness(CHANNEL_PHYSICAL_GUID, ready);
}
