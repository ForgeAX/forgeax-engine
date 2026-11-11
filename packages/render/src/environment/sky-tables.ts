import type {
  GraphBuffer,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import {
  type BindGroupLayout,
  type RenderPipeline,
  RhiError,
  type Sampler,
} from '@forgeax/engine-rhi';
import { ok, type Result, shaderSourceDescriptor } from '@forgeax/engine-types';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { GraphAtmosphereTables } from './luts';
import { atmosphereMediumKey, atmosphereStorage, stageAtmospherePublish } from './storage';
import {
  type AtmosphereVisibility,
  atmosphereVisibilityAccesses,
  atmosphereVisibilityDirty,
  atmosphereVisibilityGroup,
  atmosphereVisibilityLayout,
} from './visibility';

type State = { layout: BindGroupLayout; pipeline: RenderPipeline; sampler: Sampler };

/** Optional capture storage belongs to the existing atmosphere generation. */
function importCaptureSky(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  enabled: boolean,
): Result<GraphTextureView | undefined, RenderGraphError> {
  if (!enabled) return ok(undefined);
  const capture = graph.importTexture(
    'atmosphere-capture-sky',
    { format: 'rgba16float', size: { width: 192, height: 208 }, usage: 0x14 },
    (frame) => atmosphereStorage(frame).captureSky,
  );
  if (!capture.ok) return capture;
  return graph.view(capture.value, { dimension: '2d' });
}

/** Two-dimensional atmosphere tables share the optical kernels and generation owner. */
export function addAtmosphereSkyLuts(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  captureInput?: {
    readonly parameters: GraphBuffer;
    readonly dirty: (frame: RenderPipelineFrame) => boolean;
  },
  visibility: AtmosphereVisibility = {},
): Result<GraphAtmosphereTables, RenderGraphError> {
  const view = graph.importBuffer(
    'atmosphere-sky-view-parameters',
    { size: VIEW_UNIFORM_BYTES, usage: 0x48 },
    (frame) => frame.pipelineState.viewUniformBuffer,
  );
  if (!view.ok) return view;
  const trans = graph.importTexture(
    'atmosphere-sky-transmittance',
    { format: 'rgba16float', size: { width: 256, height: 64 }, usage: 0x14 },
    (frame) => atmosphereStorage(frame).transmittance,
  );
  if (!trans.ok) return trans;
  const transView = graph.view(trans.value, { dimension: '2d' });
  if (!transView.ok) return transView;
  const multi = graph.importTexture(
    'atmosphere-sky-multiple-scattering',
    { format: 'rgba16float', size: { width: 32, height: 32 }, usage: 0x14 },
    (frame) => atmosphereStorage(frame).multipleScattering,
  );
  if (!multi.ok) return multi;
  const multiView = graph.view(multi.value, { dimension: '2d' });
  if (!multiView.ok) return multiView;
  const sky = graph.createTexture('atmosphere-sky-background-table', {
    format: 'rgba16float',
    size: { width: 192, height: 208 },
    usage: 0x14,
  });
  if (!sky.ok) return sky;
  const skyView = graph.view(sky.value, { dimension: '2d' });
  if (!skyView.ok) return skyView;
  const captureResult = importCaptureSky(graph, captureInput !== undefined);
  if (!captureResult.ok) return captureResult;
  const captureView = captureResult.value;
  const mediumDirty = (frame: RenderPipelineFrame) => {
    const storage = atmosphereStorage(frame);
    return (
      storage.submittedMedium !== atmosphereMediumKey(storage.environment) &&
      storage.recordedMediumEncoder !== frame.encoder
    );
  };
  for (const stage of [
    { name: 'transmittance', target: transView.value, inputs: [], captured: false, visibility: {} },
    {
      name: 'multiple_scattering',
      target: multiView.value,
      inputs: [transView.value],
      captured: false,
      visibility: {},
    },
    {
      name: 'sky_view',
      target: skyView.value,
      inputs: [transView.value, multiView.value],
      captured: false,
      visibility,
    },
    ...(captureView === undefined
      ? []
      : [
          {
            name: 'sky_view' as const,
            target: captureView,
            inputs: [transView.value, multiView.value],
            captured: true,
            visibility: {},
          },
        ]),
  ] as const) {
    let state: State | undefined;
    let submittedSkyKey: string | undefined;
    const skyKey = (frame: RenderPipelineFrame) =>
      JSON.stringify([
        atmosphereStorage(frame).environment.environmentSignature,
        Array.from(frame.camera.position),
      ]);
    const parameters =
      stage.captured && captureInput !== undefined ? captureInput.parameters : view.value;
    const localVisibility: AtmosphereVisibility = stage.visibility;
    const label = stage.captured ? 'capture-sky-view' : stage.name.replaceAll('_', '-');
    const added = graph.addRasterPass(`atmosphere-${label}-fragment`, {
      accesses: [
        ...atmosphereVisibilityAccesses(localVisibility),
        { resource: parameters, usage: 'uniform-read' },
        ...stage.inputs.map((resource) => ({ resource, usage: 'sampled-read' as const })),
        { resource: stage.target, usage: 'color-attachment' },
      ],
      colorAttachments: [{ view: stage.target, loadOp: 'clear', storeOp: 'store' }],
      executeIf:
        stage.captured && captureInput !== undefined
          ? captureInput.dirty
          : stage.name === 'sky_view'
            ? (frame: RenderPipelineFrame) =>
                atmosphereVisibilityDirty(frame, localVisibility) ||
                submittedSkyKey !== skyKey(frame)
            : mediumDirty,
      encodeDirect: (pass, frame, resources) => {
        const device = frame.runtime.device;
        if (state === undefined) {
          const source = frame.atmosphereShaders?.lutsFragment;
          const factory = frame.runtime.shaderModuleFactory;
          if (source === undefined || factory === undefined)
            throw new RhiError({
              code: 'shader-compile-failed',
              expected: 'published atmosphere fragment tables',
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
                ...stage.inputs.map((_, i) => ({
                  binding: i + 1,
                  visibility: 2,
                  texture: { sampleType: 'float' as const, viewDimension: '2d' as const },
                })),
                ...(stage.inputs.length
                  ? [{ binding: 3, visibility: 2, sampler: { type: 'filtering' as const } }]
                  : []),
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
                    ...(stage.name === 'sky_view' ? [atmosphereVisibilityLayout(device)] : []),
                  ],
                })
                .unwrap(),
              vertex: { module, entryPoint: 'atmosphere_tables_vs', buffers: [] },
              fragment: {
                module,
                entryPoint: `atmosphere_${stage.name}_fragment`,
                targets: [{ format: 'rgba16float' }],
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
        const buffer = resources.buffer(parameters).unwrap();
        const group = device
          .createBindGroup({
            layout: state.layout,
            entries: [
              {
                binding: 0,
                resource: { kind: 'buffer', value: { buffer, size: VIEW_UNIFORM_BYTES } },
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
            ],
          })
          .unwrap();
        pass.setPipeline(state.pipeline);
        pass.setBindGroup(0, group);
        if (stage.name === 'sky_view')
          pass.setBindGroup(
            1,
            atmosphereVisibilityGroup(
              frame,
              buffer,
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
        if (stage.name === 'sky_view' && !stage.captured) {
          const key = skyKey(frame);
          stageAtmospherePublish((frame as _InternalRenderPipelineContext).frameState, () => {
            submittedSkyKey = key;
          });
        }
        if (stage.name === 'multiple_scattering') {
          const storage = atmosphereStorage(frame);
          const key = atmosphereMediumKey(storage.environment);
          storage.recordedMediumEncoder = frame.encoder;
          stageAtmospherePublish((frame as _InternalRenderPipelineContext).frameState, () => {
            storage.submittedMedium = key;
          });
        }
      },
    });
    if (!added.ok) return added;
  }
  return ok({
    transmittance: transView.value,
    multipleScattering: multiView.value,
    skyView: skyView.value,
    captureSky: captureView ?? skyView.value,
  });
}
