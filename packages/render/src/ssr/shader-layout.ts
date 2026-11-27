import type { GraphTextureView } from '@forgeax/engine-render-graph';
import type { SsrShaderSources } from '../render-contract';
import {
  STANDARD_GBUFFER_COMPACT_PIPELINE_CONSTANTS,
  STANDARD_GBUFFER_V2_PIPELINE_CONSTANTS,
} from '../standard-attachments';

export interface SsrGBufferInput {
  readonly gbufferV2?: boolean;
  /** GBuffer B carries roughness separately from the Default GBuffer normal. */
  readonly compactMaterial?: GraphTextureView;
}

export function ssrShaderGBufferMismatch(
  sources: SsrShaderSources | undefined,
  input: SsrGBufferInput,
) {
  const compact = input.compactMaterial !== undefined;
  if (!compact && input.gbufferV2 !== true) return undefined;
  const expected = compact ? 'standard-gbuffer/4' : 'standard-gbuffer/2';
  const actual = compact ? sources?.compactGbuffer : sources?.gbuffer;
  return actual === expected ? undefined : { expected, actual: actual ?? 'missing' };
}

export function ssrGBufferConstants(input: SsrGBufferInput) {
  if (input.compactMaterial !== undefined) return STANDARD_GBUFFER_COMPACT_PIPELINE_CONSTANTS;
  return input.gbufferV2 === true ? STANDARD_GBUFFER_V2_PIPELINE_CONSTANTS : undefined;
}
