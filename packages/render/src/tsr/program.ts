import type { BindGroupLayout, ComputePipeline, Sampler, TextureFormat } from '@forgeax/engine-rhi';
import {
  TSR_ANALYZE_FRAGMENT_WGSL,
  TSR_ANALYZE_WGSL,
  TSR_CLAMP_FRAGMENT_WGSL,
  TSR_CLAMP_WGSL,
  TSR_DILATE_FRAGMENT_VELOCITY_WGSL,
  TSR_DILATE_FRAGMENT_WGSL,
  TSR_DILATE_VELOCITY_WGSL,
  TSR_DILATE_WGSL,
  TSR_FLICKER_LUMA_FRAGMENT_WGSL,
  TSR_FLICKER_LUMA_WGSL,
  TSR_MEASURE_FRAGMENT_WGSL,
  TSR_MEASURE_WGSL,
  TSR_MOIRE_CLAMP_FRAGMENT_WGSL,
  TSR_MOIRE_CLAMP_WGSL,
  TSR_MOIRE_HISTORY_FRAGMENT_WGSL,
  TSR_MOIRE_HISTORY_WGSL,
  TSR_MOIRE_MEASURE_FRAGMENT_WGSL,
  TSR_MOIRE_MEASURE_WGSL,
  TSR_MOIRE_UPDATE_FRAGMENT_WGSL,
  TSR_MOIRE_UPDATE_WGSL,
  TSR_MOIRE_WGSL,
  TSR_RECONSTRUCT_FRAGMENT_WGSL,
  TSR_RECONSTRUCT_HALF_WGSL,
  TSR_RECONSTRUCT_WGSL,
  TSR_REJECT_FRAGMENT_WGSL,
  TSR_REJECT_FUSED_WGSL,
  TSR_REJECT_WGSL,
  TSR_RESOLVE_FRAGMENT_WGSL,
  TSR_RESOLVE_WGSL,
  TSR_RESURRECT_GUIDE_FRAGMENT_WGSL,
  TSR_RESURRECT_GUIDE_WGSL,
  TSR_RESURRECT_MEASURE_FRAGMENT_WGSL,
  TSR_RESURRECT_MEASURE_WGSL,
  TSR_SPATIAL_FRAGMENT_WGSL,
  TSR_SPATIAL_WGSL,
} from '@forgeax/engine-shader';
import { createRasterState } from '../raster-graph-state';
import type { RenderPipelineFrame } from '../render-pipeline';
import { TSR_ANALYSIS_FORMATS } from './layout';

/** Input-lattice stages (UE DilateVelocity, analysis, fused/multi-pass moire and shading rejection) and output-lattice reconstruction and history resolve. */
export type TsrStage =
  | 'dilate'
  | 'analyze'
  | 'resurrectGuide'
  | 'resurrectClamp'
  | 'resurrectMeasure'
  | 'flickerLuma'
  | 'moire'
  | 'moireClamp'
  | 'moireMeasure'
  | 'moireUpdate'
  | 'moireHistory'
  | 'clamp'
  | 'measure'
  | 'reject'
  | 'rejectFused'
  | 'spatial'
  | 'reconstruct'
  | 'resolve';

interface StageDescriptor {
  readonly entry: string;
  readonly sampled: number;
  readonly formats: readonly TextureFormat[];
  /** Whether the stage reads scene geometry and so has a velocity-reconstruction variant. */
  readonly scene: boolean;
  /** Binding of the scene temporal tuple, a uint texture in the velocity variant. */
  readonly temporal?: number;
  /** Bindings sampled with linear filtering; every other texture is read by texel load. */
  readonly filtered?: readonly number[];
  /** Compute workgroup tile width/height (default 8; fused LDS passes use 16). */
  readonly workgroupSize?: 8 | 16;
  readonly compute: readonly [string, string];
  readonly raster: readonly [string, string];
}

const HDR = 'rgba16float';
const CLAMP: StageDescriptor = {
  entry: 'tsr_clamp',
  sampled: 2,
  formats: [HDR, HDR],
  scene: false,
  compute: [TSR_CLAMP_WGSL, TSR_CLAMP_WGSL],
  raster: [TSR_CLAMP_FRAGMENT_WGSL, TSR_CLAMP_FRAGMENT_WGSL],
};
const STAGES: Readonly<Record<TsrStage, StageDescriptor>> = {
  dilate: {
    entry: 'tsr_dilate',
    sampled: 1,
    formats: [TSR_ANALYSIS_FORMATS.dilated, TSR_ANALYSIS_FORMATS.dilateEdge],
    scene: true,
    temporal: 0,
    compute: [TSR_DILATE_WGSL, TSR_DILATE_VELOCITY_WGSL],
    raster: [TSR_DILATE_FRAGMENT_WGSL, TSR_DILATE_FRAGMENT_VELOCITY_WGSL],
  },
  analyze: {
    entry: 'tsr_analyze',
    sampled: 7,
    formats: [HDR, HDR, TSR_ANALYSIS_FORMATS.moire, TSR_ANALYSIS_FORMATS.decimate],
    scene: false,
    filtered: [2],
    compute: [TSR_ANALYZE_WGSL, TSR_ANALYZE_WGSL],
    raster: [TSR_ANALYZE_FRAGMENT_WGSL, TSR_ANALYZE_FRAGMENT_WGSL],
  },
  // UE DecimateHistory resurrection reprojection of the persistent snapshot guide.
  resurrectGuide: {
    entry: 'tsr_resurrect_guide',
    sampled: 2,
    formats: [HDR],
    scene: false,
    filtered: [1],
    compute: [TSR_RESURRECT_GUIDE_WGSL, TSR_RESURRECT_GUIDE_WGSL],
    raster: [TSR_RESURRECT_GUIDE_FRAGMENT_WGSL, TSR_RESURRECT_GUIDE_FRAGMENT_WGSL],
  },
  flickerLuma: {
    entry: 'tsr_flicker_luma',
    sampled: 1,
    formats: [TSR_ANALYSIS_FORMATS.flickerLuma],
    scene: false,
    compute: [TSR_FLICKER_LUMA_WGSL, TSR_FLICKER_LUMA_WGSL],
    raster: [TSR_FLICKER_LUMA_FRAGMENT_WGSL, TSR_FLICKER_LUMA_FRAGMENT_WGSL],
  },
  // Fused single-pass compute UE ComputeMoireError (16x16 LDS tile).
  moire: {
    entry: 'tsr_moire',
    sampled: 5,
    formats: [TSR_ANALYSIS_FORMATS.moire, HDR],
    scene: false,
    workgroupSize: 16,
    compute: [TSR_MOIRE_WGSL, TSR_MOIRE_WGSL],
    raster: [TSR_MOIRE_HISTORY_FRAGMENT_WGSL, TSR_MOIRE_HISTORY_FRAGMENT_WGSL],
  },
  // Raster fallback multi-pass UE ComputeMoireError.
  moireClamp: {
    entry: 'tsr_moire_clamp',
    sampled: 3,
    formats: [HDR],
    scene: false,
    compute: [TSR_MOIRE_CLAMP_WGSL, TSR_MOIRE_CLAMP_WGSL],
    raster: [TSR_MOIRE_CLAMP_FRAGMENT_WGSL, TSR_MOIRE_CLAMP_FRAGMENT_WGSL],
  },
  moireMeasure: {
    entry: 'tsr_moire_measure',
    sampled: 1,
    formats: [HDR],
    scene: false,
    compute: [TSR_MOIRE_MEASURE_WGSL, TSR_MOIRE_MEASURE_WGSL],
    raster: [TSR_MOIRE_MEASURE_FRAGMENT_WGSL, TSR_MOIRE_MEASURE_FRAGMENT_WGSL],
  },
  moireUpdate: {
    entry: 'tsr_moire_update',
    sampled: 3,
    formats: [HDR],
    scene: false,
    compute: [TSR_MOIRE_UPDATE_WGSL, TSR_MOIRE_UPDATE_WGSL],
    raster: [TSR_MOIRE_UPDATE_FRAGMENT_WGSL, TSR_MOIRE_UPDATE_FRAGMENT_WGSL],
  },
  moireHistory: {
    entry: 'tsr_moire_history',
    sampled: 5,
    formats: [TSR_ANALYSIS_FORMATS.moire, HDR],
    scene: false,
    compute: [TSR_MOIRE_HISTORY_WGSL, TSR_MOIRE_HISTORY_WGSL],
    raster: [TSR_MOIRE_HISTORY_FRAGMENT_WGSL, TSR_MOIRE_HISTORY_FRAGMENT_WGSL],
  },
  clamp: CLAMP,
  // UE AnnihilateMutually3x3 of the input and the resurrected guide (usf:764-767): the same clamp.
  resurrectClamp: CLAMP,
  resurrectMeasure: {
    entry: 'tsr_resurrect_measure',
    sampled: 3,
    formats: [HDR, HDR],
    scene: false,
    compute: [TSR_RESURRECT_MEASURE_WGSL, TSR_RESURRECT_MEASURE_WGSL],
    raster: [TSR_RESURRECT_MEASURE_FRAGMENT_WGSL, TSR_RESURRECT_MEASURE_FRAGMENT_WGSL],
  },
  measure: {
    entry: 'tsr_measure',
    sampled: 4,
    formats: [HDR, HDR],
    scene: false,
    compute: [TSR_MEASURE_WGSL, TSR_MEASURE_WGSL],
    raster: [TSR_MEASURE_FRAGMENT_WGSL, TSR_MEASURE_FRAGMENT_WGSL],
  },
  reject: {
    entry: 'tsr_reject',
    sampled: 8,
    formats: [TSR_ANALYSIS_FORMATS.guide, TSR_ANALYSIS_FORMATS.decision],
    scene: false,
    compute: [TSR_REJECT_WGSL, TSR_REJECT_WGSL],
    raster: [TSR_REJECT_FRAGMENT_WGSL, TSR_REJECT_FRAGMENT_WGSL],
  },
  // Fused single-pass compute UE TSRRejectShading (16x16 LDS tile + workgroup-ballot resurrection).
  rejectFused: {
    entry: 'tsr_reject_fused',
    sampled: 5,
    formats: [TSR_ANALYSIS_FORMATS.guide, TSR_ANALYSIS_FORMATS.decision],
    scene: false,
    workgroupSize: 16,
    compute: [TSR_REJECT_FUSED_WGSL, TSR_REJECT_FUSED_WGSL],
    raster: [TSR_REJECT_FRAGMENT_WGSL, TSR_REJECT_FRAGMENT_WGSL],
  },
  spatial: {
    entry: 'tsr_spatial',
    sampled: 2,
    formats: [TSR_ANALYSIS_FORMATS.spatial],
    scene: false,
    compute: [TSR_SPATIAL_WGSL, TSR_SPATIAL_WGSL],
    raster: [TSR_SPATIAL_FRAGMENT_WGSL, TSR_SPATIAL_FRAGMENT_WGSL],
  },
  resolve: {
    entry: 'tsr_resolve',
    sampled: 1,
    formats: [HDR],
    scene: false,
    compute: [TSR_RESOLVE_WGSL, TSR_RESOLVE_WGSL],
    raster: [TSR_RESOLVE_FRAGMENT_WGSL, TSR_RESOLVE_FRAGMENT_WGSL],
  },
  reconstruct: {
    entry: 'tsr_reconstruct',
    sampled: 12,
    formats: [HDR, HDR, 'rgba8unorm'],
    scene: false,
    filtered: [0, 2, 4, 9, 10],
    compute: [TSR_RECONSTRUCT_WGSL, TSR_RECONSTRUCT_WGSL],
    raster: [TSR_RECONSTRUCT_FRAGMENT_WGSL, TSR_RECONSTRUCT_FRAGMENT_WGSL],
  },
};

/** Whether a stage reads raw scene geometry and so binds the optional velocity reconstruction. */
export function tsrStageUsesScene(stage: TsrStage): boolean {
  return STAGES[stage].scene;
}

/** Reconstruction and the history resolve evaluate the output lattice; every other stage the input lattice. */
export function tsrStageIsInputDomain(stage: TsrStage): boolean {
  return stage !== 'reconstruct' && stage !== 'resolve';
}

/** Compute workgroup tile dimension for a TSR stage (8x8 default, 16x16 for fused LDS stages). */
export function tsrStageWorkgroupSize(stage: TsrStage): 8 | 16 {
  return STAGES[stage].workgroupSize ?? 8;
}

interface TsrProgram {
  readonly layout: BindGroupLayout;
  readonly pipeline: ComputePipeline;
  readonly sampler: Sampler;
}

/** Only Guide/color/metadata history and current color use linear filtering. Scene
 * tuples, coverage, decisions and R32F secondary reactivity use texel loads. */
function sampleType(
  stage: TsrStage,
  binding: number,
  velocity: boolean,
): 'float' | 'unfilterable-float' | 'uint' {
  const descriptor = STAGES[stage];
  if (velocity && descriptor.temporal === binding) return 'uint';
  return descriptor.filtered?.includes(binding) ? 'float' : 'unfilterable-float';
}

function velocityBindings(visibility: number, velocity: boolean) {
  return velocity
    ? [
        {
          binding: 17,
          visibility,
          texture: { sampleType: 'depth' as const, viewDimension: '2d' as const },
        },
        { binding: 18, visibility, buffer: { type: 'uniform' as const } },
      ]
    : [];
}

export function createTsrProgram(
  frame: RenderPipelineFrame,
  stage: TsrStage,
  velocity = false,
  writeHalf = false,
): TsrProgram {
  const factory = frame.runtime.immediateShaderModuleFactory ?? frame.runtime.shaderModuleFactory;
  if (factory === undefined) throw new Error('TSR requires the renderer shader module factory');
  const descriptor = STAGES[stage];
  const entry = descriptor.entry;
  const scene = velocity && descriptor.scene;
  const emitHalf = stage === 'reconstruct' && writeHalf;
  const shader = factory.createShaderModule({
    label: entry,
    code: emitHalf ? TSR_RECONSTRUCT_HALF_WGSL : descriptor.compute[scene ? 1 : 0],
  });
  if (!shader.ok) throw shader.error;
  const sampledCount = descriptor.sampled;
  const uniformBinding = sampledCount + 1;
  const storageStart = uniformBinding + 1;
  const formats: readonly TextureFormat[] = emitHalf
    ? [...descriptor.formats, HDR]
    : descriptor.formats;
  const layout = frame.runtime.device.createBindGroupLayout({
    label: `${entry}.bindings`,
    entries: [
      ...Array.from({ length: sampledCount }, (_, binding) => ({
        binding,
        visibility: 4,
        texture: {
          sampleType: sampleType(stage, binding, scene),
          viewDimension: '2d' as const,
        },
      })),
      { binding: sampledCount, visibility: 4, sampler: { type: 'filtering' } },
      { binding: uniformBinding, visibility: 4, buffer: { type: 'uniform' } },
      ...velocityBindings(4, scene),
      ...formats.map((format, i) => ({
        binding: storageStart + i,
        visibility: 4,
        storageTexture: { access: 'write-only' as const, format, viewDimension: '2d' as const },
      })),
    ],
  });
  if (!layout.ok) throw layout.error;
  const pipelineLayout = frame.runtime.device.createPipelineLayout({
    label: `${entry}.layout`,
    bindGroupLayouts: [layout.value],
  });
  if (!pipelineLayout.ok) throw pipelineLayout.error;
  const pipeline = frame.runtime.device.createComputePipeline({
    label: entry,
    layout: pipelineLayout.value,
    compute: { module: shader.value, entryPoint: entry },
  });
  if (!pipeline.ok) throw pipeline.error;
  const sampler = frame.runtime.device.createSampler({
    label: `${entry}.sampler`,
    minFilter: 'linear',
    magFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });
  if (!sampler.ok) throw sampler.error;
  return { layout: layout.value, pipeline: pipeline.value, sampler: sampler.value };
}

/** The raster lane retains the exact sampled bindings and attachment cohort of each stage. */
export function createTsrRasterProgram(
  frame: RenderPipelineFrame,
  stage: TsrStage,
  velocity = false,
) {
  const descriptor = STAGES[stage];
  const count = descriptor.sampled;
  const scene = velocity && descriptor.scene;
  const state = createRasterState(
    frame,
    descriptor.raster[scene ? 1 : 0],
    descriptor.entry.replace('_', '-'),
    [
      ...Array.from({ length: count }, (_, binding) => ({
        binding,
        visibility: 2,
        texture: { sampleType: sampleType(stage, binding, scene), viewDimension: '2d' },
      })),
      { binding: count, visibility: 2, sampler: { type: 'filtering' } },
      { binding: count + 1, visibility: 2, buffer: { type: 'uniform' } },
      ...velocityBindings(2, scene),
    ],
    'tsr_fullscreen',
    `${descriptor.entry}_fragment`,
    descriptor.formats,
  );
  const sampler = frame.runtime.device
    .createSampler({
      label: `${state.label}.sampler`,
      minFilter: 'linear',
      magFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    })
    .unwrap();
  return { ...state, sampler };
}
