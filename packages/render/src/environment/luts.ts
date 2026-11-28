import type {
  GraphAccess,
  GraphBuffer,
  GraphTexture,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import {
  type BindGroupLayout,
  type ComputePipeline,
  type RenderPipeline,
  RhiError,
  type Sampler,
} from '@forgeax/engine-rhi';
import { ok, type Result, shaderSourceDescriptor } from '@forgeax/engine-types';
import { stockUtilityShaderFactory } from '../assembly/utility-shader-prewarm';
import { AtmosphereLutPass } from '../record/gpu-pass-timing/sky-pass-names';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { RenderPipelineFrame } from '../render-pipeline';
import {
  atmosphereMediumDirty,
  atmosphereStorage,
  stageAtmosphereMedium,
  stageAtmospherePublish,
} from './storage';
import {
  type AtmosphereVisibility,
  atmosphereVisibilityAccesses,
  atmosphereVisibilityDirty,
  atmosphereVisibilityGroup,
  atmosphereVisibilityLayout,
} from './visibility';

export interface GraphAtmosphereTables {
  readonly transmittance: GraphTextureView;
  readonly multipleScattering: GraphTextureView;
  readonly skyView: GraphTextureView;
  readonly captureSky: GraphTextureView;
}
interface GraphAtmosphereCommon extends GraphAtmosphereTables {
  readonly cloudSources?: {
    readonly transmittance: { readonly texture: GraphTexture; readonly view: GraphTextureView };
    readonly distantSkyLight: { readonly texture: GraphTexture; readonly view: GraphTextureView };
  };
  readonly visibility: AtmosphereVisibility;
  readonly distantSkyLight: GraphTextureView;
  readonly fastAerialPerspective?: boolean;
  readonly distantSkyBuffer?: GraphBuffer;
  readonly ue5?: true;
}
export type GraphAtmosphere = GraphAtmosphereCommon &
  (
    | {
        readonly execution: 'compute-volume';
        readonly aerialPerspective: GraphTextureView;
        readonly aerialTransmittance?: GraphTextureView;
      }
    | { readonly execution: 'fragment-cluster'; readonly packed: GraphTextureView }
  );

export type RasterAtmosphereReads = 'none' | 'solar';

export function atmosphereTextures(
  atmosphere: GraphAtmosphere,
  reads?: RasterAtmosphereReads,
): GraphTextureView[] {
  if (reads === 'none') return [];
  if (reads === 'solar') return [atmosphere.transmittance];
  return [
    atmosphere.transmittance,
    atmosphere.multipleScattering,
    atmosphere.skyView,
    atmosphere.captureSky,
    atmosphere.distantSkyLight,
    ...(atmosphere.execution === 'compute-volume'
      ? [
          atmosphere.aerialPerspective,
          ...(atmosphere.aerialTransmittance === undefined ? [] : [atmosphere.aerialTransmittance]),
        ]
      : [atmosphere.packed]),
    ...atmosphereVisibilityAccesses(atmosphere.visibility).map(({ resource }) => resource),
  ];
}

export function atmosphereAccesses(
  atmosphere: GraphAtmosphere,
  reads?: RasterAtmosphereReads,
): GraphAccess[] {
  return [
    ...Array.from(new Set(atmosphereTextures(atmosphere, reads)), (resource) => ({
      resource,
      usage: 'sampled-read' as const,
    })),
    ...(reads !== undefined || atmosphere.distantSkyBuffer === undefined
      ? []
      : [{ resource: atmosphere.distantSkyBuffer, usage: 'storage-read' as const }]),
  ];
}

/** Packed materials read group 2; only the native layout extends View with five textures. */
export function atmosphereVolumeViews(
  resources: Pick<import('@forgeax/engine-render-graph').GraphResourceResolver, 'textureView'> &
    Partial<Pick<import('@forgeax/engine-render-graph').GraphResourceResolver, 'buffer'>>,
  atmosphere: GraphAtmosphere | undefined,
  reads?: RasterAtmosphereReads,
): import('./bindings').AtmosphereViews | undefined {
  if (atmosphere?.execution !== 'compute-volume' || reads === 'none') return undefined;
  if (reads === 'solar')
    return { transmittance: resources.textureView(atmosphere.transmittance).unwrap() };
  return {
    transmittance: resources.textureView(atmosphere.transmittance).unwrap(),
    multipleScattering: resources.textureView(atmosphere.multipleScattering).unwrap(),
    distantSkyLight: resources.textureView(atmosphere.distantSkyLight).unwrap(),
    ...(atmosphere.distantSkyBuffer === undefined
      ? {}
      : {
          distantSkyBuffer: resources.buffer?.(atmosphere.distantSkyBuffer).unwrap(),
        }),
    aerialPerspective: resources.textureView(atmosphere.aerialPerspective).unwrap(),
    ...(atmosphere.aerialTransmittance === undefined
      ? {}
      : {
          aerialTransmittance: resources.textureView(atmosphere.aerialTransmittance).unwrap(),
        }),
  };
}

function addAerialLutTargets(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  fast: boolean,
  ue5: boolean,
): Result<
  {
    aerialView: GraphTextureView;
    extinctionView?: GraphTextureView;
    aerialDepth: number;
  },
  RenderGraphError
> {
  const aerialDepth = fast || ue5 ? 16 : 32;
  const addVolume = (name: string) => {
    const texture = graph.createTexture(name, {
      format: 'rgba16float',
      size: { width: 32, height: 32, depthOrArrayLayers: aerialDepth },
      dimension: '3d',
      usage: ue5 ? 0x0d : 0x0c,
    });
    return texture.ok ? graph.view(texture.value, { dimension: '3d' }) : texture;
  };
  const aerial = addVolume('atmosphere-aerial-perspective');
  if (!aerial.ok) return aerial;
  if (fast || ue5) return ok({ aerialView: aerial.value, aerialDepth });
  const extinction = addVolume('atmosphere-aerial-transmittance');
  return extinction.ok
    ? ok({ aerialView: aerial.value, extinctionView: extinction.value, aerialDepth })
    : extinction;
}

function atmosphereLutEntryPoint(name: keyof typeof AtmosphereLutPass, fast: boolean): string {
  if (name === 'aerial_perspective' && fast) return 'atmosphere_aerial_perspective_fast';
  return `atmosphere_${name === 'capture_sky_view' ? 'sky_view' : name}`;
}

function declareAtmosphereLutTargets(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  fastAerialPerspective: boolean,
  ue5: boolean,
  realtimeSkyCapture: boolean,
) {
  const lutFormat = ue5 ? 'rg11b10ufloat' : 'rgba16float';
  const lutUsage = ue5 ? 0x15 : 0x0c;
  const skyHeight = ue5 ? 104 : 208;
  const table = (
    name: 'transmittance' | 'multipleScattering' | 'captureSky' | 'distantSkyLight',
    width: number,
    height: number,
  ) => {
    const texture = graph.importTexture(
      `atmosphere-${name}`,
      { format: lutFormat, size: { width, height }, usage: lutUsage },
      (frame) => {
        const storage = atmosphereStorage(frame);
        if (!ue5) return storage[name];
        switch (name) {
          case 'transmittance':
            return storage.ue5Transmittance;
          case 'multipleScattering':
            return storage.ue5MultipleScattering;
          case 'captureSky':
            return storage.ue5CaptureSky;
          case 'distantSkyLight':
            throw new Error('UE distant sky is a buffer');
        }
      },
    );
    if (!texture.ok) return texture;
    const view = graph.view(texture.value, { dimension: '2d' });
    if (!view.ok) return view;
    return ok({ texture: texture.value, view: view.value });
  };
  const transmittance = table('transmittance', 256, 64);
  if (!transmittance.ok) return transmittance;
  const multiple = table('multipleScattering', 32, 32);
  if (!multiple.ok) return multiple;
  // Legacy bindings use an already available typed view in UE mode. The UE
  // shader selects its buffer and never reads this view as distant skylight.
  const distant = ue5 ? transmittance : table('distantSkyLight', 1, 1);
  if (!distant.ok) return distant;
  const distantBuffer = ue5
    ? graph.importBuffer(
        'atmosphere-distant-sky-light',
        { size: 16, usage: 0x84 },
        (frame) => atmosphereStorage(frame).distantSkyBuffer,
      )
    : undefined;
  if (distantBuffer !== undefined && !distantBuffer.ok) return distantBuffer;
  const captureSky = !ue5 || realtimeSkyCapture ? table('captureSky', 192, skyHeight) : undefined;
  if (captureSky !== undefined && !captureSky.ok) return captureSky;
  const sky = graph.createTexture('atmosphere-sky-view', {
    format: lutFormat,
    size: { width: 192, height: skyHeight },
    usage: lutUsage,
  });
  if (!sky.ok) return sky;
  const skyView = graph.view(sky.value, { dimension: '2d' });
  if (!skyView.ok) return skyView;
  const volumes = addAerialLutTargets(graph, fastAerialPerspective, ue5);
  if (!volumes.ok) return volumes;
  const { aerialView, extinctionView, aerialDepth } = volumes.value;
  const view = graph.importBuffer(
    'atmosphere-lut-view',
    { size: VIEW_UNIFORM_BYTES, usage: 0x48 },
    (frame) => frame.pipelineState.viewUniformBuffer,
  );
  if (!view.ok) return view;
  return ok({
    transmittance: transmittance.value,
    multiple: multiple.value,
    distant: distant.value,
    distantBuffer: distantBuffer?.value,
    captureSky: captureSky?.value.view,
    skyView: skyView.value,
    view: view.value,
    aerialView,
    extinctionView,
    aerialDepth,
  });
}

/** Medium tables persist; camera-dependent tables belong to this camera graph. */
export function addAtmosphereLuts(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  captureParameters: GraphBuffer,
  captureDirty: (frame: RenderPipelineFrame) => boolean,
  visibility: AtmosphereVisibility = {},
  fastAerialPerspective = false,
  ue5 = false,
  realtimeSkyCapture = false,
): Result<GraphAtmosphere, RenderGraphError> {
  const targets = declareAtmosphereLutTargets(
    graph,
    fastAerialPerspective,
    ue5,
    realtimeSkyCapture,
  );
  if (!targets.ok) return targets;
  const {
    transmittance,
    multiple,
    distant,
    distantBuffer,
    skyView,
    captureSky,
    view,
    aerialView,
    extinctionView,
    aerialDepth,
  } = targets.value;
  const stages: readonly AtmosphereLutStage[] = [
    {
      name: 'transmittance',
      target: transmittance.view,
      inputs: [],
      groups: [32, 8, 1],
      shared: true,
    },
    {
      name: 'multiple_scattering',
      target: multiple.view,
      inputs: [transmittance.view],
      groups: [4, 4, 1],
      shared: true,
    },
    {
      name: 'distant_sky_light',
      target: distant.view,
      inputs: [transmittance.view, multiple.view],
      groups: [1, 1, 1],
      shared: false,
    },
    {
      name: 'capture_sky_view',
      target: captureSky ?? skyView,
      inputs: [transmittance.view, multiple.view],
      groups: [24, 26, 1],
      shared: false,
    },
    {
      name: 'sky_view',
      target: skyView,
      inputs: [transmittance.view, multiple.view],
      groups: [24, 26, 1],
      shared: false,
    },
    {
      name: 'aerial_perspective',
      target: aerialView,
      inputs: [transmittance.view, multiple.view],
      groups: [8, 8, aerialDepth / 4],
      shared: false,
    },
  ];
  for (const stage of stages) {
    if (stage.name === 'capture_sky_view' && captureSky === undefined) continue;
    const pass =
      ue5 && !isVolumeOrDistantLut(stage.name)
        ? addUeAtmosphereRasterLut(graph, stage, view, captureParameters, captureDirty, visibility)
        : addAtmosphereComputeLut(graph, stage, {
            view,
            captureParameters,
            captureDirty,
            visibility,
            extinctionView,
            distantBuffer,
            fastAerialPerspective,
            ue5,
          });
    if (!pass.ok) return pass;
  }
  return ok({
    execution: 'compute-volume',
    cloudSources: { transmittance: transmittance, distantSkyLight: distant },
    ...(distantBuffer === undefined ? {} : { ue5: true as const, distantSkyBuffer: distantBuffer }),
    visibility,
    transmittance: transmittance.view,
    multipleScattering: multiple.view,
    skyView: skyView,
    captureSky: captureSky ?? skyView,
    distantSkyLight: distant.view,
    aerialPerspective: aerialView,
    fastAerialPerspective: fastAerialPerspective && !ue5,
    ...(ue5
      ? { aerialTransmittance: aerialView }
      : extinctionView === undefined
        ? {}
        : { aerialTransmittance: extinctionView }),
  });
}

interface AtmosphereLutStage {
  readonly name: keyof typeof AtmosphereLutPass;
  readonly target: GraphTextureView;
  readonly inputs: readonly GraphTextureView[];
  readonly groups: readonly [number, number, number];
  readonly shared: boolean;
}

function isVolumeOrDistantLut(name: AtmosphereLutStage['name']): boolean {
  return name === 'aerial_perspective' || name === 'distant_sky_light';
}

function captureMediumKey(frame: RenderPipelineFrame): string {
  return String(atmosphereStorage(frame).mediumRevision);
}

function addUeAtmosphereRasterLut(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  stage: AtmosphereLutStage,
  view: GraphBuffer,
  captureParameters: GraphBuffer,
  captureDirty: (frame: RenderPipelineFrame) => boolean,
  visibility: AtmosphereVisibility,
) {
  const isCapture = stage.name === 'capture_sky_view';
  const skyStage = stage.name === 'sky_view';
  const localVisibility = skyStage ? visibility : {};
  const params = isCapture ? captureParameters : view;
  const name = isCapture ? 'sky_view' : stage.name;
  let state: { layout: BindGroupLayout; pipeline: RenderPipeline; sampler: Sampler } | undefined;
  let submittedSky: string | undefined;
  const key = (frame: RenderPipelineFrame) => {
    const env = atmosphereStorage(frame).environment;
    return stage.shared
      ? JSON.stringify([
          captureMediumKey(frame),
          env.source.kind === 'atmosphere' ? env.source.atmosphere.multipleScattering : 0,
        ])
      : JSON.stringify([env.environmentSignature, Array.from(frame.camera.position)]);
  };
  return graph.addRasterPass(AtmosphereLutPass[stage.name], {
    accesses: [
      ...atmosphereVisibilityAccesses(localVisibility),
      { resource: params, usage: 'uniform-read' },
      ...stage.inputs.map((resource) => ({ resource, usage: 'sampled-read' as const })),
      { resource: stage.target, usage: 'color-attachment' },
    ],
    colorAttachments: [{ view: stage.target, loadOp: 'clear', storeOp: 'store' }],
    executeIf: (frame) => {
      const storage = atmosphereStorage(frame);
      if (stage.shared)
        return (
          storage.ue5SubmittedMedium !== key(frame) &&
          storage.ue5RecordedMediumEncoder !== frame.encoder
        );
      if (isCapture) return captureDirty(frame);
      return atmosphereVisibilityDirty(frame, localVisibility) || submittedSky !== key(frame);
    },
    encodeDirect: (pass, frame, resources) => {
      const device = frame.runtime.device;
      if (state === undefined) {
        const source = frame.atmosphereShaders?.lutsFragment;
        const factory = stockUtilityShaderFactory(frame.runtime);
        if (source === undefined || factory === undefined)
          throw new RhiError({
            code: 'shader-compile-failed',
            expected: 'UE atmosphere raster LUT writers',
            hint: 'rebuild the Engine shader manifest',
          });
        const module = factory
          .createShaderModule(shaderSourceDescriptor(source, 'atmosphere_luts_fragment'))
          .unwrap();
        const layout = device
          .createBindGroupLayout({
            entries: [
              {
                binding: 0,
                visibility: 2,
                buffer: { type: 'uniform', minBindingSize: VIEW_UNIFORM_BYTES },
              },
              ...stage.inputs.map((_, i) => ({
                binding: i + 1,
                visibility: 2,
                texture: { sampleType: 'float' as const, viewDimension: '2d' as const },
              })),
              ...(stage.inputs.length === 0
                ? []
                : [{ binding: 3, visibility: 2, sampler: { type: 'filtering' as const } }]),
            ],
          })
          .unwrap();
        const pipeline = device
          .createRenderPipeline({
            label: `atmosphere-ue5-${stage.name}`,
            layout: device
              .createPipelineLayout({
                bindGroupLayouts: [
                  layout,
                  ...(stage.shared ? [] : [atmosphereVisibilityLayout(device)]),
                ],
              })
              .unwrap(),
            vertex: { module, entryPoint: 'atmosphere_tables_vs', buffers: [] },
            fragment: {
              module,
              entryPoint: `atmosphere_ue5_${name}_fragment`,
              targets: [{ format: 'rg11b10ufloat' }],
            },
            primitive: { topology: 'triangle-list' },
          })
          .unwrap();
        state = {
          layout,
          pipeline,
          sampler: device.createSampler({ minFilter: 'linear', magFilter: 'linear' }).unwrap(),
        };
      }
      const parameterBuffer = resources.buffer(params).unwrap();
      const group = device
        .createBindGroup({
          layout: state.layout,
          entries: [
            {
              binding: 0,
              resource: {
                kind: 'buffer',
                value: { buffer: parameterBuffer, size: VIEW_UNIFORM_BYTES },
              },
            },
            ...stage.inputs.map((input, i) => ({
              binding: i + 1,
              resource: {
                kind: 'textureView' as const,
                value: resources.textureView(input).unwrap(),
              },
            })),
            ...(stage.inputs.length === 0
              ? []
              : [{ binding: 3, resource: { kind: 'sampler' as const, value: state.sampler } }]),
          ],
        })
        .unwrap();
      pass.setPipeline(state.pipeline);
      pass.setBindGroup(0, group);
      if (!stage.shared)
        pass.setBindGroup(
          1,
          atmosphereVisibilityGroup(
            frame,
            parameterBuffer,
            0,
            localVisibility.directional === undefined
              ? undefined
              : resources.textureView(localVisibility.directional).unwrap(),
            localVisibility.cloud === undefined
              ? undefined
              : resources.textureView(localVisibility.cloud).unwrap(),
          ),
        );
      pass.draw(3);
      const identity = key(frame);
      const storage = atmosphereStorage(frame);
      if (stage.name === 'multiple_scattering') storage.ue5RecordedMediumEncoder = frame.encoder;
      stageAtmospherePublish((frame as _InternalRenderPipelineContext).frameState, () => {
        if (stage.name === 'multiple_scattering') storage.ue5SubmittedMedium = identity;
        if (skyStage) submittedSky = identity;
      });
    },
  });
}

interface AtmosphereComputeInputs {
  readonly view: GraphBuffer;
  readonly captureParameters: GraphBuffer;
  readonly captureDirty: (frame: RenderPipelineFrame) => boolean;
  readonly visibility: AtmosphereVisibility;
  readonly extinctionView: GraphTextureView | undefined;
  readonly distantBuffer: GraphBuffer | undefined;
  readonly fastAerialPerspective: boolean;
  readonly ue5: boolean;
}

function addAtmosphereComputeLut(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  stage: AtmosphereLutStage,
  inputs: AtmosphereComputeInputs,
) {
  const {
    view,
    captureParameters,
    captureDirty,
    visibility,
    extinctionView,
    distantBuffer,
    fastAerialPerspective,
    ue5,
  } = inputs;
  let state: { layout: BindGroupLayout; pipeline: ComputePipeline; sampler: Sampler } | undefined;
  let submittedViewKey: string | undefined;
  const viewKey = (frame: RenderPipelineFrame) => {
    const camera = frame.camera;
    return JSON.stringify([
      atmosphereStorage(frame).environment.environmentSignature,
      stage.name === 'sky_view'
        ? Array.from(camera.position)
        : [
            Array.from(camera.world),
            camera.captureProjection === undefined ? null : Array.from(camera.captureProjection),
            camera.fov,
            camera.aspect,
            ...(camera.projectionOffset ?? [0, 0]),
            camera.near,
            camera.far,
            camera.projection,
            camera.orthoLeft,
            camera.orthoRight,
            camera.orthoBottom,
            camera.orthoTop,
            camera.temporal?.currentJitterUv,
          ],
    ]);
  };
  const volume = stage.name === 'aerial_perspective';
  const extinctionOutput = volume ? extinctionView : undefined;
  const entryPoint = ue5
    ? `atmosphere_ue5_${stage.name === 'capture_sky_view' ? 'sky_view' : stage.name}`
    : atmosphereLutEntryPoint(stage.name, fastAerialPerspective);
  const bufferTarget = stage.name === 'distant_sky_light' ? distantBuffer : undefined;
  const usesVisibility = !stage.shared;
  const localVisibility = stage.name === 'sky_view' || volume ? visibility : {};
  const parameters =
    stage.name === 'capture_sky_view' || stage.name === 'distant_sky_light'
      ? captureParameters
      : view;
  const recordSubmission = (frame: RenderPipelineFrame) => {
    if (bufferTarget !== undefined) {
      const storage = atmosphereStorage(frame);
      const key = storage.environment.environmentSignature;
      stageAtmospherePublish((frame as _InternalRenderPipelineContext).frameState, () => {
        storage.ue5SubmittedDistant = key;
      });
    }
    if (stage.name === 'sky_view' || stage.name === 'aerial_perspective') {
      const key = viewKey(frame);
      stageAtmospherePublish((frame as _InternalRenderPipelineContext).frameState, () => {
        submittedViewKey = key;
      });
    }
    if (stage.name === 'multiple_scattering') stageAtmosphereMedium(frame);
  };
  return graph.addComputePass(AtmosphereLutPass[stage.name], {
    accesses: [
      ...atmosphereVisibilityAccesses(localVisibility),
      { resource: parameters, usage: 'uniform-read' },
      ...stage.inputs.map((resource) => ({ resource, usage: 'sampled-read' as const })),
      bufferTarget === undefined
        ? { resource: stage.target, usage: 'storage-write' }
        : { resource: bufferTarget, usage: 'storage-write' },
      ...(extinctionOutput === undefined
        ? []
        : [{ resource: extinctionOutput, usage: 'storage-write' as const }]),
    ],
    ...(stage.shared
      ? {
          executeIf: atmosphereMediumDirty,
        }
      : stage.name === 'capture_sky_view' || stage.name === 'distant_sky_light'
        ? {
            executeIf: (frame: RenderPipelineFrame) =>
              bufferTarget === undefined
                ? captureDirty(frame)
                : atmosphereStorage(frame).ue5SubmittedDistant !==
                  atmosphereStorage(frame).environment.environmentSignature,
          }
        : {
            executeIf: (frame: RenderPipelineFrame) =>
              (frame as _InternalRenderPipelineContext).capturedAtmosphere === undefined &&
              (atmosphereVisibilityDirty(frame, localVisibility) ||
                submittedViewKey !== viewKey(frame)),
          }),
    encodeDirect: (pass, frame, resources) => {
      if (state === undefined) {
        const source = frame.atmosphereShaders?.luts;
        const factory = stockUtilityShaderFactory(frame.runtime);
        if (source === undefined || factory === undefined)
          throw new RhiError({
            code: 'shader-compile-failed',
            expected: 'compiled atmosphere LUT kernels',
            hint: 'rebuild the engine shader manifest',
          });
        const device = frame.runtime.device;
        const module = factory
          .createShaderModule(shaderSourceDescriptor(source, 'atmosphere_luts'))
          .unwrap();
        const layout = device
          .createBindGroupLayout({
            entries: [
              {
                binding: 0,
                visibility: 4,
                buffer: { type: 'uniform', minBindingSize: VIEW_UNIFORM_BYTES },
              },
              ...stage.inputs.map((_, i) => ({
                binding: i + 1,
                visibility: 4,
                texture: { sampleType: 'float' as const, viewDimension: '2d' as const },
              })),
              ...(stage.inputs.length
                ? [{ binding: 3, visibility: 4, sampler: { type: 'filtering' as const } }]
                : []),
              bufferTarget !== undefined
                ? {
                    binding: 7,
                    visibility: 4,
                    buffer: { type: 'storage', minBindingSize: 16 },
                  }
                : {
                    binding: volume ? 5 : 4,
                    visibility: 4,
                    storageTexture: {
                      access: 'write-only',
                      format: 'rgba16float',
                      viewDimension: volume ? '3d' : '2d',
                    },
                  },
              ...(extinctionOutput !== undefined
                ? [
                    {
                      binding: 6,
                      visibility: 4,
                      storageTexture: {
                        access: 'write-only' as const,
                        format: 'rgba16float' as const,
                        viewDimension: '3d' as const,
                      },
                    },
                  ]
                : []),
            ],
          })
          .unwrap();
        const pipeline = device
          .createComputePipeline({
            label: `atmosphere_${stage.name}`,
            layout: device
              .createPipelineLayout({
                bindGroupLayouts: [
                  layout,
                  ...(usesVisibility ? [atmosphereVisibilityLayout(device)] : []),
                ],
              })
              .unwrap(),
            compute: {
              module,
              entryPoint,
            },
          })
          .unwrap();
        state = {
          layout,
          pipeline,
          sampler: device.createSampler({ minFilter: 'linear', magFilter: 'linear' }).unwrap(),
        };
      }
      const group = frame.runtime.device
        .createBindGroup({
          layout: state.layout,
          entries: [
            {
              binding: 0,
              resource: {
                kind: 'buffer',
                value: {
                  buffer: resources.buffer(parameters).unwrap(),
                  size: VIEW_UNIFORM_BYTES,
                },
              },
            },
            ...stage.inputs.map((input, i) => ({
              binding: i + 1,
              resource: {
                kind: 'textureView' as const,
                value: resources.textureView(input).unwrap(),
              },
            })),
            ...(stage.inputs.length
              ? [{ binding: 3, resource: { kind: 'sampler' as const, value: state.sampler } }]
              : []),
            bufferTarget === undefined
              ? {
                  binding: volume ? 5 : 4,
                  resource: {
                    kind: 'textureView',
                    value: resources.textureView(stage.target).unwrap(),
                  },
                }
              : {
                  binding: 7,
                  resource: {
                    kind: 'buffer',
                    value: { buffer: resources.buffer(bufferTarget).unwrap(), size: 16 },
                  },
                },
            ...(extinctionOutput !== undefined
              ? [
                  {
                    binding: 6,
                    resource: {
                      kind: 'textureView' as const,
                      value: resources.textureView(extinctionOutput).unwrap(),
                    },
                  },
                ]
              : []),
          ],
        })
        .unwrap();
      pass.setPipeline(state.pipeline);
      pass.setBindGroup(0, group);
      if (usesVisibility)
        pass.setBindGroup(
          1,
          atmosphereVisibilityGroup(
            frame,
            resources.buffer(parameters).unwrap(),
            0,
            localVisibility.directional === undefined
              ? undefined
              : resources.textureView(localVisibility.directional).unwrap(),
            localVisibility.cloud === undefined
              ? undefined
              : resources.textureView(localVisibility.cloud).unwrap(),
          ),
        );
      pass.dispatchWorkgroups(stage.groups[0], stage.groups[1], stage.groups[2]);
      recordSubmission(frame);
    },
  });
}
