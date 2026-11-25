import type {
  GraphBuffer,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  BindGroupLayoutEntry,
  PipelineLayout,
  RenderPipeline,
  RhiDevice,
  RhiRenderPassEncoder,
  ShaderModule,
  TextureView,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { ok, type Result, shaderSourceDescriptor } from '@forgeax/engine-types';
import { DirectionalShadowFilterValue } from '../components/directional-shadow-filter';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';
import { isReflectedTransform } from '../material-render-state';
import { getOrCreateFromChain } from '../record/mesh-ssbo';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { SHADOW_CASTER_BUFFER_SIZE } from '../record/shadow-caster-uniforms';
import { SHADOW_PARAMS_BYTES, VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import {
  createRenderPipelineTarget,
  type RenderPipelineFrame,
  type RenderPipelineTarget,
} from '../render-pipeline';
import { SCREEN_AO_UNIFORM_BYTES } from '../ssao-uniform';
import { forwardPunctualShadowPlan } from './forward-punctual-shadow-plan';
import {
  currentForwardShadowReceiver,
  type ForwardShadowAdmission,
} from './forward-shadow-admission';
import { prepareForwardShadowBounds } from './forward-shadow-projection-bounds';
import {
  FORWARD_SHADOW_MATRIX_BYTES,
  prepareForwardShadowMatrices,
} from './forward-shadow-projection-matrices';
import { sceneViewImport } from './gpu-occlusion';

export const FORWARD_DIRECTIONAL_SHADOW_PASS = 'forward-directional-shadow';

interface ForwardShadowProjectionInput {
  readonly admission: Extract<ForwardShadowAdmission, { mode: 'screen' }>;
  readonly depth: RenderPipelineTarget;
  readonly ao?: RenderPipelineTarget | undefined;
  readonly inlineAo?: ForwardInlineSsao | undefined;
  readonly directional?: RenderPipelineTarget | undefined;
  readonly point?: RenderPipelineTarget | undefined;
  readonly spot?: RenderPipelineTarget | undefined;
  readonly lightData?: GraphBuffer | undefined;
  readonly sunSize: number;
  readonly spotSize: number;
}

export interface ForwardInlineSsao {
  readonly parameters: GraphBuffer;
  readonly hzb: GraphTextureView;
}

/** Dimensions and mask inputs belong to the installed Pass. Filtering and view fade
 * belong to the actual frame and may change on the same physical receiver. */
function recordingShadowAdmission(
  frame: _InternalRenderPipelineContext,
  installed: ForwardShadowProjectionInput['admission'],
) {
  const current = currentForwardShadowReceiver(frame.frameState);
  return current?.mode === 'screen' ? current : installed;
}

/** Project raw shadow tests once onto the opaque receiver depth. */
export function addForwardDirectionalShadow(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: ForwardShadowProjectionInput,
): Result<RenderPipelineTarget, RenderGraphError> {
  const { admission, lightData } = input;
  const ao = admission.ambientOcclusion ? input.ao : undefined;
  const inlineAo = admission.ambientOcclusion ? input.inlineAo : undefined;
  const neutral =
    input.directional === undefined &&
    !admission.contact &&
    lightData === undefined &&
    ao === undefined &&
    inlineAo === undefined;
  const output = createRenderPipelineTarget(graph, FORWARD_DIRECTIONAL_SHADOW_PASS, {
    format: admission.format,
    size: neutral ? { width: 1, height: 1 } : admission,
  });
  if (!output.ok) return output;
  if (neutral) return addNeutralProjectionMask(graph, output.value);
  return addShadowProjection(graph, input, output.value, ao, inlineAo);
}

function addShadowProjection(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: ForwardShadowProjectionInput,
  output: RenderPipelineTarget,
  ao: RenderPipelineTarget | undefined,
  inlineAo: ForwardInlineSsao | undefined,
): Result<RenderPipelineTarget, RenderGraphError> {
  const { admission, point, spot, lightData } = input;
  const drawFullscreen = admission.contact === true || inlineAo !== undefined || ao !== undefined;
  const depth = graph.view(input.depth.texture, { dimension: '2d', aspect: 'depth-only' });
  if (!depth.ok) return depth;
  const view = sceneViewImport(graph)();
  if (!view.ok) return view;
  const casterPolicy = graph.importBuffer(
    'forward-shadow-caster-policy',
    uniformDescriptor(SHADOW_CASTER_BUFFER_SIZE),
    (frame) => (frame as _InternalRenderPipelineContext).pipelineState.shadowCasterCascadeBuffer,
  );
  if (!casterPolicy.ok) return casterPolicy;
  const shadowParams =
    !admission.punctual?.point && admission.punctual?.spot !== 'uniform'
      ? undefined
      : graph.importBuffer(
          'forward-punctual-shadow-params',
          uniformDescriptor(SHADOW_PARAMS_BYTES),
          (frame) => (frame as _InternalRenderPipelineContext).pipelineState.shadowParamsBuffer,
        );
  if (shadowParams?.ok === false) return shadowParams;
  const matrixBuffer = graph.createBuffer('forward-screen-to-shadow-matrices', {
    size: FORWARD_SHADOW_MATRIX_BYTES,
  });
  if (!matrixBuffer.ok) return matrixBuffer;
  const matrices = prepareForwardShadowMatrices(admission, input.sunSize, input.spotSize);
  const bounds = prepareForwardShadowBounds();
  const upload = graph.addCopyPass('forward-shadow-prepare-matrices', {
    accesses: [{ resource: matrixBuffer.value, usage: 'copy-dst' }],
    encodeDirect: (_encoder, frame, resources) => {
      const internal = frame as _InternalRenderPipelineContext;
      const active = recordingShadowAdmission(internal, admission);
      const staging = matrices.update(internal, active);
      staging.set(
        [
          Number(input.directional !== undefined),
          Number(active.contact === true),
          (frame.camera.temporal?.temporalFrameIndex ?? 0) % 64,
          inlineAo !== undefined ? 1 : ao !== undefined ? 2 : 0,
        ],
        staging.length - 4,
      );
      frame.runtime.device.queue
        .writeBuffer(resources.buffer(matrixBuffer.value).unwrap(), 0, staging)
        .unwrap();
    },
  });
  if (!upload.ok) return upload;
  let program: ReturnType<typeof prepareForwardShadowProjection> | undefined;
  const added = graph.addRasterPass(FORWARD_DIRECTIONAL_SHADOW_PASS, {
    accesses: [
      { resource: view.value, usage: 'uniform-read' },
      { resource: matrixBuffer.value, usage: 'uniform-read' },
      { resource: casterPolicy.value, usage: 'uniform-read' },
      ...(inlineAo === undefined
        ? []
        : [
            { resource: inlineAo.parameters, usage: 'uniform-read' as const },
            { resource: inlineAo.hzb, usage: 'sampled-read' as const },
          ]),
      ...[input.directional, point, spot, ao].flatMap((target) =>
        target === undefined ? [] : [{ resource: target.view, usage: 'sampled-read' as const }],
      ),
      { resource: depth.value, usage: 'sampled-read' },
      { resource: input.depth.view, usage: 'depth-stencil-read' },
      ...(shadowParams === undefined
        ? []
        : [{ resource: shadowParams.value, usage: 'uniform-read' as const }]),
      ...(lightData === undefined ? [] : [{ resource: lightData, usage: 'storage-read' as const }]),
      { resource: output.view, usage: 'color-attachment' },
    ],
    colorAttachments: [
      {
        view: output.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 1, g: 1, b: 1, a: 1 },
      },
    ],
    depthStencilAttachment: {
      view: input.depth.view,
      depthReadOnly: true,
      ...(input.depth.format.includes('stencil') ? { stencilReadOnly: true } : {}),
    },
    encodeDirect: (pass, frame, resources) => {
      const internal = frame as _InternalRenderPipelineContext;
      program ??= prepareForwardShadowProjection(internal, input, drawFullscreen);
      const current = program;
      const device = frame.runtime.device;
      const viewBuffer = resources.buffer(view.value).unwrap();
      const casterBuffer = resources.buffer(casterPolicy.value).unwrap();
      const directional =
        input.directional === undefined
          ? internal.pipelineState.shadowArrayFallbackTextureView
          : resources.textureView(input.directional.view).unwrap();
      if (input.directional !== undefined)
        internal.frameState.frameOutputs.directionalShadowView = directional;
      const sceneDepth = resources.textureView(depth.value).unwrap();
      const pointDepth =
        point === undefined ? undefined : resources.textureView(point.view).unwrap();
      const spotDepth = spot === undefined ? undefined : resources.textureView(spot.view).unwrap();
      if (spotDepth !== undefined) internal.frameState.frameOutputs.spotShadowView = spotDepth;
      const params =
        shadowParams === undefined ? undefined : resources.buffer(shadowParams.value).unwrap();
      const rowBuffer = lightData === undefined ? undefined : resources.buffer(lightData).unwrap();
      const screenToShadow = resources.buffer(matrixBuffer.value).unwrap();
      const aoParameters =
        inlineAo === undefined ? screenToShadow : resources.buffer(inlineAo.parameters).unwrap();
      const aoTexture =
        inlineAo !== undefined
          ? resources.textureView(inlineAo.hzb).unwrap()
          : ao === undefined
            ? frame.pipelineState.defaultWhiteTextureView
            : resources.textureView(ao.view).unwrap();
      const viewGroup = getOrCreateFromChain(
        current.viewGroups,
        [
          viewBuffer,
          casterBuffer,
          directional,
          pointDepth,
          spotDepth,
          params,
          aoParameters,
          aoTexture,
        ].filter((resource) => resource !== undefined),
        'forward-shadow-projection-view',
        () =>
          device
            .createBindGroup({
              layout: current.view,
              entries: [
                {
                  binding: 0,
                  resource: {
                    kind: 'buffer',
                    value: { buffer: viewBuffer, size: VIEW_UNIFORM_BYTES },
                  },
                },
                { binding: 4, resource: { kind: 'sampler', value: current.sampler } },
                textureEntry(3, directional),
                {
                  binding: 7,
                  resource: {
                    kind: 'buffer',
                    value: { buffer: casterBuffer, size: SHADOW_CASTER_BUFFER_SIZE },
                  },
                },
                {
                  binding: 14,
                  resource: {
                    kind: 'buffer',
                    value: { buffer: aoParameters, size: SCREEN_AO_UNIFORM_BYTES },
                  },
                },
                textureEntry(16, aoTexture),
                ...(pointDepth === undefined ? [] : [textureEntry(5, pointDepth)]),
                ...(spotDepth === undefined ? [] : [textureEntry(8, spotDepth)]),
                ...(params === undefined
                  ? []
                  : [
                      {
                        binding: 6,
                        resource: { kind: 'buffer' as const, value: { buffer: params } },
                      },
                    ]),
              ],
            })
            .unwrap(),
        internal.bindGroupCounts,
      );
      const geometryGroup = getOrCreateFromChain(
        current.geometryGroups,
        rowBuffer === undefined
          ? [sceneDepth, screenToShadow]
          : [sceneDepth, screenToShadow, rowBuffer],
        'forward-shadow-projection-geometry',
        () =>
          device
            .createBindGroup({
              layout: current.geometry,
              entries: [
                textureEntry(0, sceneDepth),
                { binding: 1, resource: { kind: 'buffer', value: { buffer: screenToShadow } } },
                {
                  binding: 3,
                  resource: { kind: 'sampler', value: current.projectionDepthSampler },
                },
                ...(rowBuffer === undefined
                  ? []
                  : [
                      {
                        binding: 2,
                        resource: { kind: 'buffer' as const, value: { buffer: rowBuffer } },
                      },
                    ]),
              ],
            })
            .unwrap(),
        internal.bindGroupCounts,
      );
      pass.setBindGroup(0, viewGroup, [internal.viewBindGroupDynamicOffset ?? 0]);
      pass.setBindGroup(1, geometryGroup);
      if (current.directional !== undefined) {
        pass.setViewport(
          0,
          0,
          admission.width,
          admission.height,
          drawFullscreen ? 0 : matrices.farDepth(internal),
          1,
        );
        pass.setPipeline(current.directional);
        pass.draw(3);
      }
      if (rowBuffer !== undefined)
        recordPunctualShadows(
          pass,
          internal,
          current,
          recordingShadowAdmission(internal, admission),
          matrices,
          bounds,
        );
    },
  });
  return added.ok ? ok(output) : added;
}

function addNeutralProjectionMask(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  output: RenderPipelineTarget,
): Result<RenderPipelineTarget, RenderGraphError> {
  const pass = graph.addRasterPass(FORWARD_DIRECTIONAL_SHADOW_PASS, {
    accesses: [{ resource: output.view, usage: 'color-attachment' }],
    colorAttachments: [
      {
        view: output.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 1, g: 1, b: 1, a: 1 },
      },
    ],
    encodeDirect: () => {},
  });
  return pass.ok ? ok(output) : pass;
}

function uniformDescriptor(size: number) {
  return { size, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST };
}

function textureEntry(binding: number, value: TextureView) {
  return { binding, resource: { kind: 'textureView' as const, value } };
}

function viewEntries(input: ForwardShadowProjectionInput): BindGroupLayoutEntry[] {
  return [
    {
      binding: 0,
      visibility: input.lightData === undefined ? 2 : 3,
      buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: VIEW_UNIFORM_BYTES },
    },
    { binding: 4, visibility: 2, sampler: { type: 'comparison' } },
    { binding: 3, visibility: 2, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
    { binding: 7, visibility: 2, buffer: { type: 'uniform' } },
    {
      binding: 14,
      visibility: 2,
      buffer: { type: 'uniform', minBindingSize: SCREEN_AO_UNIFORM_BYTES },
    },
    { binding: 16, visibility: 2, texture: { sampleType: 'unfilterable-float' } },
    ...(input.point === undefined
      ? []
      : [
          {
            binding: 5,
            visibility: 2,
            texture: { sampleType: 'depth' as const, viewDimension: 'cube-array' as const },
          },
        ]),
    ...(input.spot === undefined
      ? []
      : [
          {
            binding: 8,
            visibility: 2,
            texture: { sampleType: 'depth' as const, viewDimension: '2d-array' as const },
          },
        ]),
    ...(input.admission.punctual?.point || input.admission.punctual?.spot === 'uniform'
      ? [{ binding: 6, visibility: 2, buffer: { type: 'uniform' as const } }]
      : []),
  ];
}

function makeProjectionPipeline(
  device: RhiDevice,
  layout: PipelineLayout,
  module: ShaderModule,
  format: 'r8unorm' | 'rgba8unorm',
  vertex: string,
  fragment: string,
  depthFormat: ForwardShadowProjectionInput['depth']['format'],
  writeMask?: number,
  cullMode: 'front' | 'back' | 'none' = 'none',
  always = false,
): RenderPipeline {
  return device
    .createRenderPipeline({
      label:
        fragment === 'fs_main' || fragment === 'fs_directional_rgba'
          ? FORWARD_DIRECTIONAL_SHADOW_PASS
          : `forward-shadow-${fragment}-${writeMask}`,
      layout,
      vertex: { module, entryPoint: vertex, buffers: [] },
      fragment: {
        module,
        entryPoint: fragment,
        targets: [{ format, writeMask: writeMask ?? 0x1 }],
      },
      primitive: { topology: 'triangle-list', cullMode },
      depthStencil: {
        format: depthFormat,
        depthWriteEnabled: false,
        depthCompare: always
          ? 'always'
          : fragment === 'fs_main' || fragment === 'fs_directional_rgba'
            ? 'less-equal'
            : 'greater-equal',
      },
    })
    .unwrap();
}

function forwardShadowProjectionModule(frame: _InternalRenderPipelineContext) {
  const source = frame.runtime.standardSceneShaders?.forwardDirectionalShadow;
  const factory = frame.runtime.immediateShaderModuleFactory ?? frame.runtime.shaderModuleFactory;
  if (source === undefined || factory === undefined)
    throw new RhiError({
      code: 'feature-not-enabled',
      expected: 'the current Forward shadow projection program',
      hint: 'Rebuild the Engine shader publication for screen shadow receivers.',
    });
  return factory
    .createShaderModule(
      shaderSourceDescriptor(source, 'forgeax::engine-forward-directional-shadow'),
    )
    .unwrap();
}

function prepareForwardShadowProjection(
  frame: _InternalRenderPipelineContext,
  input: ForwardShadowProjectionInput,
  drawFullscreen: boolean,
) {
  const sampler = frame.pipelineState.perPassResources.shadowSampler;
  if (sampler === null)
    throw new RhiError({
      code: 'feature-not-enabled',
      expected: 'the Forward shadow comparison sampler',
      hint: 'Prepare Standard shadow resources before projecting shadows.',
    });
  const device = frame.runtime.device;
  const module = forwardShadowProjectionModule(frame);
  const view = device.createBindGroupLayout({ entries: viewEntries(input) }).unwrap();
  const projectionDepthSampler = device
    .createSampler({ addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' })
    .unwrap();
  const geometry = device
    .createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 2, texture: { sampleType: 'depth' } },
        {
          binding: 1,
          visibility: 3,
          buffer: { type: 'uniform', minBindingSize: FORWARD_SHADOW_MATRIX_BYTES },
        },
        { binding: 3, visibility: 2, sampler: { type: 'non-filtering' } },
        ...(input.lightData === undefined
          ? []
          : [{ binding: 2, visibility: 3, buffer: { type: 'read-only-storage' as const } }]),
      ],
    })
    .unwrap();
  const layout = device.createPipelineLayout({ bindGroupLayouts: [view, geometry] }).unwrap();
  const { format } = input.admission;
  const directional =
    input.directional === undefined && !drawFullscreen
      ? undefined
      : makeProjectionPipeline(
          device,
          layout,
          module,
          format,
          'vs_main',
          format === 'r8unorm' ? 'fs_main' : 'fs_directional_rgba',
          input.depth.format,
          format === 'r8unorm' ? 0x1 : 0x9,
          'none',
          drawFullscreen,
        );
  const local = new Map<string, RenderPipeline>();
  const punctual = (
    kind: 'point' | 'spot',
    channel: number,
    volume: 'front' | 'back' | undefined,
    fragment: string,
    reflected: boolean,
  ) => {
    const cullMode =
      volume === undefined ? 'none' : reflected === (volume === 'front') ? 'front' : 'back';
    const key = `${fragment}:${channel}:${volume}:${cullMode}`;
    const existing = local.get(key);
    if (existing !== undefined) return existing;
    const pipeline = makeProjectionPipeline(
      device,
      layout,
      module,
      'rgba8unorm',
      volume ? `vs_${kind}_volume` : 'vs_punctual',
      fragment,
      input.depth.format,
      1 << channel,
      cullMode,
      volume === 'back',
    );
    local.set(key, pipeline);
    return pipeline;
  };
  return {
    view,
    geometry,
    directional,
    punctual,
    sampler,
    projectionDepthSampler,
    viewGroups: new WeakMap<object, BindGroup>(),
    geometryGroups: new WeakMap<object, BindGroup>(),
  };
}

function recordPunctualShadows(
  pass: RhiRenderPassEncoder,
  frame: _InternalRenderPipelineContext,
  program: ReturnType<typeof prepareForwardShadowProjection>,
  admission: ForwardShadowProjectionInput['admission'],
  matrices: ReturnType<typeof prepareForwardShadowMatrices>,
  bounds: ReturnType<typeof prepareForwardShadowBounds>,
): void {
  const prepared = frame.standardLighting?.prepared;
  const local = prepared?.local;
  const plan =
    prepared === undefined
      ? undefined
      : forwardPunctualShadowPlan(prepared, admission.directional !== false, admission);
  if (
    plan?.kind !== 'projected' ||
    plan.point !== admission.punctual?.point ||
    plan.spot !== Boolean(admission.punctual?.spot)
  )
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'the same light roster for the accepted Forward projection and Cluster rows',
      hint: 'Prepare the View graph again after the shadow light roster changes.',
    });
  const reflected = isReflectedTransform(frame.camera.world);
  for (const { kind, slot, channel } of plan.lights) {
    const light = local?.[slot]?.source;
    if (light?.kind !== 'point' && light?.kind !== 'spot') continue;
    const rect = bounds(
      light,
      matrices.worldToClip,
      matrices.spotVolumes,
      admission.width,
      admission.height,
    );
    if (rect === undefined) continue;
    pass.setScissorRect(rect.x, rect.y, rect.width, rect.height);
    pass.setViewport(0, 0, admission.width, admission.height, 0, rect.volume ? 1 : rect.depth);
    const fragment = localShadowFragment(light, admission, frame);
    pass.setPipeline(program.punctual(kind, channel, rect.volume, fragment, reflected));
    const vertices = rect.volume ? (kind === 'point' ? 60 : 36) : 3;
    pass.draw(vertices, 1, 0, slot);
  }
}

function localShadowFragment(
  light:
    | import('../render-system-extract').PointLightSnapshot
    | import('../render-system-extract').SpotLightSnapshot,
  admission: ForwardShadowProjectionInput['admission'],
  frame: _InternalRenderPipelineContext,
) {
  if (light.kind === 'point') {
    const shadow = frame.frameState.pointShadowSnapshots.find(
      (candidate) => candidate.shadowAtlasLayer === light.shadowAtlasLayer,
    );
    return shadow?.shadowFilter === DirectionalShadowFilterValue.pcf1 ||
      (shadow?.pcfKernelSize ?? 3) <= 1
      ? 'fs_point_basic'
      : 'fs_point';
  }
  if (
    admission.gatherSpot &&
    (light.shadowFilter ?? DirectionalShadowFilterValue.pcfVogel) ===
      DirectionalShadowFilterValue.pcfVogel &&
    (light.pcfKernelSize ?? 3) === 3 &&
    (light.shadowMapAspect ?? 1) === 1
  )
    return 'fs_spot_gather';
  return admission.punctual?.spot === 'compact' ? 'fs_spot_compact' : 'fs_spot';
}
