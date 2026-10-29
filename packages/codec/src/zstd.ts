import type { CodecResult } from './errors.js';
import { codecError } from './errors.js';

type ZstdDecompress = (dat: Uint8Array) => Uint8Array;

/** How the decompressor is loaded. Overridable in tests via {@link _setZstdImporter}. */
type ZstdImporter = () => Promise<ZstdDecompress>;

const defaultImporter: ZstdImporter = async () => {
  try {
    const { Zstd } = await import('@hpcc-js/wasm-zstd');
    const decoder = await Zstd.load();
    return (bytes) => {
      if (bytes.length === 0) return new Uint8Array(0);
      // Keep decoded output outside the growing WASM arena. Each session is synchronous.
      decoder.resetDecompression();
      const output = decoder.decompressChunk(bytes);
      decoder.decompressEnd();
      return output;
    };
  } catch {
    // Hosts that cannot initialize WASM retain the existing pure-JS decoder.
    return import('fzstd').then((mod) => mod.decompress);
  }
};

let importer: ZstdImporter = defaultImporter;

/**
 * Lazy-init singleton: initialized on first call to decompressZstd,
 * shared across concurrent callers (AC-12).
 *
 * null = never attempted, Promise in-flight = init pending,
 * resolved = decompressor ready, rejected = init failed (retry on next call).
 * @internal
 */
let _initPromise: Promise<ZstdDecompress> | null = null;

function getDecompressor(): Promise<ZstdDecompress> {
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
 * Call with no argument to restore the default importer.
 * @internal
 */
export function _setZstdImporter(next?: ZstdImporter): void {
  importer = next ?? defaultImporter;
  _initPromise = null;
}

/**
 * Decompress zstd bytes with lazy WASM initialization and a pure-JS init fallback.
 *
 * On success returns `{ ok: true, value: decompressed }`.
 * On failure returns a CodecError with `codec-init-failed` or
 * `decompression-failed` per the closed CodecErrorCode union (D-8).
 */
export async function decompressZstd(bytes: Uint8Array): Promise<CodecResult<Uint8Array>> {
  let decompress: ZstdDecompress;
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
