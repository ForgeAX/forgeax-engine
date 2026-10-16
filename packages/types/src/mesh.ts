// @forgeax/engine-types mesh-specific additions.
//
// MeshAsset remains the public geometry POD in index.ts for compatibility with
// the existing asset union. LOD facts live in this focused module so producers
// and consumers share one vocabulary without introducing a second asset kind.

import type { AssetGuid } from './index.js';

/** One lower-detail geometry selected from a root MeshAsset. */
export interface MeshLodLevel {
  /** Ordinary MeshAsset GUID for the lower-detail geometry. */
  readonly mesh: AssetGuid;
  /** Absolute projected height fraction at which this level becomes active. */
  readonly screenCoverage: number;
}
