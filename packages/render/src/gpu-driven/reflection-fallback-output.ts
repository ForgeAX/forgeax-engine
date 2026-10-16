import type { TextureFormat } from '@forgeax/engine-rhi';
import type { MaterialRenderState } from '@forgeax/engine-types';

const REFLECTION_FALLBACK_FORMAT: TextureFormat = 'rgba16float';

/**
 * Keep the graph's shared SSR attachment layout compatible with GPU-driven
 * materials whose selected fragment variant does not write its second output.
 * The target stays present for pass compatibility but receives no writes.
 */
export function gpuDrivenReflectionFallbackRenderState(input: {
  readonly renderState: MaterialRenderState | undefined;
  readonly colorFormat: TextureFormat;
  readonly additionalColorFormats: readonly TextureFormat[];
  /** The pipeline role is selected by the caller; authored entry names are not role metadata. */
  readonly forwardColorPass: boolean;
  readonly reflectionFallbackOutputAvailable: boolean;
}): MaterialRenderState | undefined {
  if (
    !input.forwardColorPass ||
    input.additionalColorFormats.length !== 1 ||
    input.additionalColorFormats[0] !== REFLECTION_FALLBACK_FORMAT
  ) {
    return input.renderState;
  }

  const fallbackOutput = {
    name: 'reflection-fallback',
    format: REFLECTION_FALLBACK_FORMAT,
    ...(input.reflectionFallbackOutputAvailable ? {} : { writeMask: 0 as const }),
  };
  const outputs = input.renderState?.outputs;
  if (outputs !== undefined) {
    if (outputs.length !== 1 || outputs[0]?.format !== input.colorFormat) {
      return input.renderState;
    }
    return { ...input.renderState, outputs: [outputs[0], fallbackOutput] };
  }
  if (input.reflectionFallbackOutputAvailable) return input.renderState;

  const colorOutput = {
    name: 'color',
    format: input.colorFormat,
    ...(input.renderState?.blend === undefined ? {} : { blend: input.renderState.blend }),
    ...(input.renderState?.colorWriteMask === undefined
      ? {}
      : { writeMask: input.renderState.colorWriteMask }),
  };
  return { ...(input.renderState ?? {}), outputs: [colorOutput, fallbackOutput] };
}
