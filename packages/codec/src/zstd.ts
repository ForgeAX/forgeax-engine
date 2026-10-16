import type { CodecResult } from './errors.js';
import { codecError } from './errors.js';

/** The decompression function returned by fzstd's dynamic import. */
type FzstdDecompress = (dat: Uint8Array, buf?: Uint8Array) => Uint8Array;

/** How the decompressor is loaded. Overridable in tests via {@link _setZstdImporter}. */
type ZstdImporter = () => Promise<FzstdDecompress>;

const defaultImporter: ZstdImporter = () =>
  import('fzstd').then((mod) => mod.decompress as FzstdDecompress);

let importer: ZstdImporter = defaultImporter;

/**
 * Lazy-init singleton: initialized on first call to decompressZstd,
 * shared across concurrent callers (AC-12).
 *
 * null = never attempted, Promise in-flight = init pending,
 * resolved = decompressor ready, rejected = init failed (retry on next call).
 * @internal
 */
let _initPromise: Promise<FzstdDecompress> | null = null;

function getDecompressor(): Promise<FzstdDecompress> {
  if (_initPromise !== null) {
    return _initPromise;
  }
  _initPromise = importer().catch((cause: unknown) => {
    // Clear cached failure so subsequent calls retry (do not permanently cache).
    _initPromise = null;
    throw new Error('codec-init-failed', { cause });
  });
  return _initPromise;
}

/**
 * Test-only: reset the lazy singleton and optionally override the importer, so
 * lazy import / concurrency / failure-retry can be exercised deterministically.
 * Call with no argument to restore the real fzstd importer.
 * @internal
 */
export function _setZstdImporter(next?: ZstdImporter): void {
  importer = next ?? defaultImporter;
  _initPromise = null;
}

/**
 * Decompress zstd-compressed bytes using fzstd (pure JS, no WASM).
 *
 * On success returns `{ ok: true, value: decompressed }`.
 * On failure returns a CodecError with `codec-init-failed` or
 * `decompression-failed` per the closed CodecErrorCode union (D-8).
 */
export async function decompressZstd(bytes: Uint8Array): Promise<CodecResult<Uint8Array>> {
  let decompress: FzstdDecompress;
  try {
    decompress = await getDecompressor();
  } catch {
    return codecError('codec-init-failed', { stage: 'dynamic-import-fzstd' });
  }

  try {
    const result = decompress(bytes);
    return { ok: true, value: result };
  } catch {
    return codecError('decompression-failed', {
      reason: 'zstd decompression failed: corrupt or invalid compressed data',
    });
  }
}
