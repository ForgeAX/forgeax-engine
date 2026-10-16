// apps/hello/custom-importer -- the host's build-time Importer.
//
// feat-20260629-importer-self-declared-fold-contract acceptance app (M5 / w15).
//
// This is the whole point of the feat: a HOST game registers a custom importer
// that the engine folds into the pack-index WITHOUT the engine carrying any
// hard-coded knowledge of the host's kind. Two contract facts the app proves:
//
//   AC-07 -- the Importer interface is `{ key, import }` and carries NO `fold`
//            method. A passthrough importer's produced `ImportedAsset.kind`
//            (here 'reel-game-blob') becomes the pack-index row kind directly;
//            there is no separate fold-method concept on the importer.
//
//   AC-05 -- the importer key 'reel-game-blob' is not in any engine whitelist.
//            buildCatalog folds it via default passthrough purely because the
//            host registered it through `pluginPack({ importers })`
//            (P2 / feat-20260629 D-3/D-4). An unregistered key would be kept as
//            a raw-source row instead of being rejected.
//
// The importer is pure of disk write + GUID minting (pipeline isolation,
// architecture-principles #4): it reads the source bytes via `ctx.readSource()`,
// stamps the meta-declared GUID off `ctx.subAssets[0].guid` (GUID import-stable
// iron law -- the importer never mints), and returns the parsed blob as the
// payload. The import runner folds the produced `ImportedAsset` into the DDC
// `.pack.json` and rewrites the pack-index row's packageUrl to it.

import {
  IMPORT_ERROR_HINTS,
  ImportError,
  type ImportContext,
  type ImportedAsset,
  type Importer,
  type ImportResult,
} from '@forgeax/engine-types';
import { REEL_GAME_BLOB_KIND, type ReelGameBlob } from './reel-game-blob';

/**
 * Host importer for `.reel.json` source files. A passthrough importer: it parses
 * the host's own JSON blob and emits it verbatim as the asset payload. No image
 * decode, no `.bin` emission, no fold method (AC-07).
 */
export function reelGameBlobImporter(): Importer {
  return {
    key: REEL_GAME_BLOB_KIND,
    async import(ctx: ImportContext): Promise<ImportResult> {
      const sub = ctx.subAssets[0];
      if (sub === undefined) {
        // Return no assets so the runner attributes this precisely as
        // `import-produced-no-assets` rather than a bare throw (charter P3).
        return {
          ok: true,
          value: { assets: [], sourceDependencies: [] },
        };
      }

      const read = await ctx.readSource();
      if (!read.ok) {
        return {
          ok: false,
          error: new ImportError({
            code: 'source-read-failed',
            expected: `readable host source file "${ctx.source}"`,
            hint: IMPORT_ERROR_HINTS['source-read-failed'],
            detail: {
              source: ctx.source,
              reason: read.error instanceof Error ? read.error.message : String(read.error),
            },
          }),
        };
      }
      const thumbnailPath = `${ctx.source}.thumb`;
      const thumbnail = await ctx.readSibling(thumbnailPath);
      if (!thumbnail.ok) {
        return { ok: false, error: thumbnail.error };
      }

      const text = new TextDecoder().decode(read.value);
      const parsed = JSON.parse(text) as Omit<ReelGameBlob, 'kind'>;
      const payload: ReelGameBlob = {
        kind: REEL_GAME_BLOB_KIND,
        title: parsed.title,
        version: parsed.version,
        reels: parsed.reels,
      };

      // Stamp the meta-declared GUID; the produced kind equals the sub.kind so
      // the pack-index row + the runtime loader dispatch on the same string.
      return {
        ok: true,
        value: {
          assets: [
            {
              guid: sub.guid,
              kind: REEL_GAME_BLOB_KIND,
              name: 'reel-game-level-1',
              payload: payload as unknown as ImportedAsset['payload'],
              refs: [],
              artifacts: {
                payload: {
                  mediaType: 'application/json',
                  assetCodec: { name: 'reel-game-json', version: '1' },
                  bytes: read.value,
                },
                thumbnail: {
                  mediaType: 'image/svg+xml',
                  assetCodec: { name: 'raw', version: '1' },
                  bytes: thumbnail.value,
                },
              },
            },
          ],
          sourceDependencies: [ctx.source, thumbnailPath],
        },
      };
    },
  };
}
