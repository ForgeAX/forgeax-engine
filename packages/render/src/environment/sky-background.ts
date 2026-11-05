import type { RenderGraphBuilder, RenderGraphError } from '@forgeax/engine-render-graph';
import {
  type BindGroupLayout,
  type RenderPipeline,
  RhiError,
  type Sampler,
} from '@forgeax/engine-rhi';
import { ok, type Result, shaderSourceDescriptor } from '@forgeax/engine-types';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../render-pipeline';
import { createAtmosphereBackgroundGroup, createAtmosphereBackgroundLayout } from './background';
import { atmosphereMediumKey, atmosphereStorage, stageAtmospherePublish } from './storage';
import { atmosphereVisibilityGroup, atmosphereVisibilityLayout } from './visibility';

type State = { layout: BindGroupLayout; pipeline: RenderPipeline; sampler: Sampler };

/** Explicit background-only atmosphere. It never publishes material AP or an IBL source. */
export function addAtmosphereSkyBackground(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  color: RenderPipelineTarget,
): Result<void, RenderGraphError> {
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
  const mediumDirty = (frame: RenderPipelineFrame) => {
    const storage = atmosphereStorage(frame);
    return (
      storage.submittedMedium !== atmosphereMediumKey(storage.environment) &&
      storage.recordedMediumEncoder !== frame.encoder
    );
  };
  for (const stage of [
    { name: 'transmittance', target: transView.value, inputs: [] },
    { name: 'multiple_scattering', target: multiView.value, inputs: [transView.value] },
    { name: 'sky_view', target: skyView.value, inputs: [transView.value, multiView.value] },
  ] as const) {
    let state: State | undefined;
    let submittedSkyKey: string | undefined;
    const skyKey = (frame: RenderPipelineFrame) =>
      JSON.stringify([
        atmosphereStorage(frame).environment.environmentSignature,
        Array.from(frame.camera.position),
      ]);
    const added = graph.addRasterPass(`atmosphere-${stage.name.replaceAll('_', '-')}-fragment`, {
      accesses: [
        { resource: view.value, usage: 'uniform-read' },
        ...stage.inputs.map((resource) => ({ resource, usage: 'sampled-read' as const })),
        { resource: stage.target, usage: 'color-attachment' },
      ],
      colorAttachments: [{ view: stage.target, loadOp: 'clear', storeOp: 'store' }],
      executeIf:
        stage.name === 'sky_view'
          ? (frame: RenderPipelineFrame) => submittedSkyKey !== skyKey(frame)
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
        const buffer = resources.buffer(view.value).unwrap();
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
          pass.setBindGroup(1, atmosphereVisibilityGroup(frame, buffer, 0));
        pass.draw(3);
        if (stage.name === 'sky_view') {
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
  let state: State | undefined;
  const background = graph.addRasterPass('atmosphere-sky-background', {
    accesses: [
      { resource: view.value, usage: 'uniform-read' },
      ...[skyView.value, transView.value, multiView.value].map((resource) => ({
        resource,
        usage: 'sampled-read' as const,
      })),
      { resource: color.view, usage: 'color-attachment' },
    ],
    colorAttachments: [{ view: color.view, loadOp: 'clear', storeOp: 'store' }],
    encodeDirect: (pass, frame, resources) => {
      const device = frame.runtime.device;
      if (state === undefined) {
        const source = frame.atmosphereShaders?.background;
        const factory = frame.runtime.shaderModuleFactory;
        if (source === undefined || factory === undefined)
          throw new RhiError({
            code: 'shader-compile-failed',
            expected: 'published physical sky background',
            hint: 'rebuild the engine shader manifest',
          });
        const module = factory
          .createShaderModule(shaderSourceDescriptor(source, 'atmosphere_background'))
          .unwrap();
        const layout = createAtmosphereBackgroundLayout(device);
        const pipeline = device
          .createRenderPipeline({
            label: 'atmosphere_sky_background',
            layout: device
              .createPipelineLayout({
                bindGroupLayouts: [layout, atmosphereVisibilityLayout(device)],
              })
              .unwrap(),
            vertex: { module, entryPoint: 'atmosphere_background_vs', buffers: [] },
            fragment: {
              module,
              entryPoint: 'atmosphere_background_fs',
              targets: [{ format: color.format }],
            },
            primitive: { topology: 'triangle-list' },
            multisample: { count: color.sampleCount },
          })
          .unwrap();
        state = {
          layout,
          pipeline,
          sampler: device.createSampler({ minFilter: 'linear', magFilter: 'linear' }).unwrap(),
        };
      }
      const buffer = resources.buffer(view.value).unwrap();
      const group = createAtmosphereBackgroundGroup(device, state.layout, {
        sky: resources.textureView(skyView.value).unwrap(),
        sampler: state.sampler,
        viewBuffer: buffer,
        viewOffset: 0,
        transmittance: resources.textureView(transView.value).unwrap(),
        multiple: resources.textureView(multiView.value).unwrap(),
      });
      pass.setPipeline(state.pipeline);
      pass.setBindGroup(0, group);
      pass.setBindGroup(1, atmosphereVisibilityGroup(frame, buffer, 0));
      pass.draw(3);
    },
  });
  return background.ok ? ok(undefined) : background;
}
