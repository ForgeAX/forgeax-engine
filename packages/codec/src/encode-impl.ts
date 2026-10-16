import { createRequire } from 'node:module';
import type { CodecResult } from './errors.js';
import { codecError } from './errors.js';

/**
 * CJS require for @bokuweb/zstd-wasm (build-time Node.js only).
 *
 * @bokuweb/zstd-wasm is distributed as a CommonJS package with a `.wasm`
 * sidecar. We use createRequire to load it from ESM, since it does not
 * provide ESM exports.
 */
const zstdRequire = createRequire(import.meta.url);

interface ZstdWasm {
  init(): Promise<void>;
  compress(buf: Uint8Array, level?: number): Uint8Array;
}

/** How the build-time zstd WASM encoder module is loaded. @internal */
type ZstdImporter = () => ZstdWasm;

const defaultImporter: ZstdImporter = () => zstdRequire('@bokuweb/zstd-wasm');

let importer: ZstdImporter = defaultImporter;

/**
 * Shared while the encoder WASM is initializing; cleared after a failed attempt.
 * The dependency mutates module-level emscripten exports and memory views on
 * every init, so a second init can bind calls to one instance and reads to another.
 * @internal
 */
let _initPromise: Promise<ZstdWasm> | null = null;

function getZstd(): Promise<ZstdWasm> {
  if (_initPromise !== null) {
    return _initPromise;
  }

  _initPromise = Promise.resolve()
    .then(() => {
      const mod = importer();
      return mod.init().then(() => mod);
    })
    .catch((cause: unknown) => {
      // Clear cached failure so a later import can retry (do not permanently cache).
      _initPromise = null;
      throw new Error('codec-init-failed', { cause });
    });
  return _initPromise;
}

/**
 * Test-only: reset the encoder singleton and optionally override its importer.
 * @internal
 */
export function _setZstdEncoderImporter(next?: ZstdImporter): void {
  importer = next ?? defaultImporter;
  _initPromise = null;
}

/**
 * Compress bytes with zstd using a fixed compression level (level 3 = default).
 *
 * Build-time only. Uses @bokuweb/zstd-wasm pinned at 0.0.27 for
 * deterministic output (same input + same level = byte-identical output).
 *
 * Returns `{ ok: true, value: compressed }` on success.
 * Returns `{ ok: false, error: { code: 'decompression-failed', ... } }` on failure
 * (encoding failures mapped to decompression-failed per D-8, same code different detail).
 */
export async function compressZstd(bytes: Uint8Array): Promise<CodecResult<Uint8Array>> {
  try {
    const zstd = await getZstd();
    const result = zstd.compress(bytes, 3);
    return { ok: true, value: result };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return codecError('decompression-failed', {
      reason: `zstd compression failed: ${reason}`,
    });
  }
}
