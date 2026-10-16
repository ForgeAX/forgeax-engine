/**
 * @forgeax/engine-fbx — barrel entry point.
 *
 * FBX importer via ufbx compiled to WebAssembly. This barrel re-exports the
 * WASM runtime (./wasm), the parse-*.ts bridge layer and `fbxImporter`
 * (single-entry indexability, charter F1).
 *
 * Usage:
 *   import { fbxImporter } from '@forgeax/engine-fbx';   // build-time importer
 *   // or the low-level parse API:
 *   import { initFbxWasm, parseFbx } from '@forgeax/engine-fbx';
 *   await initFbxWasm();                 // load .wasm once
 *   const json = parseFbx(fbxBytes);     // Uint8Array -> JSON string
 *   const pod = JSON.parse(json);        // engine FBX POD schema
 */

/* ── Bridge-layer barrel (parse-*.ts + importer + errors) ──────────── */

export {
  FBX_ERROR_HINTS,
  type FbxError,
  type FbxErrorCode,
  type FbxErrorDetail,
  fbxErr,
} from './errors.js';
export {
  applyFbxImportSettingsBounds,
  deriveFbxSourceKeys,
  fbxImporter,
  sourceKeyForFbxOutput,
} from './fbx-importer.js';
export {
  type FbxLodGroupInput,
  type FbxLodGroupPod,
  parseFbxLodGroup,
} from './lod/parse-lod-group.js';
export { type FbxLodMetaLevel, projectFbxLodMeta } from './lod/project-meta.js';
export {
  type FbxRawAnimDoc,
  type FbxRawClip,
  parseAnimationClips,
} from './parse-animation-clip.js';
export { type FbxRawMaterial, parseMaterial } from './parse-material.js';
export { type FbxRawDocument, type FbxRawMesh, parseMesh } from './parse-mesh.js';
export {
  type FbxRawLodGroup,
  type FbxRawNode,
  type FbxRawNodes,
  parseScene,
} from './parse-scene.js';
export { type FbxRawSkeletonDoc, parseSkeleton } from './parse-skeleton.js';
export { type FbxRawSkinDoc, parseSkin } from './parse-skin.js';
export { type FbxRawTexture, type FbxRawTextures, parseTextures } from './parse-texture.js';
export {
  type FbxTextureCandidate,
  type FbxTexturePathRequest,
  type FbxTextureResolution,
  type FbxTextureResolutionStrategy,
  resolveFbxTexturePath,
} from './resolve-texture-path.js';
export { toAssetPack } from './to-asset-pack.js';
export { initFbxWasm, isFbxWasmReady, parseFbx, parseFbxToObject } from './wasm.js';
