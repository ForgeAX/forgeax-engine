import type { ShaderEntryPointReads } from '@forgeax/engine-types';
import {
  templateManifestAxes,
  templateManifestVariant,
  templateManifestVariantByDefines,
} from './program-template-manifest.js';
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
import type {
  ManifestEntry,
  MaterialProgramAbi,
  ShaderCompilerProfile,
  ShaderReflection,
} from '@forgeax/engine-types';

/** Runtime rows materialized from the compact shader publication tables. */
export interface ExpandedShaderManifest {
  readonly entries: readonly ManifestEntry[];
  readonly materialShaders: readonly MaterialShaderManifestEntry[];
}

export interface MaterialShaderManifestVariant {
  readonly forwardFog?: 'height-vertex/1';
  readonly uvSetCount?: number;
  readonly entryPoints?: readonly ShaderEntryPointReads[];
  readonly hash?: string;
  readonly sourceDigest?: string;
  readonly compilerProfile?: ShaderCompilerProfile;
  readonly reflection?: ShaderReflection;
  readonly definesKey: string;
  readonly defines: Record<string, boolean>;
  readonly composedWgsl: string;
  /** ABI facts for this exact composed variant, when the producer publishes them. */
  readonly receipt?: MaterialProgramAbi;
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
export interface MaterialShaderManifestEntry
  extends Omit<Partial<MaterialProgramAbi>, 'reflection'> {
  readonly hash?: string;
  readonly sourceDigest?: string;
  readonly compilerProfile?: ShaderCompilerProfile;
  readonly reflection?: ShaderReflection;
  readonly identifier: string;
  readonly sourcePath: string;
  readonly composedWgsl: string;
  readonly paramSchema: string;
  readonly variants: readonly MaterialShaderManifestVariant[];
  /** Producer-owned ABI facts for the selected primary artifact. */
  readonly receipt?: MaterialProgramAbi;
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
  if (templateManifestAxes(entry) !== undefined) return templateManifestVariant(entry, definesKey);
  return entry.variants.find((v) => v.definesKey === definesKey);
}

/** First legal selection matching partial axes, with omitted axes counting as false. */
export function findVariantByDefines(
  entry: MaterialShaderManifestEntry,
  constraints: Readonly<Record<string, boolean>>,
): MaterialShaderManifestVariant | undefined {
  if (templateManifestAxes(entry) !== undefined)
    return templateManifestVariantByDefines(entry, constraints);
  const fields = Object.entries(constraints);
  return entry.variants.find(({ defines }) =>
    fields.every(([axis, value]) => (defines[axis] ?? false) === value),
  );
}

const admittedVariantAxes = new WeakMap<MaterialShaderManifestEntry, readonly string[]>();

function collectVariantAxes(entry: MaterialShaderManifestEntry): readonly string[] {
  const axes = new Set<string>();
  for (const variant of entry.variants) {
    for (const axis of Object.keys(variant.defines)) axes.add(axis);
  }
  return [...axes];
}

/** Seal the variant inputs of a validated, privately decoded material manifest row. */
export function sealMaterialShaderVariants(entry: MaterialShaderManifestEntry): void {
  for (const variant of entry.variants) {
    Object.freeze(variant.defines);
    Object.freeze(variant);
  }
  Object.freeze(entry.variants);
  Object.freeze(entry);
  admittedVariantAxes.set(entry, Object.freeze(collectVariantAxes(entry)));
}

/** Axes are source declarations; inspecting them never composes a program or expands permutations. */
export function materialShaderAxes(entry: MaterialShaderManifestEntry): readonly string[] {
  return templateManifestAxes(entry) ?? admittedVariantAxes.get(entry) ?? collectVariantAxes(entry);
}
