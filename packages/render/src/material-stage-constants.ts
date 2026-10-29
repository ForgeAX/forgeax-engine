import { STANDARD_SURFACE_DISCARDS_OVERRIDE } from '@forgeax/engine-shader';

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
