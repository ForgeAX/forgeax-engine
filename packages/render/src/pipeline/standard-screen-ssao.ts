import {
  type GraphBuffer,
  RenderGraphError as GraphFailure,
  type GraphTextureView,
  type RenderGraphError,
} from '@forgeax/engine-render-graph';
import type { BindGroupEntry } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import type { DepthPyramidExtent } from '../depth-pyramid/plan';
import { GPU_TEXTURE_USAGE_COPY_SRC } from '../gpu-texture-usage';
import { getOrCreateFromChain } from '../record/mesh-ssbo';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import {
  createRenderPipelineTarget,
  type RenderPipelineTarget,
  type RenderPipelineTopology,
} from '../render-pipeline';
import { type DeferredAoNormalLayout, getSsaoParameters, resolveSsaoQuality } from '../ssao-config';
import {
  SSAO_SCREEN_PROGRAMS,
  type SsaoScreenBinding,
  type SsaoScreenStage,
} from '../ssao-screen-program';
import { buildScreenAoUniformPayload, SCREEN_AO_UNIFORM_BYTES } from '../ssao-uniform';
import type { StandardPipelineBuildContext } from './standard-build-context';
import { type ReadViewHzb, standardAoHzbLevels, viewHzb } from './standard-view-hzb';

interface ScreenAoInput {
  readonly depth: RenderPipelineTarget;
  readonly hzb?: ReadViewHzb | undefined;
  readonly size: DepthPyramidExtent;
  readonly normal?: RenderPipelineTarget | undefined;
  readonly normalLayout?: DeferredAoNormalLayout | undefined;
}

type ScreenAoViews = Partial<Record<Exclude<SsaoScreenBinding, 14>, GraphTextureView | undefined>>;

export function reducedExtent(size: DepthPyramidExtent, level: number): DepthPyramidExtent {
  const scale = 2 ** level;
  return { width: Math.ceil(size.width / scale), height: Math.ceil(size.height / scale) };
}

export function addScreenAoRaster(
  { graph }: StandardPipelineBuildContext,
  name: string,
  stage: SsaoScreenStage,
  size: DepthPyramidExtent,
  buffer: GraphBuffer,
  views: ScreenAoViews,
  layout?: DeferredAoNormalLayout,
  target?: RenderPipelineTarget,
  onEncoded?: (frame: _InternalRenderPipelineContext) => void,
): Result<RenderPipelineTarget, RenderGraphError> {
  const spec = SSAO_SCREEN_PROGRAMS[stage];
  const output =
    target === undefined
      ? createRenderPipelineTarget(graph, name, {
          format: spec.format,
          size,
          usage: GPU_TEXTURE_USAGE_COPY_SRC,
        })
      : ok(target);
  if (!output.ok) return output;
  const usesUniform = spec.bindings.some((binding) => binding === 14);
  const bindings = spec.bindings.flatMap((binding) => {
    if (binding === 14) return [];
    const view = views[binding];
    if (view === undefined) throw new Error(`SSAO ${stage} needs texture binding ${binding}`);
    return [{ binding, view }];
  });
  const pass = graph.addRasterPass(name, {
    accesses: [
      ...(usesUniform ? [{ resource: buffer, usage: 'uniform-read' as const }] : []),
      ...bindings.map(({ view }) => ({ resource: view, usage: 'sampled-read' as const })),
      { resource: output.value.view, usage: 'color-attachment' },
    ],
    colorAttachments: [
      {
        view: output.value.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 1, g: 1, b: 1, a: 1 },
      },
    ],
    encodeDirect: (encoder, frame, resources) => {
      const internal = frame as _InternalRenderPipelineContext;
      const program = internal.pipelineState.perPassResources.ssaoScreenPipeline?.(stage, layout);
      if (program === undefined)
        throw new GraphFailure({
          code: 'resource-resolution-failed',
          expected: `the native Standard SSAO ${stage} program`,
          hint: 'include the Engine SSAO shader in the active device generation',
        });
      const uniform = usesUniform ? resources.buffer(buffer).unwrap() : undefined;
      const entries: BindGroupEntry[] =
        uniform === undefined
          ? []
          : [
              {
                binding: 14,
                resource: {
                  kind: 'buffer',
                  value: { buffer: uniform, size: SCREEN_AO_UNIFORM_BYTES },
                },
              },
            ];
      const textureViews = bindings.map(({ binding, view }) => ({
        binding,
        value: resources.textureView(view).unwrap(),
      }));
      for (const { binding, value } of textureViews)
        entries.push({ binding, resource: { kind: 'textureView', value } });
      const bind = getOrCreateFromChain(
        internal.frameState.postProcessBgCache,
        [...(uniform === undefined ? [] : [uniform]), ...textureViews.map(({ value }) => value)],
        name,
        () =>
          internal.runtime.device
            .createBindGroup({ label: name, layout: program.layout, entries })
            .unwrap(),
        internal.bindGroupCounts,
      );
      encoder.setPipeline(program.pipeline);
      encoder.setBindGroup(0, bind);
      encoder.draw(3, 1, 0, 0);
      onEncoded?.(internal);
    },
  });
  return pass.ok ? ok(output.value) : pass;
}

export function addAoDepthInputs(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  depth: RenderPipelineTarget,
  size: DepthPyramidExtent,
  hzb?: ReadViewHzb,
) {
  const depthView = context.graph.view(depth.texture, { dimension: '2d', aspect: 'depth-only' });
  if (!depthView.ok) return depthView;
  const hierarchy = (
    hzb ?? viewHzb(context, topology, depthView.value, size, standardAoHzbLevels(topology))
  )();
  if (!hierarchy.ok) return hierarchy;
  return ok({ depth: depthView.value, hierarchy: hierarchy.value });
}

export function addScreenSsaoParameters(
  { graph }: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  size: DepthPyramidExtent,
  level: number,
): Result<GraphBuffer, RenderGraphError> {
  const config = topology.config?.ambientOcclusion;
  const { permutation } = resolveSsaoQuality(config);
  const label = `ssao-screen-parameters-${level}`;
  const buffer = graph.createBuffer(label, { size: SCREEN_AO_UNIFORM_BYTES });
  if (!buffer.ok) return buffer;
  const populated = graph.addCopyPass(label, {
    accesses: [{ resource: buffer.value, usage: 'copy-dst' }],
    encodeDirect: (_encoder, frame, resources) => {
      const internal = frame as _InternalRenderPipelineContext;
      const active = internal.frameState.installedPipelineConfig?.ambientOcclusion ?? config;
      const resolved = getSsaoParameters(active);
      const values = buildScreenAoUniformPayload(internal.camera, active, size);
      values.set(
        [
          resolved.intensity,
          resolved.power,
          resolved.fadeDistance,
          resolved.fadeRadius,
          resolved.radius,
          Number(resolved.radiusInWorldSpace),
          resolved.bias / 1000,
          permutation,
          resolved.mipBlend,
          resolved.mipScale,
          resolved.mipThreshold,
          level,
        ],
        48,
      );
      const phase = (internal.camera.temporal?.temporalFrameIndex ?? 0) % 8;
      values.set(
        [phase * 2.48, phase * 7.52, reducedExtent(size, level).width / size.width, 0],
        60,
      );
      internal.runtime.device.queue
        .writeBuffer(resources.buffer(buffer.value).unwrap(), 0, values)
        .unwrap();
    },
  });
  return populated.ok ? buffer : populated;
}

export function addStandardScreenSsao(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  input: ScreenAoInput,
): Result<RenderPipelineTarget, RenderGraphError> {
  const { depth, size, normal, normalLayout } = input;
  const { levels } = resolveSsaoQuality(topology.config?.ambientOcclusion);
  const levelCount = normal === undefined ? 1 : Math.max(1, levels);
  const depthInputs = addAoDepthInputs(context, topology, depth, size, input.hzb);
  if (!depthInputs.ok) return depthInputs;
  const { depth: sampledDepth, hierarchy } = depthInputs.value;
  const hzb = hierarchy.levels[0] as GraphTextureView;
  const parameters: GraphBuffer[] = [];
  for (let level = 0; level < levelCount; level++) {
    const buffer = addScreenSsaoParameters(context, topology, size, level);
    if (!buffer.ok) return buffer;
    parameters.push(buffer.value);
  }
  const raster = (
    name: string,
    stage: SsaoScreenStage,
    level: number,
    views: ScreenAoViews,
    layout?: DeferredAoNormalLayout,
  ) =>
    addScreenAoRaster(
      context,
      name,
      stage,
      reducedExtent(size, level),
      parameters[level] as GraphBuffer,
      views,
      layout,
    );

  if (normal === undefined)
    return raster('ssao-calc', 'full-depth', 0, { 5: sampledDepth, 16: hzb });
  const full = { 4: normal.view, 5: sampledDepth, 16: hzb };
  if (levelCount === 1) return raster('ssao-calc', 'full-normal', 0, full, normalLayout);

  const halfSetup = raster('ssao-setup-half', 'setup', 1, full, normalLayout);
  if (!halfSetup.ok) return halfSetup;
  let halfInputs: ScreenAoViews = { 15: halfSetup.value.view, 16: hzb };
  if (levelCount === 3) {
    const quarterSetup = raster('ssao-setup-quarter', 'setup-coarse', 2, halfInputs);
    if (!quarterSetup.ok) return quarterSetup;
    const quarter = raster('ssao-quarter', 'coarse', 2, { 15: quarterSetup.value.view, 16: hzb });
    if (!quarter.ok) return quarter;
    halfInputs = { ...halfInputs, 17: quarterSetup.value.view, 18: quarter.value.view };
  }
  const half = raster('ssao-half', levelCount === 3 ? 'coarse-upsample' : 'coarse', 1, halfInputs);
  if (!half.ok) return half;
  return raster(
    'ssao-calc',
    'full-normal-upsample',
    0,
    {
      ...full,
      17: halfSetup.value.view,
      18: half.value.view,
    },
    normalLayout,
  );
}
