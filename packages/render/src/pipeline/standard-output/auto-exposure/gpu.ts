import type {
  GraphBuffer,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import {
  type BindGroupLayout,
  type Buffer,
  type ComputePipeline,
  type RhiDevice,
  RhiError,
} from '@forgeax/engine-rhi';
import { AUTO_EXPOSURE_METER_WGSL } from '@forgeax/engine-shader';
import { err, ok, type Result } from '@forgeax/engine-types';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../../../gpu-usage';
import type { _InternalRenderPipelineContext } from '../../../record/render-context';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../../../render-pipeline';
import { addStandardColorStagePass } from '../color-transform';
import {
  AUTO_EXPOSURE_FUSED_GRAPH_PASS,
  AUTO_EXPOSURE_HISTOGRAM_DISPATCH,
  resolveAutoExposureShaderModuleFactory,
} from './graph';
import { autoExposureCapabilityFailure } from './inspection';
import { createWhiteBalanceMatrixWriter } from './oracle';
import { addAutoExposureFragmentPasses } from './raster';

export const AUTO_EXPOSURE_HISTOGRAM_BYTES = 1024;
const AUTO_EXPOSURE_STATE_BYTES = 32;
const AUTO_EXPOSURE_CANDIDATE_BYTES = 32;
/** Camera/time inputs consumed by adapt; this is not a CPU exposure estimate. */
export const AUTO_EXPOSURE_PARAMETERS_BYTES = 48;

interface AutoExposureGpuParameters {
  readonly compensationEv: number;
  readonly rangeMinEv: number;
  readonly rangeMaxEv: number;
  readonly upRate: number;
  readonly downRate: number;
  readonly deltaTime: number;
  readonly fallback: number;
  readonly generation: number;
  readonly historyIdentity?: string;
  readonly adaptation?: 'ue-eye-adaptation';
}

export interface AutoExposureGpuResources {
  readonly execution: 'compute' | 'fragment';
  readonly history: AutoExposureGpuHistory;
  readonly histogram: Buffer;
  state: Buffer;
  candidate: Buffer;
  readonly parameters: Buffer;
  readonly device: RhiDevice;
  readonly generation: number;
}

export interface AutoExposureGraphResources {
  readonly execution?: 'compute' | 'fragment';
  readonly histogram: GraphBuffer;
  readonly state: GraphBuffer;
  readonly candidate: GraphBuffer;
  readonly parameters: GraphBuffer;
}

export interface AutoExposureGraphProjection {
  readonly source: RenderPipelineTarget;
  readonly halfResolution?: boolean;
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
  execution: 'compute' | 'fragment' = device.caps.compute && device.caps.storageBuffer
    ? 'compute'
    : 'fragment',
): Result<AutoExposureGpuResources, unknown> {
  const unavailable = autoExposureCapabilityFailure(device.caps, generation);
  const bufferUsage = execution === 'compute' ? GPU_BUFFER_USAGE_STORAGE : GPU_BUFFER_USAGE_UNIFORM;
  if (unavailable !== undefined) return err(unavailable);
  const histogram = createBuffer(
    device,
    'standard-auto-exposure-histogram',
    AUTO_EXPOSURE_HISTOGRAM_BYTES,
    bufferUsage | GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
  );
  if (!histogram.ok) return histogram;
  const state = createBuffer(
    device,
    'standard-auto-exposure-state',
    AUTO_EXPOSURE_STATE_BYTES,
    bufferUsage | GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
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
    bufferUsage | GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
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
    bufferUsage | GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
  );
  if (!parameters.ok) {
    device.destroyBuffer(histogram.value);
    device.destroyBuffer(state.value);
    device.destroyBuffer(candidate.value);
    return parameters;
  }
  return ok({
    execution,
    history: {
      submittedSerial: 0,
      completedSerial: 0,
      retired: false,
    },
    histogram: histogram.value,
    state: state.value,
    candidate: candidate.value,
    parameters: parameters.value,
    device,
    generation,
  });
}

interface AutoExposureHistoryKey {
  readonly generation: number;
  readonly view: string | undefined;
  readonly ue: boolean;
  readonly fallback: number;
  readonly revision: number;
}

interface AutoExposureGpuHistory {
  submitted?: AutoExposureHistoryKey;
  pending?: AutoExposureHistoryKey | undefined;
  submittedSerial: number;
  completedSerial: number;
  retired: boolean;
  retiring?: boolean;
}

/** Stage the history key and upload authored camera/time inputs to the meter. */
export function writeAutoExposureParameters(
  resources: AutoExposureGpuResources,
  parameters: AutoExposureGpuParameters,
): Result<void, RhiError> {
  const { history } = resources;
  if (history.retired)
    return err(
      new RhiError({
        code: 'rhi-not-available',
        expected: 'an active auto-exposure device generation',
        hint: 'recover the renderer before submitting another frame',
      }),
    );

  const previous = history.submitted;
  const generation = parameters.generation;
  const view = parameters.historyIdentity;
  const ue = parameters.adaptation === 'ue-eye-adaptation';
  const fallback = parameters.fallback;
  const key =
    previous?.generation === generation &&
    previous.view === view &&
    previous.fallback === fallback &&
    previous.ue === ue
      ? previous
      : {
          generation,
          view,
          ue,
          fallback,
          revision: previous ? previous.revision + 1 : resources.generation,
        };
  const values = new Float32Array([
    parameters.compensationEv,
    parameters.rangeMinEv,
    parameters.rangeMaxEv,
    parameters.upRate,
    parameters.downRate,
    parameters.deltaTime,
    fallback,
    key.revision,
    Number(ue),
    0,
    0,
    0,
  ]);
  const written = resources.device.queue.writeBuffer(resources.parameters, 0, values);
  if (written.ok) history.pending = key;
  return written;
}

export function abortAutoExposureGpuFrame(resources: AutoExposureGpuResources): void {
  resources.history.pending = undefined;
}

/** Chain GPU history in queue submission order and publish the receipt on completion. */
export function submitAutoExposureGpuFrame(
  resources: AutoExposureGpuResources,
  completed: () => void,
): void {
  const { history } = resources;
  const key = history.pending;
  if (key === undefined) return;
  history.pending = undefined;
  history.submitted = key;
  const serial = ++history.submittedSerial;

  // Each submitted pass reads one slot and writes the other. Every frame uses
  // the same queue, so the next submission can read the candidate before the
  // CPU receives its completion notification.
  const previous = resources.state;
  resources.state = resources.candidate;
  resources.candidate = previous;

  void resources.device.queue.onSubmittedWorkDone().then(
    () => {
      if (
        !history.retired &&
        serial > history.completedSerial &&
        history.submitted?.revision === key.revision
      ) {
        history.completedSerial = serial;
        completed();
      }
    },
    () => {
      history.retired = true;
    },
  );
}

export function retireAutoExposureGpuResources(resources: AutoExposureGpuResources): void {
  const { history } = resources;
  if (history.retiring) return;
  history.retired = true;
  history.retiring = true;
  const release = () => {
    resources.device.destroyBuffer(resources.histogram);
    resources.device.destroyBuffer(resources.state);
    resources.device.destroyBuffer(resources.candidate);
    resources.device.destroyBuffer(resources.parameters);
  };
  void resources.device.queue.onSubmittedWorkDone().then(release, release);
}

/** Import persistent buffers into the current typed graph without exposing handles in topology. */
export function importAutoExposureGraphResources(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  execution: 'compute' | 'fragment' = 'compute',
): Result<AutoExposureGraphResources, RenderGraphError> {
  const usage =
    (execution === 'compute' ? GPU_BUFFER_USAGE_STORAGE : GPU_BUFFER_USAGE_UNIFORM) |
    GPU_BUFFER_USAGE_COPY_SRC |
    GPU_BUFFER_USAGE_COPY_DST;
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
      usage,
    },
    (frame) => resolve(frame).histogram,
  );
  if (!histogram.ok) return histogram;
  const state = graph.importBuffer(
    'standard-auto-exposure-state',
    {
      size: AUTO_EXPOSURE_STATE_BYTES,
      usage: usage | GPU_BUFFER_USAGE_UNIFORM,
    },
    (frame) => resolve(frame).state,
  );
  if (!state.ok) return state;
  const candidate = graph.importBuffer(
    'standard-auto-exposure-candidate',
    {
      size: AUTO_EXPOSURE_CANDIDATE_BYTES,
      usage: usage | GPU_BUFFER_USAGE_UNIFORM,
    },
    (frame) => resolve(frame).candidate,
  );
  if (!candidate.ok) return candidate;
  const parameters = graph.importBuffer(
    'standard-auto-exposure-parameters',
    {
      size: AUTO_EXPOSURE_PARAMETERS_BYTES,
      usage,
    },
    (frame) => resolve(frame).parameters,
  );
  if (!parameters.ok) return parameters;
  return ok({
    execution,
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

function createAutoExposureMeterState(
  frame: RenderPipelineFrame,
  halfResolution: boolean,
): AutoExposureMeterState {
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
        texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
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
  const histogram = halfResolution ? 'auto_exposure_histogram_half' : 'auto_exposure_histogram';
  return {
    layout: layout.value,
    clearPipeline: createPipeline('auto_exposure_clear', 'auto_exposure_clear'),
    histogramPipeline: createPipeline(histogram, histogram),
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
  if (projection.resources.execution === 'fragment')
    return addAutoExposureFragmentPasses(context, projection);
  let meterState: AutoExposureMeterState | undefined;
  const meter = context.graph.addComputePass(AUTO_EXPOSURE_FUSED_GRAPH_PASS, {
    accesses: [
      { resource: projection.source.view, usage: 'sampled-read' },
      // The clear dispatch initializes the histogram before the histogram
      // dispatch reads/writes it. `storage-write` keeps graph validation from
      // requiring an external initializer while the binding remains read/write.
      { resource: projection.resources.histogram, usage: 'storage-write' },
      { resource: projection.resources.state, usage: 'storage-read' },
      { resource: projection.resources.candidate, usage: 'storage-write' },
      { resource: projection.resources.parameters, usage: 'storage-read' },
    ],
    encodeDirect: (pass, frame, resources) => {
      meterState ??= createAutoExposureMeterState(frame, projection.halfResolution === true);
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

interface AutoExposureWhiteBalance {
  readonly temperature: number;
  readonly tint: number;
}

/** Both execution paths consume the current view's linear HDR color matrix. */
export function createAutoExposureApplyWgsl(
  hasCandidate = true,
  execution: 'compute' | 'fragment' = 'compute',
  hasGlare = false,
): string {
  const candidateBinding = hasCandidate
    ? execution === 'fragment'
      ? '@group(1) @binding(0) var<uniform> candidate: vec4<f32>;'
      : '@group(1) @binding(0) var<storage, read> candidate: array<vec4<f32>>;'
    : '';
  const candidateValue = hasCandidate
    ? execution === 'fragment'
      ? 'max(candidate.x, 0.0)'
      : 'max(candidate[0].x, 0.0)'
    : '1.0';
  return /* wgsl */ `
${candidateBinding}
${hasGlare ? '@group(0) @binding(3) var glare: texture_2d<f32>;' : ''}

@group(0) @binding(2) var<uniform> whiteBalance: array<vec4<f32>, 3>;

@fragment fn color_stage_fs(input: VertexOutput) -> @location(0) vec4<f32> {
  let color = textureSampleLevel(source, sourceSampler, input.uv, 0.0);
  let radiance = ${
    hasGlare
      ? 'min(color.rgb + textureSampleLevel(glare, sourceSampler, input.uv, 0.0).rgb, vec3<f32>(65504.0))'
      : 'color.rgb'
  };
  let exposed = radiance * ${candidateValue};
  return vec4<f32>(vec3<f32>(dot(whiteBalance[0].xyz, exposed), dot(whiteBalance[1].xyz, exposed), dot(whiteBalance[2].xyz, exposed)), color.a);
}`;
}

/** Consume the same-frame adaptation candidate in the linear HDR domain. */
export function addAutoExposureExposurePass(
  context: import('../../../render-pipeline').RenderPipelineBuildContext<RenderPipelineFrame>,
  input: RenderPipelineTarget,
  output: RenderPipelineTarget,
  resources: AutoExposureGraphResources | undefined,
  whiteBalance: AutoExposureWhiteBalance = { temperature: 6504, tint: 0 },
  glare?: RenderPipelineTarget,
): Result<void, RenderGraphError> {
  const writeMatrix = createWhiteBalanceMatrixWriter();
  let candidateLayout: BindGroupLayout | undefined;
  return addStandardColorStagePass(
    context.graph,
    'standard-exposure-white-balance',
    input,
    output,
    createAutoExposureApplyWgsl(resources !== undefined, resources?.execution, glare !== undefined),
    12,
    (values, frame) => {
      const output = frame.camera?.output ?? whiteBalance;
      writeMatrix(values, 0, output.temperature, output.tint);
    },
    resources === undefined
      ? undefined
      : {
          accesses: [
            {
              resource: resources.candidate,
              usage: resources.execution === 'fragment' ? 'uniform-read' : 'storage-read',
            },
          ],
          bind: (device, graphResources) => {
            if (candidateLayout === undefined) {
              const created = device.createBindGroupLayout({
                label: 'standard-exposure-white-balance.candidate.bgl',
                entries: [
                  {
                    binding: 0,
                    visibility: 2,
                    buffer: {
                      type: resources.execution === 'fragment' ? 'uniform' : 'read-only-storage',
                    },
                  },
                ],
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
    glare,
  );
}
