import { animationClipContribution, animationGraphContribution } from '@forgeax/engine-animation';
import {
  type AssetRegistry,
  iesProfileContribution,
  terrainContribution,
} from '@forgeax/engine-assets-runtime';
import { audioContribution } from '@forgeax/engine-audio';
import { fontContribution } from '@forgeax/engine-font';
import { meshAssetContribution } from '@forgeax/engine-geometry';
import { tilesetContribution, videoContribution } from '@forgeax/engine-graphics-extras';
import { equirectContribution, textureContribution } from '@forgeax/engine-image';
import { navigationMeshContribution } from '@forgeax/engine-navigation';
import {
  irradianceVolumeContribution,
  materialContribution,
  renderPipelineContribution,
  samplerContribution,
} from '@forgeax/engine-render';
import { sceneAssetContribution } from '@forgeax/engine-scene';
import { skeletonContribution, skinContribution } from '@forgeax/engine-skinning';
import type { AssetDecoderContributionRef, AssetKind } from '@forgeax/engine-types';
import { particleEffectContribution } from '@forgeax/engine-vfx';

/**
 * The built-in decoder set assembled by the host/runtime boundary.
 *
 * Each entry remains owned by its domain package; this list is only the one
 * default decoder assembly for an engine realm. Explicit contributions extend
 * it with kinds owned by the application or its plugins.
 */
const typedDefaultAssetDecoderContributions = [
  meshAssetContribution,
  materialContribution,
  irradianceVolumeContribution,
  sceneAssetContribution,
  textureContribution,
  equirectContribution,
  samplerContribution,
  fontContribution,
  renderPipelineContribution,
  tilesetContribution,
  videoContribution,
  skeletonContribution,
  skinContribution,
  animationClipContribution,
  animationGraphContribution,
  audioContribution,
  particleEffectContribution,
  terrainContribution,
  navigationMeshContribution,
  iesProfileContribution,
] as const;

// The registry installation seam intentionally erases the payload type while
// it stores heterogeneous owner contributions. Each owner contribution above
// remains typed at its source and is checked again by its decoder.
export const defaultAssetDecoderContributions = Object.freeze(
  typedDefaultAssetDecoderContributions as unknown as readonly AssetDecoderContributionRef[],
);

/** Runtime owns the default domain roster; Registry owns its decoder lifetime. */
export function installDefaultAssetDecoders(assets: AssetRegistry): void {
  for (const contribution of defaultAssetDecoderContributions)
    assets.installDecoder(contribution.kind as AssetKind<unknown>, contribution.decoder);
}
