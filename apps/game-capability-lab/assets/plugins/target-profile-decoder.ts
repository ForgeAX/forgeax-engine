import { defineAssetKind } from '@forgeax/engine-assets-runtime';
import { err, ok, type AssetDecoder } from '@forgeax/engine-types';
import { GAME_DEFAULT_TARGET_PROFILE_KIND, isTargetProfile, type TargetProfile } from './target-profile-asset';

export const TARGET_PROFILE = defineAssetKind<TargetProfile, typeof GAME_DEFAULT_TARGET_PROFILE_KIND>(GAME_DEFAULT_TARGET_PROFILE_KIND);

export const targetProfileDecoder: AssetDecoder<TargetProfile> = {
  async decode({ envelope }) {
    return isTargetProfile(envelope.payload)
      ? ok(envelope.payload)
      : err({
          code: 'asset-decode-failed',
          expected: 'a validated target profile',
          hint: 'Repair the authored profile payload before publishing it.',
          detail: { guid: envelope.guid, kind: GAME_DEFAULT_TARGET_PROFILE_KIND },
        });
  },
};
