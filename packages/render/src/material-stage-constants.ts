import {
  type MaterialShaderArtifact,
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

/** Programs without the override retain their original static discard behavior. */
export function effectiveStandardSurfaceDiscards(
  artifact: MaterialShaderArtifact | undefined,
  standardSurfaceDiscards: number | undefined,
): number | undefined {
  return standardSurfaceDiscards !== undefined &&
    artifact?.program.overrideIds.includes(STANDARD_SURFACE_DISCARDS_OVERRIDE)
    ? standardSurfaceDiscards
    : undefined;
}

export function materialAbiRasterConstants(
  standardTextureMask: number | undefined,
  standardSurfaceDiscards: number | undefined,
): Record<string, number> | undefined {
  if (standardTextureMask === undefined && standardSurfaceDiscards === undefined) return undefined;
  return {
    ...(standardTextureMask === undefined
      ? {}
      : { [STANDARD_TEXTURE_MASK_OVERRIDE]: standardTextureMask }),
    ...(standardSurfaceDiscards === undefined
      ? {}
      : { [STANDARD_SURFACE_DISCARDS_OVERRIDE]: standardSurfaceDiscards }),
  };
}

/** Texture masks also select vertex displacement; Surface discard gates are fragment-only. */
export function materialVertexConstants(
  constants: Readonly<Record<string, number>> | undefined,
): Readonly<Record<string, number>> | undefined {
  if (constants === undefined || !Object.hasOwn(constants, STANDARD_SURFACE_DISCARDS_OVERRIDE))
    return constants;
  const vertex = { ...constants };
  delete vertex[STANDARD_SURFACE_DISCARDS_OVERRIDE];
  return vertex;
}

/** One vertex-stage selection rule for ordinary and prepared material descriptors. */
export function pipelineVertexConstants(input: {
  readonly constants?: Readonly<Record<string, number>> | undefined;
  readonly vertexConstants?: Readonly<Record<string, number>> | undefined;
}): Readonly<Record<string, number>> | undefined {
  return input.vertexConstants ?? input.constants;
}
