import type { GraphTextureView } from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  RhiDevice,
  TextureView,
} from '@forgeax/engine-rhi';
import type { PipelineState } from '../record/render-context';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { RenderPipelineFrame } from '../render-pipeline';

export interface AtmosphereVisibility {
  readonly directional?: GraphTextureView | undefined;
  readonly cloud?: GraphTextureView | undefined;
}
const layouts = new WeakMap<RhiDevice, BindGroupLayout>();
/** Utility programs share the same visibility inputs as the material View. */
export function atmosphereVisibilityLayout(device: RhiDevice): BindGroupLayout {
  let layout = layouts.get(device);
  if (layout === undefined) {
    layout = device
      .createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: 6,
            texture: { sampleType: 'depth', viewDimension: '2d-array' },
          },
          { binding: 1, visibility: 6, sampler: { type: 'comparison' } },
          { binding: 2, visibility: 6, texture: { sampleType: 'float', viewDimension: '2d' } },
          { binding: 3, visibility: 6, sampler: { type: 'filtering' } },
          {
            binding: 4,
            visibility: 6,
            buffer: { type: 'uniform', minBindingSize: VIEW_UNIFORM_BYTES },
          },
        ],
      })
      .unwrap();
    layouts.set(device, layout);
  }
  return layout;
}
export function atmosphereVisibilityGroup(
  frame: RenderPipelineFrame,
  buffer: Buffer,
  offset: number,
  directional?: TextureView,
  cloud?: TextureView,
): BindGroup {
  const state = frame.pipelineState as PipelineState;
  const comparison = state.perPassResources.shadowSampler;
  if (comparison === null) throw new Error('Atmosphere requires the admitted comparison sampler');
  return frame.runtime.device
    .createBindGroup({
      layout: atmosphereVisibilityLayout(frame.runtime.device),
      entries: [
        {
          binding: 0,
          resource: {
            kind: 'textureView',
            value: directional ?? state.shadowArrayFallbackTextureView,
          },
        },
        { binding: 1, resource: { kind: 'sampler', value: comparison } },
        {
          binding: 2,
          resource: { kind: 'textureView', value: cloud ?? state.defaultWhiteTextureView },
        },
        {
          binding: 3,
          resource: { kind: 'sampler', value: state.viewLinearSampler ?? state.defaultSampler },
        },
        {
          binding: 4,
          resource: { kind: 'buffer', value: { buffer, offset, size: VIEW_UNIFORM_BYTES } },
        },
      ],
    })
    .unwrap();
}
export function atmosphereVisibilityAccesses(visibility: AtmosphereVisibility) {
  return [visibility.directional, visibility.cloud]
    .filter((v): v is GraphTextureView => v !== undefined)
    .map((resource) => ({ resource, usage: 'sampled-read' as const }));
}
