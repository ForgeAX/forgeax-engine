// @forgeax/engine-image -- main entry public surface.
//
// Browser-safe pure functions translate disk-side image bytes + sidecar
// settings into POD that the runtime AssetRegistry.uploadTexture path
// consumes (plan-strategy section 3.2 sequence A; charter P5 producer /
// consumer split). Node-only decoders (parseImage / decodeImageFromFile)
// are split into Node-only sub-exports per feat-20260524-browser-safe-subexports
// and are NOT re-exported from this main entry -- import them via:
//   - `@forgeax/engine-image/parse-image`            (Node-only sub-export)
//   - `@forgeax/engine-image/decode-image-from-file` (Node-only sub-export)
//
// Main entry surface (browser-safe):
//   - decodeImageInBrowser           -- browser-mode createImageBitmap path
//   - toAssetPack(meta)     -- POD -> external-asset-package envelope
//   - subAssetKey / subAssetKeyEqual -- gltf-aligned sub-asset matching
//   - reimportReuseMeta              -- two-phase GUID preservation
//   - imageError / ImageErrorImpl    -- structured 4-field error class
//   - decodeHdr                      -- HDR sub-export passthrough (legacy)
//   - loadJpeg / loadUpng            -- lazy Node decoder loaders (legacy; OOS-2)

export { IMAGE_ERROR_EXPECTED, ImageErrorImpl, imageError } from './errors.js';
export { decodeHdr } from './hdr-decoder.js';
export { decodeImageInBrowser } from './image-decoder-browser.js';
export type { JpegModule, UpngModule } from './image-decoder-node.js';
export { loadJpeg, loadUpng } from './image-decoder-node.js';
export {
  createPixelSurface,
  type PixelColor,
  type PixelSurface,
  type PixelSurfaceNoiseOptions,
  type PixelSurfaceOptions,
  type PixelSurfaceRect,
} from './pixel-surface.js';
export type {
  EmittedSubAsset,
  ExistingExternalAssetPackage,
  ExistingSubAsset,
} from './reimport-reuse-meta.js';
export { reimportReuseMeta } from './reimport-reuse-meta.js';
export type { Result, ResultErr, ResultOk } from './result.js';
export { err, ok } from './result.js';
export { equirectContribution, textureContribution } from './runtime/asset-decoders';
export type { ImageSourceKeyLocator } from './source-key.js';
export { deriveImageSourceKey } from './source-key.js';
export type { SubAssetKey, SubAssetKeyInput } from './sub-asset-key.js';
export { subAssetKey, subAssetKeyEqual } from './sub-asset-key.js';
export type {
  ExternalAssetPackage,
  ExternalSubAsset,
  ImageImportSettings,
} from './to-asset-pack.js';
export { toAssetPack } from './to-asset-pack.js';
