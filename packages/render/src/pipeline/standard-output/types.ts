import type { ColorValueDomain } from '@forgeax/engine-render-graph';

export const STANDARD_OUTPUT_LOGICAL_STAGES = [
  'temporal',
  'meter',
  'dof',
  'bloom',
  'lens-flare',
  'exposure-white-balance',
  'tone',
  'lut',
  'outline',
  'barrel-distortion',
  'fxaa',
  'lens-effects',
  'smaa',
  'output-encoding',
] as const;

export type StandardOutputLogicalStage = (typeof STANDARD_OUTPUT_LOGICAL_STAGES)[number];
export type StandardOutputLane = 'direct' | 'clustered';
export type StandardOutputEncoding = 'explicit-oetf' | 'srgb-attachment';

export interface StandardColorLutBinding {
  readonly viewDimension: '3d';
  readonly size: number;
  readonly strength: number;
}

export interface StandardOutputRequest {
  readonly lane: StandardOutputLane;
  readonly temporal: boolean;
  readonly meter: boolean;
  readonly bloom: boolean;
  /** Built-in spatial DoF stage; false keeps the path exact-zero. */
  readonly dof?: boolean;
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
  readonly outputEncoding: StandardOutputEncoding;
}

export interface StandardOutputPhysicalStage {
  readonly name: StandardOutputLogicalStage;
  readonly input: ColorValueDomain;
  readonly output: ColorValueDomain;
}

export interface StandardOutputPlan {
  readonly lane: StandardOutputLane;
  readonly features: Readonly<
    Pick<
      StandardOutputRequest,
      | 'temporal'
      | 'meter'
      | 'bloom'
      | 'dof'
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
  readonly outputEncoding: StandardOutputEncoding;
  readonly logicalStages: readonly StandardOutputLogicalStage[];
  readonly physicalStages: readonly StandardOutputPhysicalStage[];
  readonly finalWriterCount: 1;
  readonly outputEncodingCount: 1;
  readonly incrementalResources: readonly string[];
  readonly incrementalBindings: number;
  readonly incrementalTimestamps: number;
}
