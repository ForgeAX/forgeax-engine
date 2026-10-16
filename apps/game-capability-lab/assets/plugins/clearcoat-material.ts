import type { World } from '@forgeax/engine-ecs';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { Handle, MaterialAsset } from '@forgeax/engine-runtime';

export const CLEARCOAT_STRENGTH = 0.85;
export const CLEARCOAT_ROUGHNESS = 0.12;

export type MaterialHandle = Handle<'MaterialAsset', 'shared'>;

/** Vary the coat weight while the published root retains its cooked program. */
export function withClearcoat(material: MaterialAsset, parent: AssetGuid): MaterialAsset | undefined {
  if (!material.passes?.some((pass) => pass.program.module === 'forgeax::default-standard-pbr')) return undefined;
  return {
    kind: 'material',
    parent,
    values: {
      clearcoat: CLEARCOAT_STRENGTH,
      clearcoatRoughness: CLEARCOAT_ROUGHNESS,
    },
  };
}

/** Make a private material handle without mutating the scene asset's shared payload. */
export function cloneWithClearcoat(world: World, source: MaterialHandle, assets: Pick<AssetRegistry, 'guidOf'>): MaterialHandle | undefined {
  const resolved = world.sharedRefs.resolve<'MaterialAsset', MaterialAsset>(source);
  if (!resolved.ok) return undefined;
  const parent = assets.guidOf(resolved.value);
  if (parent === undefined) return undefined;
  const parsed = AssetGuid.parse(parent);
  if (!parsed.ok) return undefined;
  const material = withClearcoat(resolved.value, parsed.value);
  return material === undefined ? undefined : world.allocSharedRef('MaterialAsset', material);
}
