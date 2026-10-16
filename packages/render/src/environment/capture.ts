import type {
  BindGroupLayout,
  RenderPipeline,
  RhiDevice,
  RhiRenderPassEncoder,
  Sampler,
  TextureFormat,
  TextureView,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import type { RenderPipelineFrame } from '../render-pipeline';
import { createAtmosphereBackgroundGroup, createAtmosphereBackgroundLayout } from './background';
import { atmosphereVisibilityGroup, atmosphereVisibilityLayout } from './visibility';

interface State {
  readonly layout: BindGroupLayout;
  readonly pipeline: RenderPipeline;
  readonly sampler: Sampler;
}
const states = new WeakMap<RhiDevice, Map<TextureFormat, State>>();
/** Captures evaluate the shared kernel at the frozen capture origin and sun. */
export function recordAtmosphereCaptureBackground(
  frame: RenderPipelineFrame,
  pass: RhiRenderPassEncoder,
  format: TextureFormat,
  viewOffset: number,
  sky: TextureView,
  transmittance: TextureView,
  multiple: TextureView,
  directional?: TextureView,
): void {
  const device = frame.runtime.device;
  let formats = states.get(device);
  if (formats === undefined) {
    formats = new Map();
    states.set(device, formats);
  }
  let state = formats.get(format);
  if (state === undefined) {
    const source = frame.atmosphereShaders?.background;
    const factory = frame.runtime.shaderModuleFactory;
    if (source === undefined || factory === undefined)
      throw new RhiError({
        code: 'shader-compile-failed',
        expected: 'atmosphere capture background',
        hint: 'rebuild the engine shader manifest',
      });
    const module = factory
      .createShaderModule({ code: source, label: 'atmosphere_background' })
      .unwrap();
    const layout = createAtmosphereBackgroundLayout(device);
    const pipeline = device
      .createRenderPipeline({
        label: 'atmosphere-capture-background',
        layout: device
          .createPipelineLayout({ bindGroupLayouts: [layout, atmosphereVisibilityLayout(device)] })
          .unwrap(),
        vertex: { module, entryPoint: 'atmosphere_background_vs', buffers: [] },
        fragment: { module, entryPoint: 'atmosphere_background_fs', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
        depthStencil: {
          format: 'depth32float-stencil8',
          depthWriteEnabled: false,
          depthCompare: 'always',
        },
      })
      .unwrap();
    state = {
      layout,
      pipeline,
      sampler: device.createSampler({ minFilter: 'linear', magFilter: 'linear' }).unwrap(),
    };
    formats.set(format, state);
  }
  const group = createAtmosphereBackgroundGroup(device, state.layout, {
    sky,
    sampler: state.sampler,
    viewBuffer: frame.pipelineState.viewUniformBuffer,
    viewOffset,
    transmittance,
    multiple,
  });
  pass.setPipeline(state.pipeline);
  pass.setBindGroup(0, group);
  pass.setBindGroup(
    1,
    atmosphereVisibilityGroup(
      frame,
      frame.pipelineState.viewUniformBuffer,
      viewOffset,
      directional,
    ),
  );
  pass.draw(3);
}
