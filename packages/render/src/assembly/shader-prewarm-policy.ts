import type { Result, RhiError, ShaderModule } from '@forgeax/engine-rhi';
import { findVariantByKey, type MaterialShaderManifestEntry } from '@forgeax/engine-shader';

/** Minimum sampled-texture limit needed by Standard transmission variants. */
export const STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES = 21;

export function isOrdinaryMaterialVariant(
  variant: MaterialShaderManifestEntry['variants'][number],
): boolean {
  return (
    variant.defines.COVERAGE_ONLY !== true && variant.defines.VISIBLE_SURFACE_AVAILABLE !== true
  );
}

/**
 * Seed every reachable clustered draw, including scene-index addressing.
 * The dedicated GPU program covers only non-clustered draws; a backend may
 * omit immediate shader creation, so those draws cannot rely on lazy warmup.
 */
export function selectHdrpPbrPrewarmVariants(
  manifestEntry: MaterialShaderManifestEntry | undefined,
  storageBufferCapable: boolean,
  extendedLightingShaderAvailableOrTransmissionCapable = true,
  transmissionCapable = true,
  directionalPcssAvailable = true,
  projectorAvailable: boolean = true,
  atmosphereAvailable = false,
): readonly MaterialShaderManifestEntry['variants'][number][] {
  const variants = manifestEntry?.variants ?? [];
  const hasExtendedLightingAxis = variants.some(
    (variant) => 'EXTENDED_LIGHTING_AVAILABLE' in variant.defines,
  );
  const extendedLightingShaderAvailable = hasExtendedLightingAxis
    ? extendedLightingShaderAvailableOrTransmissionCapable
    : true;
  const effectiveTransmissionCapable = hasExtendedLightingAxis
    ? transmissionCapable
    : extendedLightingShaderAvailableOrTransmissionCapable;
  if (!storageBufferCapable) return [];
  return (
    variants.filter(
      (variant) =>
        isOrdinaryMaterialVariant(variant) &&
        (variant.defines.ATMOSPHERE_AVAILABLE ?? false) === atmosphereAvailable &&
        variant.defines.STORAGE_BUFFER_AVAILABLE === storageBufferCapable &&
        (!('EXTENDED_LIGHTING_AVAILABLE' in variant.defines) ||
          variant.defines.EXTENDED_LIGHTING_AVAILABLE === extendedLightingShaderAvailable) &&
        variant.defines.CLUSTER_FORWARD_AVAILABLE === true &&
        (!('DIRECTIONAL_PCSS_AVAILABLE' in variant.defines) ||
          variant.defines.DIRECTIONAL_PCSS_AVAILABLE === directionalPcssAvailable) &&
        (!('PROJECTOR_AVAILABLE' in variant.defines) ||
          variant.defines.PROJECTOR_AVAILABLE === projectorAvailable) &&
        variant.defines.PROBE_BLEND_AVAILABLE !== true &&
        (effectiveTransmissionCapable || variant.defines.TRANSMISSION_AVAILABLE !== true),
    ) ?? []
  );
}

/** Prewarm device-reachable skin variants, retaining scene-dependent draw axes. */
export function selectSkinPrewarmVariants(
  manifestEntry: MaterialShaderManifestEntry | undefined,
  storageBufferCapable: boolean,
  extendedLightingAvailable = true,
  directionalPcssAvailable = true,
  projectorAvailable = true,
  transmissionCapable = true,
  atmosphereAvailable = false,
): readonly MaterialShaderManifestEntry['variants'][number][] {
  return (
    manifestEntry?.variants.filter(
      ({ defines }) =>
        defines.COVERAGE_ONLY !== true &&
        defines.VISIBLE_SURFACE_AVAILABLE !== true &&
        (defines.ATMOSPHERE_AVAILABLE ?? false) === atmosphereAvailable &&
        defines.STORAGE_BUFFER_AVAILABLE === storageBufferCapable &&
        defines.PROBE_BLEND_AVAILABLE !== true &&
        (!('EXTENDED_LIGHTING_AVAILABLE' in defines) ||
          defines.EXTENDED_LIGHTING_AVAILABLE === extendedLightingAvailable) &&
        (!('DIRECTIONAL_PCSS_AVAILABLE' in defines) ||
          defines.DIRECTIONAL_PCSS_AVAILABLE === directionalPcssAvailable) &&
        (!('PROJECTOR_AVAILABLE' in defines) ||
          defines.PROJECTOR_AVAILABLE === projectorAvailable) &&
        (transmissionCapable || defines.TRANSMISSION_AVAILABLE !== true),
    ) ?? []
  );
}

/**
 * Select the explicit storage-backed, non-clustered GPU scene-index variant.
 * The GPU raster adapter owns a dedicated slot-3 BGL, so this source must not
 * be reused by direct, probe, clustered, or transmission material draws.
 */
export function selectGpuDrivenSceneIndexVariant(
  manifestEntry: MaterialShaderManifestEntry | undefined,
  extendedLightingAvailable: boolean,
  directionalPcssAvailable: boolean,
  projectorAvailable: boolean,
  vertexColorAvailable = false,
  atmosphereAvailable = false,
): MaterialShaderManifestEntry['variants'][number] | undefined {
  return manifestEntry?.variants.find(
    (variant) =>
      isOrdinaryMaterialVariant(variant) &&
      variant.defines.STORAGE_BUFFER_AVAILABLE === true &&
      variant.defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE === true &&
      (variant.defines.ATMOSPHERE_AVAILABLE ?? false) === atmosphereAvailable &&
      (!('CLUSTER_FORWARD_AVAILABLE' in variant.defines) ||
        variant.defines.CLUSTER_FORWARD_AVAILABLE === false) &&
      (variant.defines.VERTEX_COLOR_AVAILABLE === true) === vertexColorAvailable &&
      (!('PROBE_BLEND_AVAILABLE' in variant.defines) ||
        variant.defines.PROBE_BLEND_AVAILABLE === false) &&
      (!('EXTENDED_LIGHTING_AVAILABLE' in variant.defines) ||
        variant.defines.EXTENDED_LIGHTING_AVAILABLE === extendedLightingAvailable) &&
      (!('DIRECTIONAL_PCSS_AVAILABLE' in variant.defines) ||
        variant.defines.DIRECTIONAL_PCSS_AVAILABLE === directionalPcssAvailable) &&
      (!('PROJECTOR_AVAILABLE' in variant.defines) ||
        variant.defines.PROJECTOR_AVAILABLE === projectorAvailable) &&
      (!('REFLECTION_FALLBACK_AVAILABLE' in variant.defines) ||
        variant.defines.REFLECTION_FALLBACK_AVAILABLE === false) &&
      (!('TRANSMISSION_AVAILABLE' in variant.defines) ||
        variant.defines.TRANSMISSION_AVAILABLE === false),
  );
}

/** Select probe-enabled material modules for recovery candidate prewarming. */
export function selectProbePrewarmVariants(
  manifestEntry: MaterialShaderManifestEntry | undefined,
  storageBufferCapable: boolean,
  extendedLightingShaderAvailable = true,
  transmissionCapable = true,
  directionalPcssAvailable = true,
  projectorAvailable: boolean = true,
  webgl2Downlevel = false,
  atmosphereAvailable = false,
): readonly MaterialShaderManifestEntry['variants'][number][] {
  if (!storageBufferCapable) return [];
  return (
    manifestEntry?.variants.filter((variant) => {
      const defines = variant.defines;
      return (
        isOrdinaryMaterialVariant(variant) &&
        (defines.ATMOSPHERE_AVAILABLE ?? false) === atmosphereAvailable &&
        defines.PROBE_BLEND_AVAILABLE === true &&
        defines.STORAGE_BUFFER_AVAILABLE === storageBufferCapable &&
        (!('WEBGL2_COMPAT' in defines) || defines.WEBGL2_COMPAT === webgl2Downlevel) &&
        (!('EXTENDED_LIGHTING_AVAILABLE' in defines) ||
          defines.EXTENDED_LIGHTING_AVAILABLE === extendedLightingShaderAvailable) &&
        (!('DIRECTIONAL_PCSS_AVAILABLE' in defines) ||
          defines.DIRECTIONAL_PCSS_AVAILABLE === directionalPcssAvailable) &&
        (!('PROJECTOR_AVAILABLE' in defines) ||
          defines.PROJECTOR_AVAILABLE === projectorAvailable) &&
        (transmissionCapable || defines.TRANSMISSION_AVAILABLE !== true)
      );
    }) ?? []
  );
}

/**
 * Select the variant whose lazy module label a boot seed must cover. Every
 * named axis must match, and an axis a row omits counts as false, so a device
 * axis such as ATMOSPHERE_AVAILABLE can never fall back to the first row.
 */
export function selectBootVariant(
  manifestEntry: MaterialShaderManifestEntry | undefined,
  axes: Readonly<Record<string, boolean>>,
): MaterialShaderManifestEntry['variants'][number] | undefined {
  const required = Object.entries(axes);
  return manifestEntry?.variants.find(({ defines }) =>
    required.every(([axis, value]) => (defines[axis] ?? false) === value),
  );
}

/**
 * Which exact variant module labels a ready build compiles eagerly. Boot admits
 * every device-reachable variant so no first draw waits on a module; recovery
 * admits only the labels the replaced generation drew with, because the whole
 * rebuild must fit the bounded recovery deadline. Variants a scene reaches
 * later use the ordinary lazy module adapter.
 */
export type VariantPrewarmAdmission = (moduleLabel: string) => boolean;

/** Boot admission: every device-reachable variant is prewarmed. */
export const ADMIT_EVERY_VARIANT: VariantPrewarmAdmission = () => true;

/** Compile a bounded batch, settle every request, then seed exact draw labels. */
export async function prewarmMaterialShaderVariants(
  materialShaderId: string,
  variants: readonly MaterialShaderManifestEntry['variants'][number][],
  prewarmedModules: Map<string, ShaderModule>,
  compile: (
    variant: MaterialShaderManifestEntry['variants'][number],
    moduleLabel: string,
  ) => Promise<Result<ShaderModule, RhiError>>,
  seed: (moduleLabel: string, module: ShaderModule) => void,
  admits: VariantPrewarmAdmission,
): Promise<void> {
  const admitted = variants.filter(
    (variant) =>
      prewarmedModules.has(variant.composedWgsl) ||
      admits(`module-${materialShaderId}#${variant.definesKey}`),
  );
  for (let offset = 0; offset < admitted.length; offset += 8) {
    const batch = admitted.slice(offset, offset + 8);
    const pending = new Map<string, Promise<Result<ShaderModule, RhiError>>>();
    for (const variant of batch) {
      if (prewarmedModules.has(variant.composedWgsl) || pending.has(variant.composedWgsl)) continue;
      const label = `module-${materialShaderId}#${variant.definesKey}`;
      pending.set(
        variant.composedWgsl,
        Promise.resolve().then(() => compile(variant, label)),
      );
    }
    // A failure must not abandon sibling GPU preparation after the candidate
    // owner starts disposal. Keep the first failure in manifest source order.
    const results = await Promise.allSettled(
      [...pending].map(async ([source, request]) => {
        const result = await request;
        if (!result.ok) throw result.error;
        return { source, module: result.value };
      }),
    );
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
      prewarmedModules.set(result.value.source, result.value.module);
    }
    for (const variant of batch) {
      const module = prewarmedModules.get(variant.composedWgsl);
      if (module === undefined) throw new Error('missing prepared material shader module');
      seed(`module-${materialShaderId}#${variant.definesKey}`, module);
    }
  }
}

/** Select the declared Standard URP transmission variants for exact prewarm. */
export function selectStandardPbrTransmissionPrewarmVariants(
  manifestEntry: MaterialShaderManifestEntry | undefined,
  storageBufferCapable: boolean,
  directionalPcssAvailable = true,
  projectorAvailable: boolean = true,
  extendedLightingShaderAvailable = true,
  atmosphereAvailable = false,
): readonly MaterialShaderManifestEntry['variants'][number][] {
  // Like the sibling selections, an absent Standard row has nothing to prewarm;
  // a declared row must still carry both exact transmission variants.
  if (manifestEntry === undefined) return [];
  const selected: MaterialShaderManifestEntry['variants'][number][] = [];
  for (const transmissionAvailable of [false, true]) {
    const declared = manifestEntry.variants.find(
      (variant) =>
        isOrdinaryMaterialVariant(variant) &&
        (variant.defines.ATMOSPHERE_AVAILABLE ?? false) === atmosphereAvailable &&
        variant.defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE !== true &&
        variant.defines.STORAGE_BUFFER_AVAILABLE === storageBufferCapable &&
        variant.defines.CLUSTER_FORWARD_AVAILABLE === standardBootClusterAxis() &&
        variant.defines.VERTEX_COLOR_AVAILABLE === false &&
        (!('DIRECTIONAL_PCSS_AVAILABLE' in variant.defines) ||
          variant.defines.DIRECTIONAL_PCSS_AVAILABLE === directionalPcssAvailable) &&
        (!('PROJECTOR_AVAILABLE' in variant.defines) ||
          variant.defines.PROJECTOR_AVAILABLE === projectorAvailable) &&
        (!('EXTENDED_LIGHTING_AVAILABLE' in variant.defines) ||
          variant.defines.EXTENDED_LIGHTING_AVAILABLE === extendedLightingShaderAvailable) &&
        variant.defines.PROBE_BLEND_AVAILABLE !== true &&
        variant.defines.TRANSMISSION_AVAILABLE === transmissionAvailable,
    );
    if (declared === undefined) {
      throw new Error(
        `Standard material shader manifest lacks exact TRANSMISSION_AVAILABLE=${transmissionAvailable} prewarm variant`,
      );
    }
    const exact = findVariantByKey(manifestEntry, declared.definesKey);
    if (exact === undefined) {
      throw new Error(
        `Standard material shader manifest exact lookup failed for TRANSMISSION_AVAILABLE=${transmissionAvailable}`,
      );
    }
    selected.push(exact);
  }
  return selected;
}

function standardBootClusterAxis(): boolean {
  return false;
}
