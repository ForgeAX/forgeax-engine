import type {
  Buffer,
  RhiDevice,
  RhiRenderPassEncoder,
  ShaderModule,
  TextureView,
} from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { RAY_ACCUMULATION_STRIDE } from './path-tracer';
import { rayReferenceFailure } from './scene';

/** One raster frame's G-buffer, response and the matching world radiance. */
export interface RayReflectionCompositeInputs {
  /** Raw 80-byte transport accumulation; the field signal binds `reconstructed` only. */
  readonly accumulation?: Buffer;
  /** 16-byte signal: reconstructed transport or the field lane's radiance-cache signal. */
  readonly reconstructed?: Buffer;
  readonly depth: TextureView;
  readonly normal: TextureView;
  readonly response: TextureView;
}

const ADDITIVE = {
  format: 'rgba16float' as const,
  blend: {
    color: { srcFactor: 'one' as const, dstFactor: 'one' as const, operation: 'add' as const },
    alpha: { srcFactor: 'zero' as const, dstFactor: 'one' as const, operation: 'add' as const },
  },
};

/** Adds world specular into linear HDR and the SSR-replaceable reflection fallback. */
export function createRayReflectionComposite(
  device: RhiDevice,
  module: ShaderModule,
  signal: 'raw' | 'reconstructed' | 'field',
) {
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: 2, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: 2, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: 2, texture: { sampleType: 'depth' } },
      { binding: 3, visibility: 2, texture: { sampleType: 'uint' } },
      { binding: 4, visibility: 2, texture: { sampleType: 'unfilterable-float' } },
    ],
  });
  if (!layout.ok) return layout;
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout.value] });
  if (!pipelineLayout.ok) return pipelineLayout;
  const pipeline = device.createRenderPipeline({
    label: 'ray-reflection.composite',
    layout: pipelineLayout.value,
    vertex: { module, entryPoint: 'vs_ray_reflection', buffers: [] },
    fragment: {
      module,
      entryPoint:
        signal === 'raw'
          ? 'fs_ray_reflection'
          : signal === 'field'
            ? 'fs_ray_reflection_field'
            : 'fs_ray_reflection_reconstructed',
      targets: [ADDITIVE, ADDITIVE],
    },
    primitive: { topology: 'triangle-list' },
  });
  if (!pipeline.ok) return pipeline;
  return ok({
    record(pass: RhiRenderPassEncoder, input: RayReflectionCompositeInputs, pixelCount: number) {
      if (
        !Number.isInteger(pixelCount) ||
        pixelCount < 1 ||
        (signal !== 'field' &&
          !(pixelCount * RAY_ACCUMULATION_STRIDE <= device.limits.maxStorageBufferBindingSize)) ||
        (signal !== 'raw') !== (input.reconstructed !== undefined) ||
        (signal !== 'field') !== (input.accumulation !== undefined)
      )
        return rayReferenceFailure(
          'expected a positive reflection receiver count and the signal matching the composite',
          true,
        );
      const filtered =
        input.reconstructed === undefined
          ? undefined
          : { buffer: input.reconstructed, size: pixelCount * 16 };
      // The field entry reads only binding 1; binding 0 aliases it to satisfy the layout.
      const raw =
        input.accumulation === undefined
          ? filtered
          : { buffer: input.accumulation, size: pixelCount * RAY_ACCUMULATION_STRIDE };
      if (raw === undefined) return rayReferenceFailure('missing reflection signal', true);
      const bindings = device.createBindGroup({
        layout: layout.value,
        entries: [
          { binding: 0, resource: { kind: 'buffer', value: raw } },
          {
            binding: 1,
            resource: {
              kind: 'buffer',
              value: filtered ?? raw,
            },
          },
          ...[input.depth, input.normal, input.response].map((value, i) => ({
            binding: i + 2,
            resource: { kind: 'textureView' as const, value },
          })),
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
