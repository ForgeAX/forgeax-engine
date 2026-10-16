// apps/hello/custom-importer -- the host's own custom asset payload type.
//
// `ReelGameBlob` is NOT a member of the engine's closed `Asset` union. It is a
// host-defined payload that travels through the SAME GUID pipeline every engine
// asset uses (declare -> import -> pack-index -> loadByGuid) without the engine
// ever understanding its semantics (OOS-1: the engine does not render host
// kinds; the host loader drives any scene use). The blob describes a slot-
// machine reel layout: a title plus N reels, each with a world-X anchor and an
// ordered symbol list. The host loader (reel-game-blob-loader.ts) maps each
// reel to a visible entity.
export interface ReelGameBlob {
  readonly kind: 'reel-game-blob';
  readonly title: string;
  readonly version: number;
  readonly reels: ReadonlyArray<{
    readonly id: string;
    readonly x: number;
    readonly symbols: readonly string[];
  }>;
}

/** The pack-index / sub-asset kind string the host importer + loader agree on. */
export const REEL_GAME_BLOB_KIND = 'reel-game-blob';

/** The build-time importer key the `.meta.json` sidecar's `importer` field names. */
export const REEL_GAME_BLOB_IMPORTER_KEY = 'reel-game-blob';

/** GUID declared in level-1.reel.json.meta.json subAssets[0].guid (GUID import-stable iron law). */
export const REEL_GAME_LEVEL_1_GUID = '8215d398-8120-4ffa-baf2-4496216cd4f6';
