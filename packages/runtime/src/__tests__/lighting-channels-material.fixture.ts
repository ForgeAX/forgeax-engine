import { type AssetRegistry, createMaterialLoader } from '@forgeax/engine-assets-runtime';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import type { AssetHandle } from '@forgeax/engine-types';
import { loadMaterialFixture } from '../../../assets-runtime/src/__tests__/fixtures/runtime-material';

export const CHANNEL_PHYSICAL_GUID = 'c524723b-2a33-4ed5-8cce-12b9dfe3fc80';

/** Admit the real producer's bytes before a statically selected material draws. */
export async function prepareChannelPhysicalMaterial(
  assets: AssetRegistry,
  serialized: string,
): Promise<AssetHandle<'material'>> {
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
  return (
    await loadMaterialFixture(assets, { ...ready.record, guid: CHANNEL_PHYSICAL_GUID })
  ).unwrap().handle;
}
