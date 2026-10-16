// @forgeax/engine-shader/types — shared variant types consumed by the runtime
// variant resolution layer (createRenderer.ts M3). The SSOT for the manifest
// schema stays in @forgeax/engine-vite-plugin-shader; this file re-declares the
// runtime-visible subset so the engine-shader package avoids a physical import
// of the build-time plugin (physical-isolation grep gate).

/**
 * Single variant within a material-shader manifest entry.
 * `definesKey` is the canonical defines string (sorted `key=value` pairs joined
 * with `+`). Empty key `""` denotes the default variant (all axes `true`).
 *
 * Authored by vite-plugin-shader Cartesian compile at buildStart; consumed by
 * createRenderer variant resolution at engine boot (plan-strategy D-6).
 *
 * feat-20260613 fix-issue-2 (D-1 / D-2 bindingLayout cut): the runtime
 * derives the BGL from `derive(paramSchema).bglEntries`; manifest entries
 * no longer carry a bindingLayout sidecar (§Change stance: no v1/v2
 * dual-path, no incremental drop window).
 */
import type { MaterialShaderArtifactReceipt } from './material/artifact-types.js';
export interface MaterialShaderManifestVariant {
  readonly definesKey: string;
  readonly defines: Record<string, boolean>;
  readonly composedWgsl: string;
  /** ABI facts for this exact composed variant, when the producer publishes them. */
  readonly receipt?: MaterialShaderArtifactReceipt;
}

/**
 * A material-shader entry in manifest.json carrying zero or more variants.
 *
 * When `variants` is empty the entry is single-variant (no `#pragma variant_axis`
 * in the source). Otherwise `composedWgsl` carries the default
 * (all-true) variant for backward compat; the `variants[]` array contains every
 * compiled combination.
 *
 * For Engine.create() internal use only; AI users never see this type.
 */
export interface MaterialShaderManifestEntry extends Partial<MaterialShaderArtifactReceipt> {
  readonly identifier: string;
  readonly sourcePath: string;
  readonly composedWgsl: string;
  readonly paramSchema: string;
  readonly variants: readonly MaterialShaderManifestVariant[];
  /** Producer-owned ABI facts for the selected primary artifact. */
  readonly receipt?: MaterialShaderArtifactReceipt;
  /**
   * feat-20260629 M4: uvSetCount from naga vertex @location reflection.
   * Populated by vite-plugin-shader at build time from compileShader output.
   * The runtime reads this for clamp-to-last alias in deriveVertexBufferLayout.
   */
  readonly uvSetCount?: number;
}

/**
 * Look up a variant by canonical defines key.
 * Returns `undefined` when no variant matches the requested key.
 */
export function findVariantByKey(
  entry: MaterialShaderManifestEntry,
  definesKey: string,
): MaterialShaderManifestVariant | undefined {
  return entry.variants.find((v) => v.definesKey === definesKey);
}
