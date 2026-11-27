import type {
  GraphBuffer,
  GraphTexture,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import {
  type BindGroupLayout,
  type ComputePipeline,
  RhiError,
  type Sampler,
} from '@forgeax/engine-rhi';
import { ok, type Result, shaderSourceDescriptor } from '@forgeax/engine-types';
import { AtmosphereLutPass } from '../record/gpu-pass-timing/sky-pass-names';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { RenderPipelineFrame } from '../render-pipeline';
import { atmosphereMediumKey, atmosphereStorage, stageAtmospherePublish } from './storage';
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

/** Packed materials read group 2; only the native layout extends View with five textures. */
export function atmosphereVolumeViews(
  resources: Pick<import('@forgeax/engine-render-graph').GraphResourceResolver, 'textureView'>,
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
): Result<
  {
    aerialView: GraphTextureView;
    extinctionView?: GraphTextureView;
    aerialDepth: number;
  },
  RenderGraphError
> {
  const aerialDepth = fast ? 16 : 32;
  const addVolume = (name: string) => {
    const texture = graph.createTexture(name, {
      format: 'rgba16float',
      size: { width: 32, height: 32, depthOrArrayLayers: aerialDepth },
      dimension: '3d',
      usage: 0x0c,
    });
    return texture.ok ? graph.view(texture.value, { dimension: '3d' }) : texture;
  };
  const aerial = addVolume('atmosphere-aerial-perspective');
  if (!aerial.ok) return aerial;
  if (fast) return ok({ aerialView: aerial.value, aerialDepth });
  const extinction = addVolume('atmosphere-aerial-transmittance');
  return extinction.ok
    ? ok({ aerialView: aerial.value, extinctionView: extinction.value, aerialDepth })
    : extinction;
}

function atmosphereLutEntryPoint(name: keyof typeof AtmosphereLutPass, fast: boolean): string {
  if (name === 'aerial_perspective' && fast) return 'atmosphere_aerial_perspective_fast';
  return `atmosphere_${name === 'capture_sky_view' ? 'sky_view' : name}`;
}

/** Medium tables persist; camera-dependent tables belong to this camera graph. */
export function addAtmosphereLuts(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  captureParameters: GraphBuffer,
  captureDirty: (frame: RenderPipelineFrame) => boolean,
  visibility: AtmosphereVisibility = {},
  fastAerialPerspective = false,
): Result<GraphAtmosphere, RenderGraphError> {
  const table = (
    name: 'transmittance' | 'multipleScattering' | 'captureSky' | 'distantSkyLight',
    width: number,
    height: number,
  ) => {
    const texture = graph.importTexture(
      `atmosphere-${name}`,
      { format: 'rgba16float', size: { width, height }, usage: 0x0c },
      (frame) => atmosphereStorage(frame)[name],
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
  const distant = table('distantSkyLight', 1, 1);
  if (!distant.ok) return distant;
  const captureSky = table('captureSky', 192, 208);
  if (!captureSky.ok) return captureSky;
  const sky = graph.createTexture('atmosphere-sky-view', {
    format: 'rgba16float',
    size: { width: 192, height: 208 },
    usage: 0x0c,
  });
  if (!sky.ok) return sky;
  const skyView = graph.view(sky.value, { dimension: '2d' });
  if (!skyView.ok) return skyView;
  const volumes = addAerialLutTargets(graph, fastAerialPerspective);
  if (!volumes.ok) return volumes;
  const { aerialView, extinctionView, aerialDepth } = volumes.value;
  const view = graph.importBuffer(
    'atmosphere-lut-view',
    { size: VIEW_UNIFORM_BYTES, usage: 0x48 },
    (frame) => frame.pipelineState.viewUniformBuffer,
  );
  if (!view.ok) return view;
  const mediumKey = (frame: RenderPipelineFrame) =>
    atmosphereMediumKey(atmosphereStorage(frame).environment);
  for (const stage of [
    {
      name: 'transmittance',
      target: transmittance.value.view,
      inputs: [],
      groups: [32, 8, 1],
      shared: true,
    },
    {
      name: 'multiple_scattering',
      target: multiple.value.view,
      inputs: [transmittance.value.view],
      groups: [4, 4, 1],
      shared: true,
    },
    {
      name: 'distant_sky_light',
      target: distant.value.view,
      inputs: [transmittance.value.view, multiple.value.view],
      groups: [1, 1, 1],
      shared: false,
    },
    {
      name: 'capture_sky_view',
      target: captureSky.value.view,
      inputs: [transmittance.value.view, multiple.value.view],
      groups: [24, 26, 1],
      shared: false,
    },
    {
      name: 'sky_view',
      target: skyView.value,
      inputs: [transmittance.value.view, multiple.value.view],
      groups: [24, 26, 1],
      shared: false,
    },
    {
      name: 'aerial_perspective',
      target: aerialView,
      inputs: [transmittance.value.view, multiple.value.view],
      groups: [8, 8, aerialDepth / 4],
      shared: false,
    },
  ] as const) {
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
    const entryPoint = atmosphereLutEntryPoint(stage.name, fastAerialPerspective);
    const usesVisibility = !stage.shared;
    const localVisibility = stage.name === 'sky_view' || volume ? visibility : {};
    const parameters =
      stage.name === 'capture_sky_view' || stage.name === 'distant_sky_light'
        ? captureParameters
        : view.value;
    const pass = graph.addComputePass(AtmosphereLutPass[stage.name], {
      accesses: [
        ...atmosphereVisibilityAccesses(localVisibility),
        { resource: parameters, usage: 'uniform-read' },
        ...stage.inputs.map((resource) => ({ resource, usage: 'sampled-read' as const })),
        { resource: stage.target, usage: 'storage-write' },
        ...(extinctionOutput === undefined
          ? []
          : [{ resource: extinctionOutput, usage: 'storage-write' as const }]),
      ],
      ...(stage.shared
        ? {
            executeIf: (frame: RenderPipelineFrame) =>
              atmosphereStorage(frame).submittedMedium !== mediumKey(frame) &&
              atmosphereStorage(frame).recordedMediumEncoder !== frame.encoder,
          }
        : stage.name === 'capture_sky_view' || stage.name === 'distant_sky_light'
          ? { executeIf: captureDirty }
          : {
              executeIf: (frame: RenderPipelineFrame) =>
                (frame as _InternalRenderPipelineContext).capturedAtmosphere === undefined &&
                (atmosphereVisibilityDirty(frame, localVisibility) ||
                  submittedViewKey !== viewKey(frame)),
            }),
      encodeDirect: (pass, frame, resources) => {
        if (state === undefined) {
          const source = frame.atmosphereShaders?.luts;
          const factory = frame.runtime.shaderModuleFactory;
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
                {
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
              {
                binding: volume ? 5 : 4,
                resource: {
                  kind: 'textureView',
                  value: resources.textureView(stage.target).unwrap(),
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
        if (stage.name === 'sky_view' || stage.name === 'aerial_perspective') {
          const key = viewKey(frame);
          stageAtmospherePublish((frame as _InternalRenderPipelineContext).frameState, () => {
            submittedViewKey = key;
          });
        }
        if (stage.name === 'multiple_scattering') {
          const key = mediumKey(frame);
          const storage = atmosphereStorage(frame);
          storage.recordedMediumEncoder = frame.encoder;
          stageAtmospherePublish((frame as _InternalRenderPipelineContext).frameState, () => {
            storage.submittedMedium = key;
          });
        }
      },
    });
    if (!pass.ok) return pass;
  }
  return ok({
    execution: 'compute-volume',
    cloudSources: { transmittance: transmittance.value, distantSkyLight: distant.value },
    visibility,
    transmittance: transmittance.value.view,
    multipleScattering: multiple.value.view,
    skyView: skyView.value,
    captureSky: captureSky.value.view,
    distantSkyLight: distant.value.view,
    aerialPerspective: aerialView,
    fastAerialPerspective,
    ...(extinctionView === undefined ? {} : { aerialTransmittance: extinctionView }),
  });
}
