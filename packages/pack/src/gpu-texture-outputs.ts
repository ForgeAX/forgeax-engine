import type { Asset, TextureGeneratorAsset } from '@forgeax/engine-types';
import { validateTextureGenerator } from '@forgeax/engine-types';
import { AssetGuid, isValidPackSourceKey, type PackageId } from './guid.js';

/** Expand declarations only. Renderer generates all pixels on the consuming device. */
export function gpuTextureOutputs(
  packageId: PackageId,
  name: string,
  recipe: Omit<TextureGeneratorAsset, 'kind'>,
): Readonly<Record<string, Asset>> {
  const key = `generator/${name}`;
  if (!isValidPackSourceKey(key))
    throw new TypeError('GPU texture output name must be a valid Pack source key');
  const generator: TextureGeneratorAsset = { kind: 'texture-generator', ...recipe };
  validateTextureGenerator(generator).unwrap();
  const guid = AssetGuid.format(AssetGuid.derive(packageId, key));
  return Object.fromEntries([
    [key, generator],
    ...Object.entries(recipe.outputs).map(([output, descriptor]) => [
      `gpu-texture/${name}/${output}`,
      {
        kind: 'gpu-texture',
        ...descriptor,
        source: { kind: 'generated', generator: guid, output },
      },
    ]),
  ]) as Readonly<Record<string, Asset>>;
}
