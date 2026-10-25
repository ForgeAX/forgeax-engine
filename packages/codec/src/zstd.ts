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

// Native hosts may install text encoders after loading shared module chunks.
let utf8: TextDecoder | undefined;

/**
 * Text of a delivered document stored as UTF-8 or as one zstd frame.
 *
 * Player packages may store large JSON documents compressed so any static host
 * serves them small. JSON text never begins with the zstd magic byte 0x28.
 */
export async function decodeDocumentText(bytes: Uint8Array): Promise<CodecResult<string>> {
  let text = bytes;
  if (bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) {
    const decoded = await decompressZstd(bytes);
    if (!decoded.ok) return decoded;
    text = decoded.value;
  }
  try {
    utf8 ??= new TextDecoder('utf-8', { fatal: true });
    return { ok: true, value: utf8.decode(text) };
  } catch {
    return codecError('decompression-failed', { reason: 'document is not UTF-8 text' });
  }
}
