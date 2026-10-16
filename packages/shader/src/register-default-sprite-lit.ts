// @forgeax/engine-shader - registerDefaultSpriteLit helper.
//
// feat-20260624-sprite-lit-shading-model-pure-2d-lighting M1' / w4
// (plan-strategy D-10 application registration path).
//
// Mirrors registerDefaultStandardPbrSkin (same package; identical
// registration shape). paramSchema mirrors sprite.material.json minus
// PBR-only fields; the BGL is derived from paramSchema via
// `derive(paramSchema).bglEntries` inside the runtime pipeline-builder.
//
// Anchors:
//   - requirements section 2 #2 / #10 (sprite-lit.wgsl new + 4 BGL byte-identical)
//   - plan-strategy D-3 (sprite-lit single Half-Lambert formula lock)
//   - plan-strategy D-5 (STORAGE_BUFFER_AVAILABLE variant axis day-1)
//   - plan-strategy D-6 (4 PBR-unused slots default sampler + white tex)
//   - plan-strategy D-10 (application registration path)

import type { ShaderRegistry } from './index.js';
import { DEFAULT_SPRITE_PARAM_SCHEMA } from './material-schemas.js';

/**
 * paramSchema for forgeax::sprite-lit -- mirrors sprite.material.json
 * exactly (same 5 fields: colorTint / region / pivotAndSize /
 * slicesAndMode / baseColorTexture). sprite-lit and sprite share the
 * same Material UBO layout byte-for-byte so the host-side
 * SpriteMaterialAsset writer + 4 BGL JSON are byte-identical (AC-07).
 *
 * OOS-1 (feat-future-sprite-lit-normal-map) will extend this with
 * normalTexture + normalStrength. M1' deliberately keeps the schema
 * byte-identical to sprite so AC-13 "1 string-change between sprite
 * and sprite-lit materials" is provably the only delta required.
 */
const RESERVED_ID = 'forgeax::sprite-lit' as const;

/**
 * Caps shape exposed for sprite-lit registration. Currently only
 * `storageBuffer` matters (STORAGE_BUFFER_AVAILABLE variant axis); the
 * per-shader BGL is derived from paramSchema at pipeline-build time, so
 * the runtime layout factory consumes this caps shape downstream.
 *
 * Kept as a separate type rather than reusing `SkinCaps` to preserve
 * a clear contract surface; the structural shape is currently identical
 * but future divergence (sprite-lit may opt in to OOS-7 cluster-forward
 * later) should not silently leak via a shared type.
 */
export interface SpriteLitCaps {
  readonly storageBuffer: boolean;
}

/**
 * Register the engine-shipped `forgeax::sprite-lit` material shader in
 * the ShaderRegistry. Must be called once at engine boot (createRenderer),
 * after `ShaderRegistry.loadManifest()` has completed.
 *
 * The `composedWgsl` parameter is the post-naga_oil composed WGSL source,
 * compiled by @forgeax/engine-vite-plugin-shader at build time and surfaced
 * in manifest.json. The caller reads it from the manifest entries.
 *
 * `caps.storageBuffer` is retained for the shared mesh/instance layout
 * selection. Sprite-lit local lighting reads the same Standard Cluster group
 * as PBR; the view group has no direct point/spot arrays.
 *
 * @param registry ShaderRegistry instance (engine boot path).
 * @param composedWgsl Post-naga_oil composed WGSL source string.
 * @param caps sprite-lit caps (storageBuffer boolean) for BGL entry type selection.
 *
 * Throws if the identifier is already registered (fail-fast per
 * ShaderRegistry.installMaterialArtifact contract).
 */
export function registerDefaultSpriteLit(
  registry: ShaderRegistry,
  composedWgsl: string,
  caps: SpriteLitCaps,
): void {
  // The caps argument is retained for API symmetry with
  // registerDefaultStandardPbrSkin -- equivalent caps gating lives in
  // buildPbrPipelineLayouts since the per-shader BGL is paramSchema-derived
  // and the storage-vs-uniform branching is a runtime-level concern.
  void caps;
  registry.installMaterialArtifact(RESERVED_ID, {
    source: composedWgsl,
    paramSchema: DEFAULT_SPRITE_PARAM_SCHEMA,
  });
}
