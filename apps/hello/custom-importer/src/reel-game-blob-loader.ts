// apps/hello/custom-importer -- the host's runtime Loader.
//
// feat-20260629-importer-self-declared-fold-contract acceptance app (M5 / w15).
//
// The runtime mirror of reel-game-blob-importer.ts. The host registers this
// loader on `engine.assets.loaders.register(...)`; `loadByGuid<ReelGameBlob>`
// then dispatches on `entry.kind === 'reel-game-blob'` to `load`, which returns
// the host's typed payload. The engine's closed `Asset` union is never touched
// (host-custom-kind-contract.test.ts proves the generic registry path); the
// engine carries zero knowledge of the reel-game semantics (OOS-1).

import type { LoadContext, Loader, LoaderOutput } from '@forgeax/engine-types';
import { REEL_GAME_BLOB_KIND, type ReelGameBlob } from './reel-game-blob';

/**
 * Host loader for the `reel-game-blob` kind. The build-time importer already
 * folded the parsed blob into the DDC `.pack.json` payload, so the runtime
 * loader only re-shapes the raw `Record<string, unknown>` JSON into the typed
 * `ReelGameBlob`. No GPU device, no `fetchBinary`, no `resolveRef` -- a pure
 * POD loader (LoadContext capabilities go unused, which is legitimate for a
 * data-only host kind).
 */
export function reelGameBlobLoader(): Loader<ReelGameBlob> {
  return {
    kind: REEL_GAME_BLOB_KIND,
    load(
      payload: Record<string, unknown>,
      _refs: readonly string[] | undefined,
      _ctx: LoadContext,
    ): LoaderOutput<ReelGameBlob> {
      // The payload is the verbatim DDC row produced by reelGameBlobImporter.
      // A host loader owns its own validation; here the import-time shape is
      // trusted (the importer is the host's own code) and re-typed.
      return payload as unknown as ReelGameBlob;
    },
  };
}
