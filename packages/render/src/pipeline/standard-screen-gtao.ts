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
import { type DeferredAoNormalLayout, getSsaoParameters, resolveSsaoQuality } from '../ssao-config';
import { buildSsaoUniformPayload, SSAO_UNIFORM_BYTES } from '../ssao-uniform';
import { type GtaoHistoryGraphInput, importGtaoHistory } from './gtao-history';
import {
  resolveStandardGtaoExecution,
  type StandardPipelineBuildContext,
} from './standard-build-context';
import { addAoDepthInputs, addScreenAoRaster, reducedExtent } from './standard-screen-ssao';

interface StandardGtaoInput {
  readonly size: DepthPyramidExtent;
  readonly depth: RenderPipelineTarget;
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
  const resolved = getSsaoParameters(config);
  const options = resolved.gtao;
  const { permutation } = resolveSsaoQuality(config);
  const size = reducedExtent(input.size, Number(options.downsample));
  const depthInputs = addAoDepthInputs(context, topology, input.depth, input.size, 'gtao');
  if (!depthInputs.ok) return depthInputs;
  const { depth, hierarchy } = depthInputs.value;
  const hzb = hierarchy.pyramid;
  const history = options.temporalFilter
    ? importGtaoHistory(
        context,
        size,
        JSON.stringify([
          options,
          resolved.intensity,
          resolved.power,
          resolved.fadeDistance,
          resolved.fadeRadius,
          permutation,
          input.normalLayout,
        ]),
      )
    : ok(undefined);
  if (!history.ok) return history;
  const acceptedHistory = history.value;
  const buffer = graph.createBuffer('gtao-parameters', { size: SSAO_UNIFORM_BYTES });
  if (!buffer.ok) return buffer;
  const historyBuffer =
    acceptedHistory === undefined
      ? ok(undefined)
      : graph.createBuffer('gtao-reprojection-parameters', { size: SSAO_UNIFORM_BYTES });
  if (!historyBuffer.ok) return historyBuffer;
  const reproject = historyBuffer.value;
  const populated = graph.addCopyPass('gtao-parameters', {
    accesses: [
      { resource: buffer.value, usage: 'copy-dst' },
      ...(reproject === undefined ? [] : [{ resource: reproject, usage: 'copy-dst' as const }]),
    ],
    encodeDirect: (_encoder, frame, resources) => {
      const internal = frame as _InternalRenderPipelineContext;
      const { camera, runtime } = internal;
      const history = acceptedHistory?.resolve(internal);
      const phase = history?.frameIndex ?? 0;
      const angles = [60, 300, 180, 240, 120, 0] as const;
      const offsets = [0.1, 0.6, 0.35, 0.85] as const;
      const stepCounts = [4, 6, 8, 12, 20] as const;
      const values = buildSsaoUniformPayload(camera, config);
      values.set(
        [resolved.intensity, resolved.power, resolved.fadeDistance, resolved.fadeRadius],
        48,
      );
      values.set(
        [
          options.falloffEnd,
          Math.min(0.99, 1 - options.thicknessBlend ** 2),
          stepCounts[permutation] ?? 8,
          Math.max(0, 2 - permutation),
        ],
        52,
      );
      // GTAO uses mip.x to select the raw representation consumed by the optional spatial pass.
      values[56] = Number(options.spatialFilter);
      values.set(
        [
          ((angles[phase % 6] ?? 0) * Math.PI) / 360,
          (offsets[Math.floor(phase / 6) % 4] ?? 0.1) * 0.25,
          options.numAngles,
          options.filterWidth,
        ],
        60,
      );
      const queue = runtime.device.queue;
      queue.writeBuffer(resources.buffer(buffer.value).unwrap(), 0, values).unwrap();
      if (history !== undefined && reproject !== undefined) {
        const projection = values.subarray(16, 32);
        const view = values.subarray(0, 16);
        const current = mat4.multiply(mat4.create(), projection, view);
        // This is promoted only if the temporal pass encoded and the view submitted.
        const jitter = camera.temporal?.currentJitterUv ?? ([0, 0] as const);
        history.pending = { matrix: current, jitter };
        if (history.accepted !== undefined)
          values.set(mat4.multiply(mat4.create(), history.accepted.matrix, camera.world), 0);
        const previousJitter = history.accepted?.jitter;
        values.set(
          [
            Number(history.accepted !== undefined),
            options.temporalBlendWeight,
            (jitter?.[0] ?? 0) - (previousJitter?.[0] ?? 0),
            (jitter?.[1] ?? 0) - (previousJitter?.[1] ?? 0),
          ],
          60,
        );
        queue.writeBuffer(resources.buffer(reproject).unwrap(), 0, values).unwrap();
      }
    },
  });
  if (!populated.ok) return populated;
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
          buffer.value,
          depth,
          hzb,
          options.useNormals ? { target: input.normal, layout: input.normalLayout } : undefined,
        )
      : addScreenAoRaster(
          context,
          'gtao-calc',
          options.useNormals ? 'gtao-normal' : 'gtao-depth',
          size,
          buffer.value,
          { 4: input.normal.view, 5: depth, 16: hzb },
          options.useNormals ? input.normalLayout : undefined,
        );
  if (!raw.ok) return raw;
  const current = options.spatialFilter
    ? addScreenAoRaster(context, 'gtao-spatial', 'gtao-spatial', size, buffer.value, {
        5: depth,
        18: raw.value.view,
      })
    : raw;
  if (!current.ok) return current;
  return resolveGtao(context, input, {
    size,
    depth,
    current: current.value,
    parameters: buffer.value,
    acceptedHistory,
    reproject,
  });
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
        { binding: 14, resource: { kind: 'buffer', value: { buffer, size: SSAO_UNIFORM_BYTES } } },
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
