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

/** A verified transport can retain compressed storage without pinning decoded output. */
export interface RetainedZstdBytes {
  readonly byteLength: number;
  readonly storedByteLength: number;
  /** Shared identity for counting a compressed group once, without exposing its bytes. */
  readonly storageIdentity: object;
  read(): Uint8Array;
}

interface DecodedWindow extends RetainedZstdBytes {
  slice(bytes: Uint8Array, offset: number): DecodedWindow;
}

// Entry-point bundles may contain separate module instances in one realm.
const retainedKey = Symbol.for('forgeax.codec.retained-zstd-windows');
const retainedRealm = globalThis as typeof globalThis & { [key: symbol]: unknown };
if (retainedRealm[retainedKey] === undefined)
  retainedRealm[retainedKey] = new WeakMap<Uint8Array, DecodedWindow>();
const retained = retainedRealm[retainedKey] as WeakMap<Uint8Array, DecodedWindow>;

/** Private transport provenance, not proof of an artifact's digest or ABI. */
export function retainedZstdBytes(bytes: Uint8Array): RetainedZstdBytes | undefined {
  return retained.get(bytes);
}

/**
 * Carry provenance to an exact independent copy or member window. Comparing
 * content keeps an arbitrary caller from associating other bytes with a frame.
 * Each independent copy has its own weak view; it never borrows caller storage.
 */
export function copyRetainedZstdBytes(source: Uint8Array, copy: Uint8Array, offset = 0): void {
  const window = retained.get(source);
  if (window === undefined) return;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + copy.length > source.length) return;
  if (source.buffer !== copy.buffer || copy.byteOffset !== source.byteOffset + offset)
    for (let i = 0; i < copy.length; i++) if (source[offset + i] !== copy[i]) return;
  retained.set(copy, window.slice(copy, offset));
}

/**
 * Decode and retain the already-compressed delivery frame. Initial decode and
 * all consumer integrity checks are unchanged. A cold synchronous read restores
 * these same bytes with the initialized decoder, never compression or network IO.
 */
export async function decompressRetainedZstd(bytes: Uint8Array): Promise<CodecResult<Uint8Array>> {
  if (typeof WeakRef !== 'function') return decompressZstd(bytes);
  // Capture before awaiting: transport publishers still own their input.
  const encoded = new Uint8Array(bytes);
  let decompress: ZstdDecompress;
  try {
    decompress = await getDecompressor();
  } catch {
    return codecError('codec-init-failed', { stage: 'dynamic-import-fzstd' });
  }
  return decodeRetained(encoded, decompress);
}

/** Initialize once before a synchronous consumer selects an embedded compressed record. */
export async function prepareRetainedZstdDecoder(): Promise<
  (bytes: Uint8Array) => CodecResult<Uint8Array>
> {
  const decompress = await getDecompressor();
  return (bytes) => decodeRetained(new Uint8Array(bytes), decompress);
}

function decodeRetained(encoded: Uint8Array, decompress: ZstdDecompress): CodecResult<Uint8Array> {
  let decoded: Uint8Array;
  try {
    decoded = decompress(encoded);
  } catch {
    return codecError('decompression-failed', {
      reason: 'zstd decompression failed: corrupt or invalid compressed data',
    });
  }
  if (typeof WeakRef !== 'function' || encoded.byteLength >= decoded.byteLength)
    return { ok: true, value: decoded };
  // Keep the initialized synchronous decoder and compressed frame, not decoded.
  const length = decoded.byteLength;
  const identity = Object.freeze({});
  let group = new WeakRef(decoded);
  function readGroup(): Uint8Array {
    let value = group.deref();
    if (value === undefined) {
      value = decompress(encoded);
      if (value.byteLength !== length) throw new Error('retained zstd decoded length changed');
      group = new WeakRef(value);
    }
    return value;
  }
  function window(view: Uint8Array, offset: number): DecodedWindow {
    let live = new WeakRef(view);
    const byteLength = view.byteLength;
    return Object.freeze({
      byteLength,
      storedByteLength: encoded.byteLength,
      storageIdentity: identity,
      read() {
        let value = live.deref();
        if (value === undefined) {
          value = readGroup().slice(offset, offset + byteLength);
          live = new WeakRef(value);
          retained.set(value, this);
        }
        return value;
      },
      slice(copy: Uint8Array, relativeOffset: number) {
        return window(copy, offset + relativeOffset);
      },
    });
  }
  retained.set(decoded, window(decoded, 0));
  return { ok: true, value: decoded };
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
