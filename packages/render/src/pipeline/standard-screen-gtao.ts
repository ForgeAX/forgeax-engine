import { mat4 } from '@forgeax/engine-math';
import {
  type GraphBuffer,
  type GraphTextureView,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type { BindGroupEntry } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import type { DepthPyramidExtent } from '../depth-pyramid/plan';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_STORAGE_BINDING,
} from '../gpu-texture-usage';
import { getOrCreateFromChain } from '../record/mesh-ssbo';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import {
  createRenderPipelineTarget,
  type RenderPipelineTarget,
  type RenderPipelineTopology,
} from '../render-pipeline';
import {
  type AmbientOcclusionSettings,
  AO_APPEARANCE_DEFAULTS,
  type DeferredAoNormalLayout,
  GTAO_DEFAULTS,
  ssaoQualityPermutation,
} from '../ssao-config';
import { SCREEN_AO_UNIFORM_BYTES, ScreenAoUniformPage } from '../ssao-uniform';
import { type GtaoHistoryGraphInput, importGtaoHistory } from './gtao-history';
import {
  resolveStandardGtaoExecution,
  type StandardPipelineBuildContext,
} from './standard-build-context';
import { addAoDepthInputs, addScreenAoRaster, reducedExtent } from './standard-screen-ssao';
import type { ReadViewHzb } from './standard-view-hzb';

const GTAO_ANGLE_OFFSETS = [60, 300, 180, 240, 120, 0].map((angle) => (angle * Math.PI) / 360);
const GTAO_TEXEL_OFFSETS = [0.1, 0.6, 0.35, 0.85].map((offset) => offset * 0.25);
const GTAO_STEP_COUNTS = [4, 6, 8, 12, 20] as const;

interface StandardGtaoInput {
  readonly size: DepthPyramidExtent;
  readonly depth: RenderPipelineTarget;
  readonly hzb?: ReadViewHzb | undefined;
  readonly normal: RenderPipelineTarget;
  readonly normalLayout: DeferredAoNormalLayout;
  readonly velocity?: RenderPipelineTarget | undefined;
}

export function addStandardScreenGtao(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  input: StandardGtaoInput,
): Result<RenderPipelineTarget, RenderGraphError> {
  const { graph } = context;
  const config = topology.config?.ambientOcclusion;
  const options = config?.gtao;
  const size = reducedExtent(input.size, Number(options?.downsample ?? GTAO_DEFAULTS.downsample));
  const depthInputs = addAoDepthInputs(context, topology, input.depth, input.size, input.hzb);
  if (!depthInputs.ok) return depthInputs;
  const { depth, hierarchy } = depthInputs.value;
  const hzb = hierarchy.pyramid;
  const history =
    (options?.temporalFilter ?? GTAO_DEFAULTS.temporalFilter)
      ? importGtaoHistory(context, size)
      : ok(undefined);
  if (!history.ok) return history;
  const acceptedHistory = history.value;
  const buffers = addGtaoParameters(graph, config, input.size, acceptedHistory);
  if (!buffers.ok) return buffers;
  const { parameters, reproject } = buffers.value;
  const execution = resolveStandardGtaoExecution(
    'gtao',
    topology.lane.compute && topology.lane.storageTexture !== false,
    context.gtaoExecutionOverride,
  );
  if (!execution.ok) return execution;
  const raw =
    execution.value === 'compute'
      ? addGtaoCompute(
          context,
          size,
          parameters,
          depth,
          hzb,
          options?.useNormals ? { target: input.normal, layout: input.normalLayout } : undefined,
        )
      : addScreenAoRaster(
          context,
          'gtao-calc',
          options?.useNormals ? 'gtao-normal' : 'gtao-depth',
          size,
          parameters,
          { 4: input.normal.view, 5: depth, 16: hzb },
          options?.useNormals ? input.normalLayout : undefined,
        );
  if (!raw.ok) return raw;
  const current =
    (options?.spatialFilter ?? GTAO_DEFAULTS.spatialFilter)
      ? addScreenAoRaster(context, 'gtao-spatial', 'gtao-spatial', size, parameters, {
          5: depth,
          18: raw.value.view,
        })
      : raw;
  if (!current.ok) return current;
  return resolveGtao(context, input, {
    size,
    depth,
    current: current.value,
    parameters,
    acceptedHistory,
    reproject,
  });
}

function addGtaoParameters(
  graph: StandardPipelineBuildContext['graph'],
  config: AmbientOcclusionSettings | undefined,
  size: DepthPyramidExtent,
  acceptedHistory: GtaoHistoryGraphInput | undefined,
): Result<
  { readonly parameters: GraphBuffer; readonly reproject: GraphBuffer | undefined },
  RenderGraphError
> {
  const buffer = graph.createBuffer('gtao-parameters', { size: SCREEN_AO_UNIFORM_BYTES });
  if (!buffer.ok) return buffer;
  const historyBuffer =
    acceptedHistory === undefined
      ? ok(undefined)
      : graph.createBuffer('gtao-reprojection-parameters', { size: SCREEN_AO_UNIFORM_BYTES });
  if (!historyBuffer.ok) return historyBuffer;
  const reproject = historyBuffer.value;
  const uniforms = new ScreenAoUniformPage();
  const populated = graph.addCopyPass('gtao-parameters', {
    accesses: [
      { resource: buffer.value, usage: 'copy-dst' },
      ...(reproject === undefined ? [] : [{ resource: reproject, usage: 'copy-dst' as const }]),
    ],
    encodeDirect: (_encoder, frame, resources) => {
      const internal = frame as _InternalRenderPipelineContext;
      const { camera, runtime } = internal;
      const history = acceptedHistory?.resolve(internal);
      const settings = internal.frameState.installedPipelineConfig?.ambientOcclusion ?? config;
      const previous = history?.prepare(camera, settings);
      const phase = previous === undefined ? 0 : (history?.frameIndex ?? 0);
      uniforms.writeCamera(camera, size);
      const values = uniforms.data;
      writeGtaoRawParameters(values, settings, phase);
      const queue = runtime.device.queue;
      queue.writeBuffer(resources.buffer(buffer.value).unwrap(), 0, values).unwrap();
      if (history !== undefined && reproject !== undefined) {
        mat4.multiply(history.pending.matrix, uniforms.projection, uniforms.view);
        const pendingJitter = history.pending.jitter;
        if (previous !== undefined) mat4.multiply(uniforms.view, previous.matrix, camera.world);
        values[60] = Number(previous !== undefined);
        values[61] = settings?.gtao?.temporalBlendWeight ?? GTAO_DEFAULTS.temporalBlendWeight;
        values[62] = pendingJitter[0] - (previous?.jitter[0] ?? 0);
        values[63] = pendingJitter[1] - (previous?.jitter[1] ?? 0);
        queue.writeBuffer(resources.buffer(reproject).unwrap(), 0, values).unwrap();
      }
    },
  });
  return populated.ok ? ok({ parameters: buffer.value, reproject }) : populated;
}

function writeGtaoRawParameters(
  values: Float32Array,
  settings: AmbientOcclusionSettings | undefined,
  phase: number,
): void {
  const gtao = settings?.gtao ?? GTAO_DEFAULTS;
  const permutation = ssaoQualityPermutation(settings);
  values[48] = settings?.intensity ?? AO_APPEARANCE_DEFAULTS.intensity;
  values[49] = settings?.power ?? AO_APPEARANCE_DEFAULTS.power;
  values[50] = settings?.fadeDistance ?? AO_APPEARANCE_DEFAULTS.fadeDistance;
  values[51] = settings?.fadeRadius ?? AO_APPEARANCE_DEFAULTS.fadeRadius;
  values[52] = gtao.falloffEnd ?? GTAO_DEFAULTS.falloffEnd;
  values[53] = Math.min(0.99, 1 - (gtao.thicknessBlend ?? GTAO_DEFAULTS.thicknessBlend) ** 2);
  values[54] = GTAO_STEP_COUNTS[permutation] ?? 8;
  values[55] = Math.max(0, 2 - permutation);
  // mip.x selects the raw representation consumed by the optional spatial pass.
  values[56] = Number(gtao.spatialFilter ?? GTAO_DEFAULTS.spatialFilter);
  values[60] = GTAO_ANGLE_OFFSETS[phase % 6] ?? 0;
  values[61] = GTAO_TEXEL_OFFSETS[Math.floor(phase / 6) % 4] ?? 0.025;
  values[62] = gtao.numAngles ?? GTAO_DEFAULTS.numAngles;
  values[63] = gtao.filterWidth ?? GTAO_DEFAULTS.filterWidth;
}

function resolveGtao(
  context: StandardPipelineBuildContext,
  input: StandardGtaoInput,
  work: {
    readonly size: DepthPyramidExtent;
    readonly depth: GraphTextureView;
    readonly current: RenderPipelineTarget;
    readonly parameters: GraphBuffer;
    readonly acceptedHistory: GtaoHistoryGraphInput | undefined;
    readonly reproject: GraphBuffer | undefined;
  },
): Result<RenderPipelineTarget, RenderGraphError> {
  const { size, depth, acceptedHistory, reproject } = work;
  let filtered = work.current;
  if (acceptedHistory !== undefined && reproject !== undefined) {
    const velocity = input.velocity;
    const stage =
      velocity === undefined
        ? 'gtao-temporal'
        : velocity.format === 'r32uint'
          ? 'gtao-temporal-velocity'
          : 'gtao-temporal-scene-data';
    const temporal = addScreenAoRaster(
      context,
      'gtao-temporal',
      stage,
      size,
      reproject,
      {
        5: depth,
        18: work.current.view,
        19: acceptedHistory.previous,
        20: velocity?.view,
        21: velocity?.view,
      },
      undefined,
      acceptedHistory.output,
      (frame) => {
        acceptedHistory.resolve(frame).used = true;
      },
    );
    if (!temporal.ok) return temporal;
    filtered = temporal.value;
  }
  return addScreenAoRaster(context, 'gtao-resolve', 'gtao-resolve', input.size, work.parameters, {
    18: filtered.view,
  });
}

function addGtaoCompute(
  { graph }: StandardPipelineBuildContext,
  size: DepthPyramidExtent,
  parameters: GraphBuffer,
  depth: GraphTextureView,
  hzb: GraphTextureView,
  normal?: { readonly target: RenderPipelineTarget; readonly layout: DeferredAoNormalLayout },
): Result<RenderPipelineTarget, RenderGraphError> {
  const output = createRenderPipelineTarget(graph, 'gtao-calc', {
    format: 'rgba8unorm',
    size,
    usage: GPU_TEXTURE_USAGE_COPY_SRC | GPU_TEXTURE_USAGE_STORAGE_BINDING,
  });
  if (!output.ok) return output;
  const inputs = [
    { binding: 5, view: depth },
    { binding: 16, view: hzb },
    ...(normal === undefined ? [] : [{ binding: 4, view: normal.target.view }]),
  ];
  const pass = graph.addComputePass('gtao-calc-compute', {
    accesses: [
      { resource: parameters, usage: 'uniform-read' },
      ...inputs.map(({ view }) => ({ resource: view, usage: 'sampled-read' as const })),
      { resource: output.value.view, usage: 'storage-write' },
    ],
    encodeDirect: (encoder, frame, resources) => {
      const internal = frame as _InternalRenderPipelineContext;
      const program = internal.pipelineState.perPassResources.gtaoScreenComputePipeline?.(
        normal?.layout,
      );
      if (program === undefined)
        throw new RenderGraphError({
          code: 'resource-resolution-failed',
          expected: 'native GTAO compute program for the active depth and normal layout',
          hint: 'include the Engine AO shader for this device generation',
        });
      const buffer = resources.buffer(parameters).unwrap();
      const views = [...inputs, { binding: 22, view: output.value.view }].map(
        ({ binding, view }) => ({
          binding,
          value: resources.textureView(view).unwrap(),
        }),
      );
      const entries: BindGroupEntry[] = [
        {
          binding: 14,
          resource: { kind: 'buffer', value: { buffer, size: SCREEN_AO_UNIFORM_BYTES } },
        },
        ...views.map(({ binding, value }) => ({
          binding,
          resource: { kind: 'textureView' as const, value },
        })),
      ];
      const group = getOrCreateFromChain(
        internal.frameState.postProcessBgCache,
        [buffer, ...views.map(({ value }) => value)],
        'gtao-calc-compute',
        () =>
          internal.runtime.device
            .createBindGroup({ label: 'gtao-calc-compute', layout: program.layout, entries })
            .unwrap(),
        internal.bindGroupCounts,
      );
      encoder.setPipeline(program.pipeline);
      encoder.setBindGroup(0, group);
      encoder.dispatchWorkgroups(Math.ceil(size.width / 8), Math.ceil(size.height / 8), 1);
    },
  });
  return pass.ok ? ok(output.value) : pass;
}
