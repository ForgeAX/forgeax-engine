import type { ColorValueDomain } from '@forgeax/engine-render-graph';
import type { RenderPipelineAsset } from '@forgeax/engine-types';

export type StandardOutputContract = NonNullable<
  NonNullable<RenderPipelineAsset['config']>['outputContract']
>;

export function isStandardOutputContract(value: unknown): value is StandardOutputContract {
  return value === 'standard-output-v1' || value === 'standard-output-v2';
}

const STANDARD_OUTPUT_LOGICAL_STAGES = [
  'temporal',
  'meter',
  'dof',
  'chromatic-aberration',
  'bloom',
  'lens-flare',
  'exposure-white-balance',
  'tone',
  'lut',
  'vignette',
  'outline',
  'barrel-distortion',
  'fxaa',
  'lens-effects',
  'sharpen',
  'grain',
  'smaa',
  'output-encoding',
] as const;

export type StandardOutputLogicalStage = (typeof STANDARD_OUTPUT_LOGICAL_STAGES)[number];

export interface StandardOutputRequest {
  /** Omission retains the saved V1 contract, independently of new renderer defaults. */
  readonly contract?: StandardOutputContract;
  readonly temporal: boolean;
  readonly meter: boolean;
  readonly bloom: boolean;
  /** Built-in spatial DoF stage; false keeps the path exact-zero. */
  readonly dof?: boolean;
  /** Radial scene color fringe before Bloom and tone mapping, as UE. */
  readonly chromaticAberration?: boolean;
  /** Image-based ghosts from bright HDR pixels, after Bloom. */
  readonly lensFlare?: boolean;
  readonly exposure: boolean;
  readonly whiteBalance: boolean;
  readonly lut: boolean;
  /** Output-space barrel warp; runs after LUT in linear-LDR. */
  readonly outline?: boolean;
  readonly barrelDistortion?: boolean;
  readonly lensEffects?: boolean;
  readonly fxaa: boolean;
  readonly smaa?: boolean;
  readonly sharpen?: boolean;
}

/** Logical value-domain boundaries, not physical passes or GPU work counts. */
export interface StandardOutputStageDomain {
  readonly name: StandardOutputLogicalStage;
  readonly input: ColorValueDomain;
  readonly output: ColorValueDomain;
}

export interface StandardOutputPlan {
  readonly contract: StandardOutputContract;
  readonly features: Readonly<
    Pick<
      StandardOutputRequest,
      | 'temporal'
      | 'meter'
      | 'bloom'
      | 'dof'
      | 'chromaticAberration'
      | 'lensFlare'
      | 'exposure'
      | 'whiteBalance'
      | 'lut'
      | 'outline'
      | 'barrelDistortion'
      | 'lensEffects'
      | 'fxaa'
      | 'smaa'
    >
  >;
  readonly logicalStages: readonly StandardOutputLogicalStage[];
  readonly stageDomains: readonly StandardOutputStageDomain[];
  readonly incrementalResources: readonly string[];
  readonly incrementalBindings: number;
}
