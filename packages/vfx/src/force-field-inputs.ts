import {
  type AssetVersion,
  type AssetVersionDelta,
  runtimeAssetReference,
  runtimeAssets,
} from '@forgeax/engine-assets-runtime/internal';
import {
  type AssetReferenceOwner,
  ok,
  type Result,
  type TextureAsset,
} from '@forgeax/engine-types';
import { type VfxForceField, type VfxForceFieldError, vfxForceFieldFailure } from './force-fields';

/** POD identities of the exact textures sampled by one queued simulation step. */
export interface VfxFieldTexture {
  readonly handle: number;
  readonly revision: number;
  readonly delta?: AssetVersionDelta;
}

export interface VfxFieldInputs {
  readonly input: Result<readonly VfxFieldTexture[], VfxForceFieldError>;
  readonly textures: readonly AssetVersion<TextureAsset>[];
}

export function releaseVfxFieldInputs(inputs: VfxFieldInputs): void {
  for (const texture of inputs.textures) texture.dispose();
}

/** At most eight declared inputs; no asset or consumer discovery walk. */
export function captureVfxFieldInputs(
  owner: AssetReferenceOwner | undefined,
  fields: readonly VfxForceField[],
  previous?: VfxFieldInputs,
): VfxFieldInputs {
  const textures: AssetVersion<TextureAsset>[] = [];
  for (const field of fields) {
    if (field.kind !== 'vector') continue;
    const handle =
      typeof field.texture === 'number'
        ? field.texture
        : owner === undefined
          ? undefined
          : runtimeAssetReference(owner, field.texture);
    const pinned =
      owner === undefined || handle === undefined
        ? undefined
        : runtimeAssets(owner).pin<TextureAsset>(handle);
    if (pinned === undefined || !pinned.ok || pinned.value.value.kind !== 'texture') {
      if (pinned?.ok) pinned.value.dispose();
      for (const texture of textures) texture.dispose();
      if (previous !== undefined) releaseVfxFieldInputs(previous);
      return {
        textures: [],
        input: vfxForceFieldFailure(
          'vfx-field-asset-missing',
          'forceFields.texture',
          'an available Texture in this asset owner',
          String(field.texture),
        ),
      };
    }
    textures.push(pinned.value);
  }
  if (
    previous?.input.ok &&
    textures.length === previous.textures.length &&
    textures.every(
      (texture, index) =>
        texture.handle === previous.textures[index]?.handle &&
        texture.revision === previous.textures[index]?.revision,
    )
  ) {
    for (const texture of textures) texture.dispose();
    return previous;
  }
  if (previous !== undefined) releaseVfxFieldInputs(previous);
  return {
    textures,
    input: ok(
      Object.freeze(
        textures.map(({ handle, revision, delta }) =>
          Object.freeze({ handle, revision, ...(delta === undefined ? {} : { delta }) }),
        ),
      ),
    ),
  };
}
