import type {
  Buffer,
  RhiBindingResource,
  RhiDevice,
  RhiRenderPassEncoder,
  ShaderModule,
  TextureView,
} from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { RAY_ACCUMULATION_STRIDE } from './path-tracer';
import { rayReferenceFailure } from './scene';

/** One raster frame's attachments and the matching raw unit-receiver D. */
export interface RayDiffuseCompositeInputs {
  readonly irradiance: Buffer;
  readonly depth: TextureView;
  readonly normal: TextureView;
  readonly albedoMetallic: TextureView;
  readonly f0Occlusion: TextureView;
  readonly view: Extract<RhiBindingResource, { kind: 'buffer' }>['value'];
}

/** Record into the caller's linear HDR pass; never owns submission or scene color.
 * The graph owner declares every borrowed read and retires inputs after completion. */
export function createRayDiffuseComposite(
  device: RhiDevice,
  module: ShaderModule,
  signal: 'raw' | 'reconstructed',
) {
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: 2, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: 2, texture: { sampleType: 'depth' } },
      ...[2, 3, 4].map((binding) => ({
        binding,
        visibility: 2,
        texture: { sampleType: 'uint' as const },
      })),
      { binding: 5, visibility: 2, buffer: { type: 'uniform' } },
    ],
  });
  if (!layout.ok) return layout;
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout.value] });
  if (!pipelineLayout.ok) return pipelineLayout;
  const pipeline = device.createRenderPipeline({
    label: 'ray-diffuse.composite',
    layout: pipelineLayout.value,
    vertex: { module, entryPoint: 'vs_ray_diffuse', buffers: [] },
    fragment: {
      module,
      entryPoint: signal === 'raw' ? 'fs_ray_diffuse' : 'fs_ray_diffuse_reconstructed',
      targets: [
        {
          format: 'rgba16float',
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
          },
        },
      ],
    },
    primitive: { topology: 'triangle-list' },
  });
  if (!pipeline.ok) return pipeline;
  return ok({
    record(pass: RhiRenderPassEncoder, input: RayDiffuseCompositeInputs, pixelCount: number) {
      const stride = signal === 'raw' ? RAY_ACCUMULATION_STRIDE : 16;
      if (
        !Number.isInteger(pixelCount) ||
        pixelCount < 1 ||
        !(pixelCount * stride <= device.limits.maxStorageBufferBindingSize)
      )
        return rayReferenceFailure(
          'expected a positive diffuse receiver count within the storage binding limit',
          true,
        );
      const bindings = device.createBindGroup({
        layout: layout.value,
        entries: [
          {
            binding: 0,
            resource: {
              kind: 'buffer',
              value: {
                buffer: input.irradiance,
                size: pixelCount * stride,
              },
            },
          },
          ...[input.depth, input.normal, input.albedoMetallic, input.f0Occlusion].map(
            (value, i) => ({
              binding: i + 1,
              resource: { kind: 'textureView' as const, value },
            }),
          ),
          { binding: 5, resource: { kind: 'buffer', value: input.view } },
        ],
      });
      if (!bindings.ok) return bindings;
      pass.setPipeline(pipeline.value);
      pass.setBindGroup(0, bindings.value);
      pass.draw(3);
      return ok(undefined);
    },
  });
}
