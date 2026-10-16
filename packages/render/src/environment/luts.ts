import type {
  GraphBuffer,
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
import { ok, type Result } from '@forgeax/engine-types';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { RenderPipelineFrame } from '../render-pipeline';
import { atmosphereMediumKey, atmosphereStorage, stageAtmospherePublish } from './storage';
import {
  type AtmosphereVisibility,
  atmosphereVisibilityAccesses,
  atmosphereVisibilityGroup,
  atmosphereVisibilityLayout,
} from './visibility';

export interface GraphAtmosphere {
  readonly visibility: AtmosphereVisibility;
  readonly transmittance: GraphTextureView;
  readonly multipleScattering: GraphTextureView;
  readonly skyView: GraphTextureView;
  readonly captureSky: GraphTextureView;
  readonly distantSkyLight: GraphTextureView;
  readonly aerialPerspective: GraphTextureView;
  readonly aerialTransmittance: GraphTextureView;
}

export function atmosphereTextures({
  visibility,
  ...textures
}: GraphAtmosphere): GraphTextureView[] {
  return [
    ...Object.values(textures),
    ...atmosphereVisibilityAccesses(visibility).map(({ resource }) => resource),
  ];
}

/** Medium tables persist; camera-dependent tables belong to this camera graph. */
export function addAtmosphereLuts(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  captureParameters: GraphBuffer,
  captureDirty: (frame: RenderPipelineFrame) => boolean,
  visibility: AtmosphereVisibility = {},
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
    return texture.ok ? graph.view(texture.value, { dimension: '2d' }) : texture;
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
  const aerial = graph.createTexture('atmosphere-aerial-perspective', {
    format: 'rgba16float',
    size: { width: 32, height: 32, depthOrArrayLayers: 32 },
    dimension: '3d',
    usage: 0x0c,
  });
  if (!aerial.ok) return aerial;
  const aerialView = graph.view(aerial.value, { dimension: '3d' });
  if (!aerialView.ok) return aerialView;
  const extinction = graph.createTexture('atmosphere-aerial-transmittance', {
    format: 'rgba16float',
    size: { width: 32, height: 32, depthOrArrayLayers: 32 },
    dimension: '3d',
    usage: 0x0c,
  });
  if (!extinction.ok) return extinction;
  const extinctionView = graph.view(extinction.value, { dimension: '3d' });
  if (!extinctionView.ok) return extinctionView;
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
      target: transmittance.value,
      inputs: [],
      groups: [32, 8, 1],
      shared: true,
    },
    {
      name: 'multiple_scattering',
      target: multiple.value,
      inputs: [transmittance.value],
      groups: [4, 4, 1],
      shared: true,
    },
    {
      name: 'distant_sky_light',
      target: distant.value,
      inputs: [transmittance.value, multiple.value],
      groups: [1, 1, 1],
      shared: false,
    },
    {
      name: 'capture_sky_view',
      target: captureSky.value,
      inputs: [transmittance.value, multiple.value],
      groups: [24, 26, 1],
      shared: false,
    },
    {
      name: 'sky_view',
      target: skyView.value,
      inputs: [transmittance.value, multiple.value],
      groups: [24, 26, 1],
      shared: false,
    },
    {
      name: 'aerial_perspective',
      target: aerialView.value,
      inputs: [transmittance.value, multiple.value],
      groups: [8, 8, 8],
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
    const usesVisibility = !stage.shared;
    const localVisibility = stage.name === 'sky_view' || volume ? visibility : {};
    const visibilityDirty = (frame: RenderPipelineFrame) => {
      if (localVisibility.cloud !== undefined) return true;
      if (localVisibility.directional === undefined) return false;
      const context = frame as _InternalRenderPipelineContext;
      if (context.directionalShadowCacheMiss !== undefined) return true;
      for (
        let index = 0;
        index < context.pipelineState.perPassResources.shadowCascadeCount;
        index++
      ) {
        if (
          context.gpuDrivenShadowViews?.invalidationReason({ kind: 'directional', index }) !==
          undefined
        )
          return true;
      }
      return false;
    };
    const parameters =
      stage.name === 'capture_sky_view' || stage.name === 'distant_sky_light'
        ? captureParameters
        : view.value;
    const pass = graph.addComputePass(`atmosphere-${stage.name.replaceAll('_', '-')}`, {
      accesses: [
        ...atmosphereVisibilityAccesses(localVisibility),
        { resource: parameters, usage: 'uniform-read' },
        ...stage.inputs.map((resource) => ({ resource, usage: 'sampled-read' as const })),
        { resource: stage.target, usage: 'storage-write' },
        ...(volume ? [{ resource: extinctionView.value, usage: 'storage-write' as const }] : []),
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
                (visibilityDirty(frame) || submittedViewKey !== viewKey(frame)),
            }),
      encode: ({ frame, pass, resources }) => {
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
            .createShaderModule({ code: source, label: 'atmosphere_luts' })
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
                ...(volume
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
                entryPoint: `atmosphere_${stage.name === 'capture_sky_view' ? 'sky_view' : stage.name}`,
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
              ...(volume
                ? [
                    {
                      binding: 6,
                      resource: {
                        kind: 'textureView' as const,
                        value: resources.textureView(extinctionView.value).unwrap(),
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
    visibility,
    transmittance: transmittance.value,
    multipleScattering: multiple.value,
    skyView: skyView.value,
    captureSky: captureSky.value,
    distantSkyLight: distant.value,
    aerialPerspective: aerialView.value,
    aerialTransmittance: extinctionView.value,
  });
}
