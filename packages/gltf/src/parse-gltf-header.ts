// parse-gltf-header.ts - asset.version check for the parsed glTF JSON
// document (w8). Pure function, no I/O.
//
// glTF 2.0 spec section 3.1: every glTF JSON document MUST carry an
// `asset.version` literal. v1 / v3 are not parsed by this importer
// (v3 does not exist; v1 is a different format). This step is the gate
// before any deeper structural traversal.
//
// Producers route through `gltfErr` (errors.ts SSOT) so `expected` and
// `hint` fields stay aligned with the GLTF_ERROR_HINTS table.

import type { GltfError } from './errors.js';
import { err, gltfErr, ok, type Result } from './errors.js';

/** Minimal JSON shape touched by the version gate. */
export interface GltfHeaderJson {
  readonly asset?: { readonly version?: string };
}

/**
 * Validate the top-level `asset.version` field of a parsed glTF document.
 *
 * On success the JSON object is echoed back unchanged (caller already owns
 * the parsed representation). On failure, the closed `GltfErrorCode`
 * surface narrows to either `gltf-malformed-header` (asset block missing)
 * or `gltf-version-unsupported` (version != "2.0").
 */
export function parseGltfHeader(
  json: unknown,
  filePath: string,
): Result<GltfHeaderJson, GltfError> {
  if (json === null || typeof json !== 'object' || !('asset' in json)) {
    return err(
      gltfErr('gltf-malformed-header', {
        filePath,
        byteOffset: 0,
      }),
    );
  }
  const asset = (json as GltfHeaderJson).asset;
  if (!asset || typeof asset !== 'object' || typeof asset.version !== 'string') {
    return err(
      gltfErr('gltf-malformed-header', {
        filePath,
        byteOffset: 0,
      }),
    );
  }
  if (asset.version !== '2.0') {
    return err(
      gltfErr('gltf-version-unsupported', {
        filePath,
        actualVersion: asset.version,
      }),
    );
  }
  return ok(json as GltfHeaderJson);
}
