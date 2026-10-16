import type {
  GraphBuffer,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type { BindGroupLayout, Buffer, ComputePipeline, RhiDevice } from '@forgeax/engine-rhi';
import { AUTO_EXPOSURE_METER_WGSL } from '@forgeax/engine-shader';
import { err, ok, type Result } from '@forgeax/engine-types';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_STORAGE } from '../../../gpu-usage';
import type { _InternalRenderPipelineContext } from '../../../record/render-context';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../../../render-pipeline';
import { addStandardColorStagePass } from '../color-transform';
import {
  AUTO_EXPOSURE_FUSED_GRAPH_PASS,
  AUTO_EXPOSURE_HISTOGRAM_DISPATCH,
  resolveAutoExposureShaderModuleFactory,
} from './graph';
import { AutoExposureCapabilityUnavailableError } from './inspection';

export const AUTO_EXPOSURE_HISTOGRAM_BYTES = 1024;
export const AUTO_EXPOSURE_STATE_BYTES = 32;
export const AUTO_EXPOSURE_CANDIDATE_BYTES = 16;
/** Camera/time inputs consumed by adapt; this is not a CPU exposure estimate. */
export const AUTO_EXPOSURE_PARAMETERS_BYTES = 32;

export interface AutoExposureGpuParameters {
  readonly compensationEv: number;
  readonly rangeMinEv: number;
  readonly rangeMaxEv: number;
  readonly upRate: number;
  readonly downRate: number;
  readonly deltaTime: number;
  readonly fallback: number;
  readonly generation: number;
}

export interface AutoExposureGpuResources {
  readonly histogram: Buffer;
  readonly state: Buffer;
  readonly candidate: Buffer;
  readonly parameters: Buffer;
  readonly device: RhiDevice;
  readonly generation: number;
}

export interface AutoExposureGraphResources {
  readonly histogram: GraphBuffer;
  readonly state: GraphBuffer;
  readonly candidate: GraphBuffer;
  readonly parameters: GraphBuffer;
}

export interface AutoExposureGraphProjection {
  readonly source: RenderPipelineTarget;
  readonly resources: AutoExposureGraphResources;
  readonly width: number;
  readonly height: number;
}

const COMPUTE_VISIBILITY = 4;

function createBuffer(
  device: RhiDevice,
  label: string,
  size: number,
  usage = GPU_BUFFER_USAGE_STORAGE,
): Result<Buffer, unknown> {
  return device.createBuffer({
    label,
    size,
    usage,
    mappedAtCreation: false,
  });
}

/** Allocate the one device-scoped auto-exposure resource set. */
export function createAutoExposureGpuResources(
  device: RhiDevice,
  generation: number,
): Result<AutoExposureGpuResources, unknown> {
  if (!device.caps.compute) {
    return err(new AutoExposureCapabilityUnavailableError({ capability: 'compute', generation }));
  }
  if (!device.caps.storageBuffer) {
    return err(
      new AutoExposureCapabilityUnavailableError({ capability: 'storage-buffer', generation }),
    );
  }
  const histogram = createBuffer(
    device,
    'standard-auto-exposure-histogram',
    AUTO_EXPOSURE_HISTOGRAM_BYTES,
  );
  if (!histogram.ok) return histogram;
  const state = createBuffer(
    device,
    'standard-auto-exposure-state',
    AUTO_EXPOSURE_STATE_BYTES,
    GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
  );
  if (!state.ok) {
    device.destroyBuffer(histogram.value);
    return state;
  }
  // The first adapt dispatch reads the previous accepted GPU state.  Seed it
  // once at allocation time so an uninitialized storage buffer can never be
  // mistaken for a valid prior generation.  This is initialization metadata,
  // not a per-frame exposure readback or result upload.
  const initialized = device.queue.writeBuffer(
    state.value,
    0,
    new Uint8Array(AUTO_EXPOSURE_STATE_BYTES),
  );
  if (!initialized.ok) {
    device.destroyBuffer(histogram.value);
    device.destroyBuffer(state.value);
    return initialized;
  }
  const candidate = createBuffer(
    device,
    'standard-auto-exposure-candidate',
    AUTO_EXPOSURE_CANDIDATE_BYTES,
  );
  if (!candidate.ok) {
    device.destroyBuffer(histogram.value);
    device.destroyBuffer(state.value);
    return candidate;
  }
  const parameters = createBuffer(
    device,
    'standard-auto-exposure-parameters',
    AUTO_EXPOSURE_PARAMETERS_BYTES,
    GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
  );
  if (!parameters.ok) {
    device.destroyBuffer(histogram.value);
    device.destroyBuffer(state.value);
    device.destroyBuffer(candidate.value);
    return parameters;
  }
  return ok({
    histogram: histogram.value,
    state: state.value,
    candidate: candidate.value,
    parameters: parameters.value,
    device,
    generation,
  });
}

/** Upload only authored camera/time metadata consumed by the GPU adaptation. */
export function writeAutoExposureParameters(
  resources: AutoExposureGpuResources,
  parameters: AutoExposureGpuParameters,
): Result<void, unknown> {
  const values = new Float32Array([
    parameters.compensationEv,
    parameters.rangeMinEv,
    parameters.rangeMaxEv,
    parameters.upRate,
    parameters.downRate,
    parameters.deltaTime,
    parameters.fallback,
    parameters.generation,
  ]);
  return resources.device.queue.writeBuffer(resources.parameters, 0, values);
}

export function retireAutoExposureGpuResources(resources: AutoExposureGpuResources): void {
  resources.device.destroyBuffer(resources.histogram);
  resources.device.destroyBuffer(resources.state);
  resources.device.destroyBuffer(resources.candidate);
  resources.device.destroyBuffer(resources.parameters);
}

/** Import persistent buffers into the current typed graph without exposing handles in topology. */
export function importAutoExposureGraphResources(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
): Result<AutoExposureGraphResources, RenderGraphError> {
  const resolve = (frame: RenderPipelineFrame): AutoExposureGpuResources => {
    const state = (frame as _InternalRenderPipelineContext).frameState;
    const resources = state.pendingAutoExposureGpuResources ?? state.autoExposureGpuResources;
    if (resources === undefined) throw new Error('auto-exposure GPU resources were not prepared');
    return resources;
  };
  const histogram = graph.importBuffer(
    'standard-auto-exposure-histogram',
    {
      size: AUTO_EXPOSURE_HISTOGRAM_BYTES,
      usage: GPU_BUFFER_USAGE_STORAGE,
    },
    (frame) => resolve(frame).histogram,
  );
  if (!histogram.ok) return histogram;
  const state = graph.importBuffer(
    'standard-auto-exposure-state',
    {
      size: AUTO_EXPOSURE_STATE_BYTES,
      usage: GPU_BUFFER_USAGE_STORAGE,
    },
    (frame) => resolve(frame).state,
  );
  if (!state.ok) return state;
  const candidate = graph.importBuffer(
    'standard-auto-exposure-candidate',
    {
      size: AUTO_EXPOSURE_CANDIDATE_BYTES,
      usage: GPU_BUFFER_USAGE_STORAGE,
    },
    (frame) => resolve(frame).candidate,
  );
  if (!candidate.ok) return candidate;
  const parameters = graph.importBuffer(
    'standard-auto-exposure-parameters',
    {
      size: AUTO_EXPOSURE_PARAMETERS_BYTES,
      usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
    },
    (frame) => resolve(frame).parameters,
  );
  if (!parameters.ok) return parameters;
  return ok({
    histogram: histogram.value,
    state: state.value,
    candidate: candidate.value,
    parameters: parameters.value,
  });
}

interface AutoExposureMeterState {
  readonly layout: BindGroupLayout;
  readonly clearPipeline: ComputePipeline;
  readonly histogramPipeline: ComputePipeline;
  readonly adaptPipeline: ComputePipeline;
}

function createAutoExposureMeterState(frame: RenderPipelineFrame): AutoExposureMeterState {
  const factory = resolveAutoExposureShaderModuleFactory(frame.runtime);
  if (factory === undefined) throw new Error('auto-exposure meter shader factory unavailable');
  const module = factory.createShaderModule({
    code: AUTO_EXPOSURE_METER_WGSL,
    label: 'auto_exposure_meter',
  });
  if (!module.ok) throw module.error;
  const layout = frame.runtime.device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: COMPUTE_VISIBILITY,
        texture: { sampleType: 'float', viewDimension: '2d' },
      },
      { binding: 1, visibility: COMPUTE_VISIBILITY, buffer: { type: 'storage' } },
      { binding: 2, visibility: COMPUTE_VISIBILITY, buffer: { type: 'storage' } },
      { binding: 3, visibility: COMPUTE_VISIBILITY, buffer: { type: 'storage' } },
      { binding: 4, visibility: COMPUTE_VISIBILITY, buffer: { type: 'read-only-storage' } },
    ],
  });
  if (!layout.ok) throw layout.error;
  const pipelineLayout = frame.runtime.device.createPipelineLayout({
    label: 'auto_exposure_meter.layout',
    bindGroupLayouts: [layout.value],
  });
  if (!pipelineLayout.ok) throw pipelineLayout.error;
  const createPipeline = (label: string, entryPoint: string): ComputePipeline => {
    const pipeline = frame.runtime.device.createComputePipeline({
      label,
      layout: pipelineLayout.value,
      compute: { module: module.value, entryPoint },
    });
    if (!pipeline.ok) throw pipeline.error;
    return pipeline.value;
  };
  return {
    layout: layout.value,
    clearPipeline: createPipeline('auto_exposure_clear', 'auto_exposure_clear'),
    histogramPipeline: createPipeline('auto_exposure_histogram', 'auto_exposure_histogram'),
    adaptPipeline: createPipeline('auto_exposure_adapt', 'auto_exposure_adapt'),
  };
}

/**
 * Add the real same-frame clear -> histogram -> adapt producer chain.
 *
 * The three logical stages are three ordered dispatches in one real compute
 * pass. Clear and adapt use one workgroup each; histogram uses the fixed
 * 32-workgroup cohort. The pass remains the timing interval, so no marker,
 * native copy boundary, or CPU histogram transfer is introduced.
 */
export function addAutoExposureGraphPasses(
  context: import('../../../render-pipeline').RenderPipelineBuildContext<RenderPipelineFrame>,
  projection: AutoExposureGraphProjection,
): Result<void, RenderGraphError> {
  let meterState: AutoExposureMeterState | undefined;
  const meter = context.graph.addComputePass(AUTO_EXPOSURE_FUSED_GRAPH_PASS, {
    accesses: [
      { resource: projection.source.view, usage: 'sampled-read' },
      // The clear dispatch initializes the histogram before the histogram
      // dispatch reads/writes it. `storage-write` keeps graph validation from
      // requiring an external initializer while the binding remains read/write.
      { resource: projection.resources.histogram, usage: 'storage-write' },
      { resource: projection.resources.state, usage: 'storage-write' },
      { resource: projection.resources.candidate, usage: 'storage-write' },
      { resource: projection.resources.parameters, usage: 'storage-read' },
    ],
    encode: ({ pass, frame, resources }) => {
      meterState ??= createAutoExposureMeterState(frame);
      const source = resources.textureView(projection.source.view);
      const histogramBuffer = resources.buffer(projection.resources.histogram);
      const state = resources.buffer(projection.resources.state);
      const candidate = resources.buffer(projection.resources.candidate);
      const parameters = resources.buffer(projection.resources.parameters);
      if (!source.ok) throw source.error;
      if (!histogramBuffer.ok) throw histogramBuffer.error;
      if (!state.ok) throw state.error;
      if (!candidate.ok) throw candidate.error;
      if (!parameters.ok) throw parameters.error;
      const bindings = frame.runtime.device.createBindGroup({
        layout: meterState.layout,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: source.value } },
          {
            binding: 1,
            resource: { kind: 'buffer', value: { buffer: histogramBuffer.value } },
          },
          {
            binding: 2,
            resource: { kind: 'buffer', value: { buffer: state.value } },
          },
          {
            binding: 3,
            resource: { kind: 'buffer', value: { buffer: candidate.value } },
          },
          {
            binding: 4,
            resource: { kind: 'buffer', value: { buffer: parameters.value } },
          },
        ],
      });
      if (!bindings.ok) throw bindings.error;
      pass.setBindGroup(0, bindings.value);
      pass.setPipeline(meterState.clearPipeline);
      pass.dispatchWorkgroups(1, 1, 1);
      pass.setPipeline(meterState.histogramPipeline);
      pass.dispatchWorkgroups(
        AUTO_EXPOSURE_HISTOGRAM_DISPATCH.x,
        AUTO_EXPOSURE_HISTOGRAM_DISPATCH.y,
        AUTO_EXPOSURE_HISTOGRAM_DISPATCH.z,
      );
      pass.setPipeline(meterState.adaptPipeline);
      pass.dispatchWorkgroups(1, 1, 1);
    },
  });
  return meter.ok ? ok(undefined) : meter;
}

export interface AutoExposureWhiteBalance {
  readonly temperature: number;
  readonly tint: number;
}

function wgslFloat(value: number): string {
  // WGSL uses context-typed decimal float literals; unlike GLSL, it does not
  // accept an `f` suffix. Keep the literal decimal and let the `f32` constant
  // declaration provide the scalar type.
  return Number.isFinite(value) ? value.toFixed(8) : '0.0';
}

/**
 * Build the sole linear-HDR exposure/white-balance consumer.  The camera
 * projection supplies temperature/tint as immutable shader constants for the
 * frame topology; the candidate remains a same-frame GPU buffer when auto
 * exposure is enabled.  Keeping this in one source prevents a renderer-side
 * WB override from becoming a second color-stage authority.
 */
export function createAutoExposureApplyWgsl(
  whiteBalance: AutoExposureWhiteBalance = { temperature: 6504, tint: 0 },
  hasCandidate = true,
): string {
  const candidateBinding = hasCandidate
    ? '@group(1) @binding(0) var<storage, read> candidate: array<vec4<f32>>;'
    : '';
  const candidateValue = hasCandidate ? 'max(candidate[0].x, 0.0)' : '1.0';
  return /* wgsl */ `
${candidateBinding}

const WB_TEMPERATURE: f32 = ${wgslFloat(whiteBalance.temperature)};
const WB_TINT: f32 = ${wgslFloat(whiteBalance.tint)};

fn mul_rgb_to_xyz(value: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    dot(vec3<f32>(0.4124564, 0.3575761, 0.1804375), value),
    dot(vec3<f32>(0.2126729, 0.7151522, 0.0721750), value),
    dot(vec3<f32>(0.0193339, 0.1191920, 0.9503041), value)
  );
}

fn mul_bradford(value: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    dot(vec3<f32>(0.8951, 0.2664, -0.1614), value),
    dot(vec3<f32>(-0.7502, 1.7135, 0.0367), value),
    dot(vec3<f32>(0.0389, -0.0685, 1.0296), value)
  );
}

fn mul_bradford_inverse(value: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    dot(vec3<f32>(0.9869929, -0.1470543, 0.1599627), value),
    dot(vec3<f32>(0.4323053, 0.5183603, 0.0492912), value),
    dot(vec3<f32>(-0.0085287, 0.0400428, 0.9684867), value)
  );
}

fn blackbody_white_point(temperature: f32) -> vec3<f32> {
  if (temperature == 6504.0) { return vec3<f32>(0.95047, 1.0, 1.08883); }
  let t = clamp(temperature, 1000.0, 40000.0);
  var x: f32;
  if (t <= 4000.0) {
    x = -0.2661239e9 / (t * t * t) - 0.234358e6 / (t * t) + 0.8776956e3 / t + 0.17991;
  } else {
    x = -3.0258469e9 / (t * t * t) + 2.1070379e6 / (t * t) + 0.2226347e3 / t + 0.24039;
  }
  var y: f32;
  if (t <= 2222.0) {
    y = -1.1063814 * x * x * x - 1.3481102 * x * x + 2.18555832 * x - 0.20219683;
  } else if (t <= 4000.0) {
    y = -0.9549476 * x * x * x - 1.37418593 * x * x + 2.09137015 * x - 0.16748867;
  } else {
    y = 3.081758 * x * x * x - 5.8733867 * x * x + 3.75112997 * x - 0.37001483;
  }
  return vec3<f32>(x / y, 1.0, (1.0 - x - y) / y);
}

fn apply_white_balance(value: vec3<f32>) -> vec3<f32> {
  if (WB_TEMPERATURE == 6504.0 && WB_TINT == 0.0) { return value; }
  let source_lms = mul_bradford(vec3<f32>(0.95047, 1.0, 1.08883));
  let target_lms = mul_bradford(blackbody_white_point(WB_TEMPERATURE));
  let scale = target_lms / source_lms;
  let adapted_lms = mul_bradford(mul_rgb_to_xyz(value)) * scale;
  let adapted_xyz = mul_bradford_inverse(adapted_lms);
  let adapted_rgb = vec3<f32>(adapted_xyz.x / 0.95047, adapted_xyz.y, adapted_xyz.z / 1.08883);
  return adapted_rgb * vec3<f32>(
    max(0.0, 1.0 + WB_TINT),
    max(0.0, 1.0 - WB_TINT),
    max(0.0, 1.0 + WB_TINT)
  );
}

@fragment fn color_stage_fs(input: VertexOutput) -> @location(0) vec4<f32> {
  let color = textureSampleLevel(source, sourceSampler, input.uv, 0.0);
  let exposed = color.rgb * ${candidateValue};
  return vec4<f32>(apply_white_balance(exposed), color.a);
}`;
}

/** Consume the same-frame adaptation candidate in the linear HDR domain. */
export function addAutoExposureExposurePass(
  context: import('../../../render-pipeline').RenderPipelineBuildContext<RenderPipelineFrame>,
  input: RenderPipelineTarget,
  output: RenderPipelineTarget,
  resources: AutoExposureGraphResources | undefined,
  whiteBalance: AutoExposureWhiteBalance = { temperature: 6504, tint: 0 },
): Result<void, RenderGraphError> {
  let candidateLayout: BindGroupLayout | undefined;
  return addStandardColorStagePass(
    context.graph,
    'standard-exposure-white-balance',
    input,
    output,
    createAutoExposureApplyWgsl(whiteBalance, resources !== undefined),
    resources === undefined
      ? undefined
      : {
          accesses: [{ resource: resources.candidate, usage: 'storage-read' }],
          bind: (device, graphResources) => {
            if (candidateLayout === undefined) {
              const created = device.createBindGroupLayout({
                label: 'standard-exposure-white-balance.candidate.bgl',
                entries: [{ binding: 0, visibility: 2, buffer: { type: 'read-only-storage' } }],
              });
              if (!created.ok) throw created.error;
              candidateLayout = created.value;
            }
            const candidate = graphResources.buffer(resources.candidate);
            if (!candidate.ok) throw candidate.error;
            const bindGroup = device.createBindGroup({
              layout: candidateLayout,
              entries: [
                { binding: 0, resource: { kind: 'buffer', value: { buffer: candidate.value } } },
              ],
            });
            if (!bindGroup.ok) throw bindGroup.error;
            return { layout: candidateLayout, bindGroup: bindGroup.value };
          },
        },
  );
}
