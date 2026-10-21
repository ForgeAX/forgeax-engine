import type { AssetHandle } from '@forgeax/engine-types';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';

export const CLEARCOAT_STRENGTH = 0.85;
export const CLEARCOAT_ROUGHNESS = 0.12;

export type MaterialHandle = AssetHandle<'material'>;

/** Preserve the accepted PBR program while making a private coat variation. */
export function cloneWithClearcoat(source: MaterialHandle, assets: AssetRegistry): MaterialHandle | undefined {
  const resolved = assets.read(source);
  if (!resolved.ok || !resolved.value.passes?.some((pass) => pass.program.module === 'forgeax::default-standard-pbr')) return undefined;
  const copied = assets.copy(source);
  if (!copied.ok) return undefined;
  const updated = assets.update(copied.value, { values: { clearcoat: CLEARCOAT_STRENGTH, clearcoatRoughness: CLEARCOAT_ROUGHNESS } });
  if (updated.ok) return copied.value;
  assets.release(copied.value).unwrap();
  return undefined;
}
