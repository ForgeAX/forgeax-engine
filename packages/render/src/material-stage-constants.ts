import {
  type MaterialShaderArtifact,
  STANDARD_SHADOW_RECEPTION_OVERRIDE,
  STANDARD_SURFACE_DISCARD_CLIPPING_AXIS,
  STANDARD_SURFACE_DISCARD_LOD_AXIS,
  STANDARD_SURFACE_DISCARD_LOD_COVERAGE,
  STANDARD_SURFACE_DISCARD_VIEW_CLIPPING,
  STANDARD_SURFACE_DISCARDS_OVERRIDE,
  STANDARD_TEXTURE_MASK_OVERRIDE,
} from '@forgeax/engine-shader';

/** Surface discard bits an admitted Standard draw can actually reach. */
export function standardSurfaceDiscardMask(lodCoverage: boolean, viewClipping: boolean): number {
  return (
    (lodCoverage ? STANDARD_SURFACE_DISCARD_LOD_COVERAGE : 0) |
    (viewClipping ? STANDARD_SURFACE_DISCARD_VIEW_CLIPPING : 0)
  );
}

/** Only programs that declare the SURFACE_DISCARD axis (discard-free default) take the request. */
export function effectiveStandardSurfaceDiscards(
  artifact: MaterialShaderArtifact | undefined,
  standardSurfaceDiscards: number | undefined,
): number | undefined {
  return standardSurfaceDiscards !== undefined &&
    (artifact?.variantSet?.includes(`${STANDARD_SURFACE_DISCARD_LOD_AXIS}=false`) === true ||
      artifact?.variantSet?.includes(`${STANDARD_SURFACE_DISCARD_CLIPPING_AXIS}=false`) === true)
    ? standardSurfaceDiscards
    : undefined;
}

/** Color target of a raster class; an empty attachment set is the colorless scene prepass. */
export function rasterColorFormat<F extends string>(formats: readonly F[], fallback: F): F | null {
  if (formats.length === 0) return null;
  return formats[0] ?? fallback;
}

/** `null` asks the material PSO factory for no color attachment. */
export function colorlessFormat<F extends string>(
  colorless: boolean,
  format: F | undefined,
): F | null | undefined {
  return colorless ? null : format;
}

/**
 * Fragment entry of a colorless scene prepass (UE DepthPass PositionOnly).
 * `null` drops the fragment stage when no coverage source can discard, so the
 * shared invariant vertex stage alone writes the same depth. Alpha mask, a
 * custom Surface, material clipping, LOD dither and view clipping keep it.
 */
export function colorlessFragmentEntry(
  colorless: boolean,
  variantSet: string | undefined,
  receipt: MaterialShaderArtifact['receipt'],
  surfaceDiscards: number | undefined,
  fragmentEntry: string | undefined,
): string | null | undefined {
  return colorless &&
    variantSet?.includes('ALPHA_MASK=false') === true &&
    receipt !== undefined &&
    receipt.surface === undefined &&
    !receipt.materialRow.fields.includes('clippingControl') &&
    surfaceDiscards === 0
    ? null
    : fragmentEntry;
}

/** Only a View with proven shadow demand (or its absence) specializes reception. */
export function effectiveStandardShadowReception(
  artifact: MaterialShaderArtifact | undefined,
  viewShadows: boolean | undefined,
): number | undefined {
  return viewShadows !== undefined &&
    artifact?.program.overrideIds.includes(STANDARD_SHADOW_RECEPTION_OVERRIDE) === true
    ? Number(viewShadows)
    : undefined;
}

/**
 * Select `axis=true` in a definesKey request. Record-stage requests usually
 * omit boot-off axes, so an absent axis is appended rather than left to the
 * resolver's `false` default.
 */
function selectAxisOn(variantSet: string, axis: string): string {
  if (variantSet.includes(`${axis}=false`))
    return variantSet.replace(`${axis}=false`, `${axis}=true`);
  if (variantSet.includes(`${axis}=true`)) return variantSet;
  // An empty key selects the manifest's all-true default row, which already
  // carries every discard source.
  return variantSet === '' ? variantSet : `${variantSet}+${axis}=true`;
}

/**
 * Resolve the discard request into the compile-time axes: the LOD bit
 * selects LOD_DITHER=true and the clipping bit CLIPPING_PLANES=true, and the transport key never
 * reaches pipeline constants.
 */
export function applySurfaceDiscardAxis(
  variantSet: string | undefined,
  constants: Readonly<Record<string, number>> | undefined,
): {
  readonly variantSet: string | undefined;
  readonly constants: Readonly<Record<string, number>> | undefined;
} {
  if (constants === undefined || !Object.hasOwn(constants, STANDARD_SURFACE_DISCARDS_OVERRIDE))
    return { variantSet, constants };
  const { [STANDARD_SURFACE_DISCARDS_OVERRIDE]: requested, ...rest } = constants;
  const mask = requested ?? 0;
  let selected = variantSet;
  if (selected !== undefined) {
    if ((mask & STANDARD_SURFACE_DISCARD_LOD_COVERAGE) !== 0)
      selected = selectAxisOn(selected, STANDARD_SURFACE_DISCARD_LOD_AXIS);
    // LOD cross-fade programs are published as lod+clip (merged states).
    if (
      (mask & (STANDARD_SURFACE_DISCARD_VIEW_CLIPPING | STANDARD_SURFACE_DISCARD_LOD_COVERAGE)) !==
      0
    )
      selected = selectAxisOn(selected, STANDARD_SURFACE_DISCARD_CLIPPING_AXIS);
  }
  return {
    variantSet: selected,
    constants: Object.keys(rest).length === 0 ? undefined : rest,
  };
}

export function materialAbiRasterConstants(
  standardTextureMask: number | undefined,
  standardSurfaceDiscards: number | undefined,
  standardShadowReception?: number,
): Record<string, number> | undefined {
  if (
    standardTextureMask === undefined &&
    standardSurfaceDiscards === undefined &&
    standardShadowReception === undefined
  )
    return undefined;
  return {
    ...(standardTextureMask === undefined
      ? {}
      : { [STANDARD_TEXTURE_MASK_OVERRIDE]: standardTextureMask }),
    ...(standardSurfaceDiscards === undefined
      ? {}
      : { [STANDARD_SURFACE_DISCARDS_OVERRIDE]: standardSurfaceDiscards }),
    ...(standardShadowReception === undefined
      ? {}
      : { [STANDARD_SHADOW_RECEPTION_OVERRIDE]: standardShadowReception }),
  };
}

/** Engine ABI values specialize only programs that declare those overrides.
 * Authored constants stay intact so the backend can validate their contract. */
export function materialProgramRasterConstants(
  constants: Readonly<Record<string, number>> | undefined,
  program: Pick<MaterialShaderArtifact['program'], 'overrideIds'> | string | undefined,
): Readonly<Record<string, number>> | undefined {
  if (constants === undefined || program === undefined || typeof program === 'string')
    return constants;
  const overrideIds = program.overrideIds;
  const omitTexture =
    Object.hasOwn(constants, STANDARD_TEXTURE_MASK_OVERRIDE) &&
    !overrideIds.includes(STANDARD_TEXTURE_MASK_OVERRIDE);
  const omitDiscards =
    Object.hasOwn(constants, STANDARD_SURFACE_DISCARDS_OVERRIDE) &&
    !overrideIds.includes(STANDARD_SURFACE_DISCARDS_OVERRIDE);
  const omitShadow =
    Object.hasOwn(constants, STANDARD_SHADOW_RECEPTION_OVERRIDE) &&
    !overrideIds.includes(STANDARD_SHADOW_RECEPTION_OVERRIDE);
  if (!omitTexture && !omitDiscards && !omitShadow) return constants;
  const selected = { ...constants };
  if (omitTexture) delete selected[STANDARD_TEXTURE_MASK_OVERRIDE];
  if (omitDiscards) delete selected[STANDARD_SURFACE_DISCARDS_OVERRIDE];
  if (omitShadow) delete selected[STANDARD_SHADOW_RECEPTION_OVERRIDE];
  return Object.keys(selected).length === 0 ? undefined : selected;
}

/** Texture masks also select vertex displacement; the surface discard gate is fragment-only. */
export function materialVertexConstants(
  constants: Readonly<Record<string, number>> | undefined,
): Readonly<Record<string, number>> | undefined {
  if (
    constants === undefined ||
    (!Object.hasOwn(constants, STANDARD_SURFACE_DISCARDS_OVERRIDE) &&
      !Object.hasOwn(constants, STANDARD_SHADOW_RECEPTION_OVERRIDE))
  )
    return constants;
  const vertex = { ...constants };
  delete vertex[STANDARD_SURFACE_DISCARDS_OVERRIDE];
  delete vertex[STANDARD_SHADOW_RECEPTION_OVERRIDE];
  return vertex;
}

/** One vertex-stage selection rule for ordinary and prepared material descriptors. */
export function pipelineVertexConstants(input: {
  readonly constants?: Readonly<Record<string, number>> | undefined;
  readonly vertexConstants?: Readonly<Record<string, number>> | undefined;
}): Readonly<Record<string, number>> | undefined {
  return input.vertexConstants ?? input.constants;
}
