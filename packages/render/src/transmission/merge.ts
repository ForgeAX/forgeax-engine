import type {
  BindGroup,
  BindGroupLayout,
  RenderPipeline,
  RhiRenderPassEncoder,
  TextureView,
} from '@forgeax/engine-rhi';
import { GPU_SHADER_STAGE_FRAGMENT } from '../gpu-stage';
import type { RenderPipelineFrame } from '../render-pipeline';

export const TRANSMISSION_MERGE_LABEL = 'transmission-merge';
export const TRANSMISSION_MERGE_WGSL = /* wgsl */ `
@group(0) @binding(0) var refracted : texture_2d<f32>;

@vertex fn vs_main(@builtin(vertex_index) index : u32) -> @builtin(position) vec4<f32> {
  let x = f32((index << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(index & 2u) * 2.0 - 1.0;
  return vec4<f32>(x, y, 0.0, 1.0);
}

@fragment fn fs_main(@builtin(position) position : vec4<f32>) -> @location(0) vec4<f32> {
  let color = textureLoad(refracted, vec2<i32>(position.xy), 0);
  // Only stock replacement writes use this target. Their output alpha is in [0, 1].
  if (color.a < 0.0) { discard; }
  return color;
}
`;

/** Apply only the pixels written by the separate transmission raster. */
export function transmissionMergeEncoder() {
  let layout: BindGroupLayout | undefined;
  let pipeline: RenderPipeline | undefined;
  const groups = new WeakMap<TextureView, BindGroup>();
  const prepare = (frame: RenderPipelineFrame): boolean => {
    const { device, immediateShaderModuleFactory, shaderModuleFactory } = frame.runtime;
    if (pipeline === undefined || layout === undefined) {
      const factory = immediateShaderModuleFactory ?? shaderModuleFactory;
      if (factory === undefined) return false;
      const result = factory.createShaderModule({
        label: TRANSMISSION_MERGE_LABEL,
        code: TRANSMISSION_MERGE_WGSL,
      });
      if (!result.ok && result.error.code === 'rhi-not-available') return false;
      const module = result.unwrap();
      layout = device
        .createBindGroupLayout({
          label: TRANSMISSION_MERGE_LABEL,
          entries: [
            {
              binding: 0,
              visibility: GPU_SHADER_STAGE_FRAGMENT,
              texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
            },
          ],
        })
        .unwrap();
      pipeline = device
        .createRenderPipeline({
          label: TRANSMISSION_MERGE_LABEL,
          layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
          vertex: { module, entryPoint: 'vs_main', buffers: [] },
          fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba16float' }] },
          primitive: { topology: 'triangle-list' },
        })
        .unwrap();
    }
    return true;
  };
  const encode = (
    pass: RhiRenderPassEncoder,
    frame: RenderPipelineFrame,
    source: TextureView,
  ): void => {
    if (layout === undefined || pipeline === undefined)
      throw new Error('Transmission merge must be prepared');
    const device = frame.runtime.device;
    let group = groups.get(source);
    if (group === undefined) {
      group = device
        .createBindGroup({
          layout,
          entries: [{ binding: 0, resource: { kind: 'textureView', value: source } }],
        })
        .unwrap();
      groups.set(source, group);
    }
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
  };
  return { prepare, encode };
}
