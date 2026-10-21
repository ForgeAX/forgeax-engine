import type { AssetHandle } from '@forgeax/engine-types';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '@forgeax/engine-render/authoring';
import hitFlashShader from '../shaders/hit-flash.wgsl';

export const HIT_FLASH_SHADER_ID = 'game_default::hit_flash';
export const HIT_FLASH_SHADER_SOURCE = hitFlashShader.wgsl;
export const HIT_FLASH_ALPHA = 0.72;
export type HitFlashMaterialHandle = AssetHandle<'material'>;

/** Create the cooked custom hit material and return its world-owned handle. */
export function createHitFlashMaterial(assets: AssetRegistry): HitFlashMaterialHandle {
  return assets.create({
    kind: 'material',
    passes: [{ name: 'Forward', program: { module: HIT_FLASH_SHADER_ID }, renderState: { ...{ blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND, depthWriteEnabled: false }, tags: { LightMode: 'Forward' }, queue: 2000 } }],
    values: { baseColor: [1, 0.82, 0.15, HIT_FLASH_ALPHA], intensity: 3 },
  }).unwrap();
}
