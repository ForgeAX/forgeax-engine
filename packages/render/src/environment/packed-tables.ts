import type {
  GraphBuffer,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import { RenderGraphError as GraphFailure } from '@forgeax/engine-render-graph';
import {
  type BindGroupLayout,
  type RenderPipeline,
  RhiError,
  type Sampler,
} from '@forgeax/engine-rhi';
import { err, ok, type Result, shaderSourceDescriptor } from '@forgeax/engine-types';
import type { AtmosphereTextureContent } from '../hdrp-buffers';
import type { StandardClusterGraphBuffers } from '../pipeline/standard-lighting/graph';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { GraphAtmosphere } from './luts';
import { addAtmosphereSkyLuts } from './sky-tables';
import { atmosphereStorage, stageAtmospherePublish } from './storage';
import {
  type AtmosphereVisibility,
  atmosphereVisibilityAccesses,
  atmosphereVisibilityDirty,
  atmosphereVisibilityGroup,
  atmosphereVisibilityLayout,
} from './visibility';

type Cluster = Extract<StandardClusterGraphBuffers, { kind: 'texture' }>;
type State = { layout: BindGroupLayout; pipeline: RenderPipeline; sampler: Sampler };

/** The camera key matches the native volume producer, including jitter and capture projection. */
function aerialKey(frame: RenderPipelineFrame): string {
  const camera = frame.camera;
  return JSON.stringify([
    atmosphereStorage(frame).environment.environmentSignature,
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
  ]);
}
function contentDirty(
  content: AtmosphereTextureContent,
  key: string,
  frame: RenderPipelineFrame,
): boolean {
  return content.recordedEncoder === frame.encoder
    ? content.recordedKey !== key
    : content.submittedKey !== key;
}
function publish(content: AtmosphereTextureContent, key: string, frame: RenderPipelineFrame): void {
  content.recordedEncoder = frame.encoder;
  content.recordedKey = key;
  stageAtmospherePublish((frame as _InternalRenderPipelineContext).frameState, () => {
    content.submittedKey = key;
  });
}

/** Full no-storage atmosphere uses the existing integer Cluster transport, without another material texture slot. */
export function addAtmospherePackedLuts(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  clusters: Cluster,
  captureParameters: GraphBuffer,
  captureDirty: (frame: RenderPipelineFrame) => boolean,
  visibility: AtmosphereVisibility,
): Result<GraphAtmosphere, RenderGraphError> {
  const region = clusters.textureLayout.atmosphere;
  if (region === undefined)
    return err(
      new GraphFailure({
        code: 'resource-descriptor-invalid',
        expected: 'a disjoint 50-row atmosphere Cluster footer',
        hint: 'reserve the full atmosphere region in the selected Cluster texture',
        detail: {
          resourceLabel: 'standard-cluster-tables',
          field: 'atmosphere-region',
          expected: '50 rows',
          actual: 'missing',
        },
      }),
    );
  const tables = addAtmosphereSkyLuts(
    graph,
    { parameters: captureParameters, dirty: captureDirty },
    visibility,
  );
  if (!tables.ok) return tables;
  const distant = graph.importTexture(
    'atmosphere-distant-sky-light-fragment',
    { format: 'rgba16float', size: { width: 1, height: 1 }, usage: 0x14 },
    (frame) => atmosphereStorage(frame).distantSkyLight,
  );
  if (!distant.ok) return distant;
  const distantView = graph.view(distant.value, { dimension: '2d' });
  if (!distantView.ok) return distantView;
  const view = graph.importBuffer(
    'atmosphere-packed-view',
    { size: VIEW_UNIFORM_BYTES, usage: 0x48 },
    (frame) => frame.pipelineState.viewUniformBuffer,
  );
  if (!view.ok) return view;
  const mediumKey = (frame: RenderPipelineFrame) =>
    atmosphereStorage(frame).environment.environmentSignature;
  for (const stage of [
    {
      name: 'distant_sky_light',
      target: distantView.value,
      inputs: [tables.value.transmittance, tables.value.multipleScattering],
      parameters: captureParameters,
      packed: false,
      aerial: false,
    },
    {
      name: 'packed_medium',
      target: clusters.texture,
      inputs: [tables.value.transmittance, tables.value.multipleScattering, distantView.value],
      parameters: captureParameters,
      packed: true,
      aerial: false,
    },
    {
      name: 'packed_aerial',
      target: clusters.texture,
      inputs: [tables.value.transmittance, tables.value.multipleScattering],
      parameters: view.value,
      packed: true,
      aerial: true,
    },
  ] as const) {
    let state: State | undefined;
    const localVisibility = stage.aerial ? visibility : {};
    const content = (frame: RenderPipelineFrame) =>
      clusters.resolve(frame).atmosphereContent[stage.aerial ? 'aerial' : 'medium'];
    const key = stage.aerial ? aerialKey : mediumKey;
    const added = graph.addRasterPass(`atmosphere-${stage.name.replaceAll('_', '-')}-fragment`, {
      accesses: [
        ...atmosphereVisibilityAccesses(localVisibility),
        { resource: stage.parameters, usage: 'uniform-read' },
        ...stage.inputs.map((resource) => ({ resource, usage: 'sampled-read' as const })),
        { resource: stage.target, usage: 'color-attachment' },
      ],
      colorAttachments: [
        { view: stage.target, loadOp: stage.packed ? 'load' : 'clear', storeOp: 'store' },
      ],
      executeIf:
        stage.name === 'distant_sky_light'
          ? captureDirty
          : (frame) =>
              (!stage.aerial ||
                (frame as _InternalRenderPipelineContext).capturedAtmosphere === undefined) &&
              (atmosphereVisibilityDirty(frame, localVisibility) ||
                contentDirty(content(frame), key(frame), frame)),
      encodeDirect: (pass, frame, resources) => {
        const device = frame.runtime.device;
        if (state === undefined) {
          const source = frame.atmosphereShaders?.lutsFragment;
          const factory = frame.runtime.shaderModuleFactory;
          if (source === undefined || factory === undefined)
            throw new RhiError({
              code: 'shader-compile-failed',
              expected: 'published full atmosphere fragment kernels',
              hint: 'rebuild the engine shader manifest',
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
                ...stage.inputs.map((_, index) => ({
                  binding: index === 2 ? 4 : index + 1,
                  visibility: 2,
                  texture: { sampleType: 'float' as const, viewDimension: '2d' as const },
                })),
                ...(stage.name === 'packed_medium'
                  ? []
                  : [{ binding: 3, visibility: 2, sampler: { type: 'filtering' as const } }]),
              ],
            })
            .unwrap();
          const pipeline = device
            .createRenderPipeline({
              label: `atmosphere_${stage.name}_fragment`,
              layout: device
                .createPipelineLayout({
                  bindGroupLayouts: [
                    layout,
                    ...(stage.name === 'packed_medium' ? [] : [atmosphereVisibilityLayout(device)]),
                  ],
                })
                .unwrap(),
              vertex: { module, entryPoint: 'atmosphere_tables_vs', buffers: [] },
              fragment: {
                module,
                entryPoint: `atmosphere_${stage.name}_fragment`,
                targets: [{ format: stage.packed ? 'rgba32uint' : 'rgba16float' }],
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
        const buffer = resources.buffer(stage.parameters).unwrap();
        const group = device
          .createBindGroup({
            layout: state.layout,
            entries: [
              {
                binding: 0,
                resource: { kind: 'buffer', value: { buffer, size: VIEW_UNIFORM_BYTES } },
              },
              ...stage.inputs.map((input, index) => ({
                binding: index === 2 ? 4 : index + 1,
                resource: {
                  kind: 'textureView' as const,
                  value: resources.textureView(input).unwrap(),
                },
              })),
              ...(stage.name === 'packed_medium'
                ? []
                : [{ binding: 3, resource: { kind: 'sampler' as const, value: state.sampler } }]),
            ],
          })
          .unwrap();
        pass.setPipeline(state.pipeline);
        pass.setBindGroup(0, group);
        if (stage.name !== 'packed_medium')
          pass.setBindGroup(
            1,
            atmosphereVisibilityGroup(
              frame,
              buffer,
              0,
              visibility.directional === undefined
                ? undefined
                : resources.textureView(visibility.directional).unwrap(),
              visibility.cloud === undefined
                ? undefined
                : resources.textureView(visibility.cloud).unwrap(),
            ),
          );
        if (stage.packed) {
          const y = region.originY + (stage.aerial ? 18 : 0);
          const height = stage.aerial ? 32 : 18;
          pass.setViewport(0, y, 1024, height, 0, 1);
          pass.setScissorRect(0, y, 1024, height);
        }
        pass.draw(3);
        if (stage.packed) publish(content(frame), key(frame), frame);
      },
    });
    if (!added.ok) return added;
  }
  return ok({
    ...tables.value,
    execution: 'fragment-cluster',
    visibility,
    distantSkyLight: distantView.value,
    packed: clusters.texture,
  });
}
