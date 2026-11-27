import type { BindGroupLayout, ComputePipeline, Sampler, TextureFormat } from '@forgeax/engine-rhi';
import {
  TSR_ANALYZE_FRAGMENT_VELOCITY_WGSL,
  TSR_ANALYZE_FRAGMENT_WGSL,
  TSR_ANALYZE_VELOCITY_WGSL,
  TSR_ANALYZE_WGSL,
  TSR_RECONSTRUCT_FRAGMENT_VELOCITY_WGSL,
  TSR_RECONSTRUCT_FRAGMENT_WGSL,
  TSR_RECONSTRUCT_HALF_VELOCITY_WGSL,
  TSR_RECONSTRUCT_HALF_WGSL,
  TSR_RECONSTRUCT_VELOCITY_WGSL,
  TSR_RECONSTRUCT_WGSL,
} from '@forgeax/engine-shader';
import { createRasterState } from '../raster-graph-state';
import type { RenderPipelineFrame } from '../render-pipeline';
import { TSR_ANALYSIS_FORMATS } from './layout';

interface TsrProgram {
  readonly layout: BindGroupLayout;
  readonly pipeline: ComputePipeline;
  readonly sampler: Sampler;
}

/** Only Guide/color history and current color use linear filtering. Scene
 * tuples, coverage, decisions and R32F secondary reactivity use texel loads. */
function sampleType(
  analyze: boolean,
  binding: number,
  velocity: boolean,
): 'float' | 'unfilterable-float' | 'uint' {
  if (binding === 1 && velocity) return 'uint';
  return binding === 2 || (!analyze && binding === 0) ? 'float' : 'unfilterable-float';
}

function velocityBindings(visibility: number, velocity: boolean) {
  return velocity
    ? [
        {
          binding: 14,
          visibility,
          texture: { sampleType: 'depth' as const, viewDimension: '2d' as const },
        },
        { binding: 15, visibility, buffer: { type: 'uniform' as const } },
      ]
    : [];
}

export function createTsrProgram(
  frame: RenderPipelineFrame,
  analyze: boolean,
  velocity = false,
  writeHalf = false,
): TsrProgram {
  const factory = frame.runtime.immediateShaderModuleFactory ?? frame.runtime.shaderModuleFactory;
  if (factory === undefined) throw new Error('TSR requires the renderer shader module factory');
  const entry = analyze ? 'tsr_analyze' : 'tsr_reconstruct';
  const shader = factory.createShaderModule({
    label: entry,
    code: analyze
      ? velocity
        ? TSR_ANALYZE_VELOCITY_WGSL
        : TSR_ANALYZE_WGSL
      : writeHalf
        ? velocity
          ? TSR_RECONSTRUCT_HALF_VELOCITY_WGSL
          : TSR_RECONSTRUCT_HALF_WGSL
        : velocity
          ? TSR_RECONSTRUCT_VELOCITY_WGSL
          : TSR_RECONSTRUCT_WGSL,
  });
  if (!shader.ok) throw shader.error;
  const sampledCount = analyze ? 7 : 8;
  const uniformBinding = analyze ? 8 : 9;
  const storageStart = uniformBinding + 1;
  const formats: TextureFormat[] = analyze
    ? [TSR_ANALYSIS_FORMATS.guide, TSR_ANALYSIS_FORMATS.moire, TSR_ANALYSIS_FORMATS.decision]
    : ['rgba16float', 'rgba16float', 'rgba8unorm'];
  if (writeHalf) formats.push('rgba16float');
  const layout = frame.runtime.device.createBindGroupLayout({
    label: `${entry}.bindings`,
    entries: [
      ...Array.from({ length: sampledCount }, (_, binding) => ({
        binding,
        visibility: 4,
        texture: {
          sampleType: sampleType(analyze, binding, velocity),
          viewDimension: '2d' as const,
        },
      })),
      { binding: sampledCount, visibility: 4, sampler: { type: 'filtering' } },
      { binding: uniformBinding, visibility: 4, buffer: { type: 'uniform' } },
      ...velocityBindings(4, velocity),
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

/** The raster lane retains the exact sampled bindings and three-output cohort. */
export function createTsrRasterProgram(
  frame: RenderPipelineFrame,
  analyze: boolean,
  velocity = false,
) {
  const count = analyze ? 7 : 8;
  const state = createRasterState(
    frame,
    velocity
      ? analyze
        ? TSR_ANALYZE_FRAGMENT_VELOCITY_WGSL
        : TSR_RECONSTRUCT_FRAGMENT_VELOCITY_WGSL
      : analyze
        ? TSR_ANALYZE_FRAGMENT_WGSL
        : TSR_RECONSTRUCT_FRAGMENT_WGSL,
    analyze ? 'tsr-analyze' : 'tsr-reconstruct',
    [
      ...Array.from({ length: count }, (_, binding) => ({
        binding,
        visibility: 2,
        texture: { sampleType: sampleType(analyze, binding, velocity), viewDimension: '2d' },
      })),
      { binding: count, visibility: 2, sampler: { type: 'filtering' } },
      { binding: count + 1, visibility: 2, buffer: { type: 'uniform' } },
      ...velocityBindings(2, velocity),
    ],
    'tsr_fullscreen',
    analyze ? 'tsr_analyze_fragment' : 'tsr_reconstruct_fragment',
    analyze
      ? [TSR_ANALYSIS_FORMATS.guide, TSR_ANALYSIS_FORMATS.moire, TSR_ANALYSIS_FORMATS.decision]
      : ['rgba16float', 'rgba16float', 'rgba8unorm'],
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
