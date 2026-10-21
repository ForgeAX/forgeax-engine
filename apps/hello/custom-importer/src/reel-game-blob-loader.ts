import { defineAssetKind } from '@forgeax/engine-assets-runtime';
import { type AssetDecoder, ok } from '@forgeax/engine-types';
import { REEL_GAME_BLOB_KIND, type ReelGameBlob } from './reel-game-blob.ts';

export const reelGameBlobKind = defineAssetKind<ReelGameBlob, typeof REEL_GAME_BLOB_KIND>(REEL_GAME_BLOB_KIND);

export const reelGameBlobDecoder: AssetDecoder<ReelGameBlob> = {
  async decode({ envelope }) {
    return ok(envelope.payload);
  },
};
