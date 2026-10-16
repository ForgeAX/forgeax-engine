// @forgeax/engine-shader - registerDefaultStandardPbrSkin helper.
//
// feat-20260523-skin-skeleton-animation M3 / T-30; updated by
// feat-20260613-material-paramschema-driven-binding M3 / w13: the
// bindingLayout sidecar field has been removed from MaterialShaderEntry;
// the BGL is derived from paramSchema via `derive(paramSchema).bglEntries`
// inside the runtime pipeline-builder. paramSchema remains shared with
// default-standard-pbr (identical PBR material interface).
//
// Anchors:
//   - plan-strategy D-3: register independent WGSL template for skin variant
//   - plan-strategy D-1 / D-2: paramSchema is the single source of truth
//   - R-10: paramSchema reuses default-standard-pbr schema (same params)

import type { ShaderRegistry } from './index.js';
import { STANDARD_PIPELINE_PARAM_SCHEMA } from './material-schemas.js';

/**
 * paramSchema for forgeax::pbr-skin — mirrors default-standard-pbr 8 fields.
 * Previously sourced from default-standard-pbr.schema.json; now inlined because
 * the .schema.json file has been deleted (feat-20260528-material-shader-registration-unification M1/w4).
 * The SSOT is default-standard-pbr.material.json paramSchema[].
 */
const RESERVED_ID = 'forgeax::pbr-skin' as const;

/**
 * Caps shape historically consumed by the pbr-skin BGL builder. The
 * BGL builder itself moved to runtime/pbr-pipeline.ts (buildPbrSkinLayouts);
 * this type is preserved as the public registration-API contract so
 * existing callers compile unchanged. M3 / w13: per-shader BGL is
 * derived from paramSchema; the storage-buffer-vs-uniform branching
 * the BGL needs lives entirely in the runtime layout factory.
 */
export interface SkinCaps {
  readonly storageBuffer: boolean;
}

/**
 * Register the engine-shipped `forgeax::pbr-skin` material shader in the
 * ShaderRegistry. Must be called once at engine boot (createRenderer), after
 * `ShaderRegistry.loadManifest()` has completed.
 *
 * The `composedWgsl` parameter is the post-naga_oil composed WGSL source,
 * compiled by @forgeax/engine-vite-plugin-shader at build time and surfaced
 * in manifest.json. The caller reads it from the manifest entries.
 *
 * `caps.storageBuffer` switches the runtime BGL buffer types:
 * `false` -> uniform fallback; `true` -> read-only-storage. The BGL itself
 * is built downstream in runtime/pbr-pipeline.ts (M3 / w13).
 *
 * @param registry ShaderRegistry instance (engine boot path).
 * @param composedWgsl Post-naga_oil composed WGSL source string.
 * @param caps PBR caps (storageBuffer boolean) for BGL entry type selection.
 *
 * Throws if the identifier is already registered (fail-fast per
 * ShaderRegistry.installMaterialArtifact contract).
 */
export function registerDefaultStandardPbrSkin(
  registry: ShaderRegistry,
  composedWgsl: string,
  caps: SkinCaps,
): void {
  // M3 / w13 (D-1 / D-2): bindingLayout sidecar deleted from
  // MaterialShaderEntry; paramSchema is the SSOT and downstream
  // pipeline-builder reads `derive(paramSchema).bglEntries` on demand.
  // The `caps` argument is retained for API compat — historically it
  // selected the storage-buffer vs uniform-buffer skin variant of the
  // BGL; equivalent caps gating now lives in buildPbrSkinLayouts.
  void caps;
  registry.installMaterialArtifact(RESERVED_ID, {
    source: composedWgsl,
    paramSchema: STANDARD_PIPELINE_PARAM_SCHEMA,
  });
}
