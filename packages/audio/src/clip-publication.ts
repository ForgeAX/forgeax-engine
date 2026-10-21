import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import {
  type AssetHandle,
  type AssetReferenceOwner,
  type AudioClipAsset,
  AudioError,
} from '@forgeax/engine-types';

/** Wire identity comes only from the asset owner; sourceKey remains provenance. */
export interface AudioClipIdentity {
  readonly owner: string;
  readonly handle: number;
  readonly revision: number;
}

export function audioClipKey(clip: AudioClipIdentity): string {
  return `${clip.owner}:${clip.handle}`;
}

/** Synchronous borrow: consumers copy newly published bytes before returning. */
export function borrowAudioClip(
  assets: AssetReferenceOwner,
  handle: AssetHandle<'audio'>,
): {
  readonly identity: AudioClipIdentity;
  readonly clip: AudioClipAsset;
} {
  const valid = assets.validate(handle, 'audio');
  if (!valid.ok)
    throw new AudioError({
      code: 'invalid-clip-handle',
      expected: 'a live audio handle in the supplied asset owner',
      hint: 'load or create an audio asset before playback',
      detail: { code: 'invalid-clip-handle', clipHandleId: Number(handle) },
    });
  const records = runtimeAssets(assets);
  return {
    identity: { owner: assets.identity, handle, revision: records.version(handle).unwrap() },
    clip: records.borrow<AudioClipAsset>(handle).unwrap(),
  };
}
