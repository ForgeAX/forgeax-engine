// parse-glb-chunks.ts - GLB 2.0 binary container parser (w8).
//
// Pure function: ArrayBuffer in, Result<{version, length, jsonChunk, binChunk?}, GltfError> out.
// No fs, no fetch, no global state. Caller owns I/O.
//
// GLB 2.0 layout (Khronos KHR glTF-2.0 GLB section):
//
//   header (12 bytes, little-endian uint32 each):
//     magic   = 0x46546C67  ('glTF')
//     version = 2
//     length  = total byte length of the GLB container (header + chunks)
//
//   chunk (variable):
//     chunkLength (uint32 LE)
//     chunkType   (uint32 LE)
//        0x4E4F534A = 'JSON' - exactly one, must be the first chunk
//        0x004E4942 = 'BIN'  - at most one, must be the second chunk
//     chunkData (chunkLength bytes; padded so chunkLength is a multiple of 4)
//
// `parseGltfHeader` (asset.version check) lives in parse-gltf-header.ts and
// is re-exported here so call sites can grab both binary and JSON gates from
// a single entry without walking module paths.

import { err, type GltfError, gltfErr, ok, type Result } from './errors.js';
import { parseGltfHeader } from './parse-gltf-header.js';

export type { GltfHeaderJson } from './parse-gltf-header.js';
export { parseGltfHeader };

const GLB_HEADER_SIZE = 12;
const GLB_MAGIC = 0x46546c67;
const CHUNK_HEADER_SIZE = 8;
const CHUNK_TYPE_JSON = 0x4e4f534a;
const CHUNK_TYPE_BIN = 0x004e4942;

/** Result payload of {@link parseGlbChunks}. */
export interface GlbChunks {
  readonly version: number;
  readonly length: number;
  readonly jsonChunk: Uint8Array;
  readonly binChunk?: Uint8Array;
}

/**
 * Split a GLB 2.0 binary container into its `JSON` chunk and optional
 * `BIN` chunk. Returns the declared `version` and `length` for the caller
 * to surface in diagnostics.
 *
 * Failure path returns one of:
 *   - `gltf-malformed-header` (magic / chunk shape / declared length / missing JSON)
 *   - `gltf-version-unsupported` (version != 2)
 *
 * The function is pure: no fs / network access; the caller passes the
 * already-loaded ArrayBuffer.
 */
export function parseGlbChunks(
  buffer: ArrayBuffer,
  filePath: string,
): Result<GlbChunks, GltfError> {
  if (buffer.byteLength < GLB_HEADER_SIZE) {
    return err(
      gltfErr('gltf-malformed-header', {
        filePath,
        byteOffset: 0,
      }),
    );
  }
  const view = new DataView(buffer);
  const magic = view.getUint32(0, true);
  if (magic !== GLB_MAGIC) {
    return err(
      gltfErr('gltf-malformed-header', {
        filePath,
        byteOffset: 0,
        magic,
      }),
    );
  }
  const version = view.getUint32(4, true);
  if (version !== 2) {
    return err(
      gltfErr('gltf-version-unsupported', {
        filePath,
        actualVersion: String(version),
      }),
    );
  }
  const declaredLength = view.getUint32(8, true);
  if (declaredLength !== buffer.byteLength) {
    return err(
      gltfErr('gltf-malformed-header', {
        filePath,
        byteOffset: 8,
      }),
    );
  }

  // First chunk MUST be JSON.
  let offset = GLB_HEADER_SIZE;
  if (offset + CHUNK_HEADER_SIZE > buffer.byteLength) {
    return err(
      gltfErr('gltf-malformed-header', {
        filePath,
        byteOffset: offset,
      }),
    );
  }
  const jsonChunkLength = view.getUint32(offset, true);
  const jsonChunkType = view.getUint32(offset + 4, true);
  if (jsonChunkType !== CHUNK_TYPE_JSON) {
    return err(
      gltfErr('gltf-malformed-header', {
        filePath,
        byteOffset: offset + 4,
      }),
    );
  }
  if (offset + CHUNK_HEADER_SIZE + jsonChunkLength > buffer.byteLength) {
    return err(
      gltfErr('gltf-malformed-header', {
        filePath,
        byteOffset: offset,
      }),
    );
  }
  const jsonChunk = new Uint8Array(buffer, offset + CHUNK_HEADER_SIZE, jsonChunkLength);
  offset += CHUNK_HEADER_SIZE + jsonChunkLength;

  // Optional BIN chunk follows JSON.
  let binChunk: Uint8Array | undefined;
  if (offset < buffer.byteLength) {
    if (offset + CHUNK_HEADER_SIZE > buffer.byteLength) {
      return err(
        gltfErr('gltf-malformed-header', {
          filePath,
          byteOffset: offset,
        }),
      );
    }
    const binChunkLength = view.getUint32(offset, true);
    const binChunkType = view.getUint32(offset + 4, true);
    if (binChunkType !== CHUNK_TYPE_BIN) {
      return err(
        gltfErr('gltf-malformed-header', {
          filePath,
          byteOffset: offset + 4,
        }),
      );
    }
    if (offset + CHUNK_HEADER_SIZE + binChunkLength > buffer.byteLength) {
      return err(
        gltfErr('gltf-malformed-header', {
          filePath,
          byteOffset: offset,
        }),
      );
    }
    binChunk = new Uint8Array(buffer, offset + CHUNK_HEADER_SIZE, binChunkLength);
  }

  return ok({
    version,
    length: declaredLength,
    jsonChunk,
    ...(binChunk === undefined ? {} : { binChunk }),
  });
}
