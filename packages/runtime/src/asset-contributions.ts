import { animationClipContribution, animationGraphContribution } from '@forgeax/engine-animation';
import { audioContribution } from '@forgeax/engine-audio';
import { fontContribution } from '@forgeax/engine-font';
import { meshAssetContribution } from '@forgeax/engine-geometry';
import { tilesetContribution, videoContribution } from '@forgeax/engine-graphics-extras';
import { equirectContribution, textureContribution } from '@forgeax/engine-image';
import {
  materialContribution,
  renderPipelineContribution,
  samplerContribution,
} from '@forgeax/engine-render';
import { sceneAssetContribution } from '@forgeax/engine-scene';
import { skeletonContribution, skinContribution } from '@forgeax/engine-skinning';
import type { AssetDecoderContributionRef } from '@forgeax/engine-types';
import { particleEffectContribution } from '@forgeax/engine-vfx';

/**
 * The built-in decoder set assembled by the host/runtime boundary.
 *
 * Each entry remains owned by its domain package; this list is only the one
 * default lease assembly for an App realm. A caller-provided contribution for
 * a built-in kind replaces that default entry for the current realm.
 */
const typedDefaultAssetDecoderContributions = [
  meshAssetContribution,
  materialContribution,
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
] as const;

// The registry installation seam intentionally erases the payload type while
// it stores heterogeneous owner contributions. Each owner contribution above
// remains typed at its source and is checked again by its decoder.
export const defaultAssetDecoderContributions = Object.freeze(
  typedDefaultAssetDecoderContributions as unknown as readonly AssetDecoderContributionRef[],
);
