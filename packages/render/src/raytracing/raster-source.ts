import type {
  Buffer,
  RhiBindingResource,
  RhiComputePassEncoder,
  RhiDevice,
  RhiError,
  ShaderModule,
  TextureView,
} from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import { RAY_PATH_STRIDE } from './path-tracer';
import { type RayReferenceError, rayReferenceFailure } from './scene';

/** Attachments, rows and View must belong to one submitted raster frame. */
export interface RasterRayInputs {
  readonly depth: TextureView;
  readonly normal: TextureView;
  readonly identity: TextureView;
  /** Exact submitted row range; spare capacity must never validate an old row. */
  readonly records: { readonly buffer: Buffer; readonly size: number };
  readonly view: Extract<RhiBindingResource, { kind: 'buffer' }>['value'];
  /** 16-byte seed/sample-index uniform from the same frame owner. */
  readonly sample: Buffer;
  /** Borrowed output: one 80-byte initial PathState per source texel. */
  readonly rays: Buffer;
}

/** Unit-Lambert receiver rays produce D = E/pi independently of receiver albedo;
 * `generateReflectionRays` produces the Lite reflection lobe from the same receivers.
 * A record operation only: the caller owns graph resources, passes and submission. */
export function createRasterRayGenerator(
  device: RhiDevice,
  module: ShaderModule,
  entryPoint: 'generateRasterRays' | 'generateReflectionRays' = 'generateRasterRays',
) {
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: 4, texture: { sampleType: 'depth' } },
      ...[1, 2].map((binding) => ({
        binding,
        visibility: 4,
        texture: { sampleType: 'uint' as const },
      })),
      { binding: 3, visibility: 4, buffer: { type: 'read-only-storage' } },
      { binding: 4, visibility: 4, buffer: { type: 'uniform' } },
      { binding: 5, visibility: 4, buffer: { type: 'uniform' } },
      { binding: 6, visibility: 4, buffer: { type: 'storage' } },
    ],
  });
  if (!layout.ok) return layout;
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout.value] });
  if (!pipelineLayout.ok) return pipelineLayout;
  const pipeline = device.createComputePipeline({
    label: `ray-raster.${entryPoint}`,
    layout: pipelineLayout.value,
    compute: { module, entryPoint },
  });
  if (!pipeline.ok) return pipeline;
  return ok({
    record(
      pass: RhiComputePassEncoder,
      input: RasterRayInputs,
      pixelCount: number,
    ): Result<void, RhiError | RayReferenceError> {
      if (!Number.isInteger(pixelCount) || pixelCount < 1 || pixelCount > 262144)
        return rayReferenceFailure('expected 1..262144 raster receiver texels', true);
      if (
        !Number.isSafeInteger(input.records.size) ||
        input.records.size < 64 ||
        input.records.size % 64 !== 0
      )
        return rayReferenceFailure('expected a nonempty exact range of 64-byte frame rows', true);
      const bindings = device.createBindGroup({
        layout: layout.value,
        entries: [
          ...[input.depth, input.normal, input.identity].map((value, binding) => ({
            binding,
            resource: { kind: 'textureView' as const, value },
          })),
          { binding: 3, resource: { kind: 'buffer', value: input.records } },
          { binding: 4, resource: { kind: 'buffer', value: input.view } },
          { binding: 5, resource: { kind: 'buffer', value: { buffer: input.sample, size: 16 } } },
          {
            binding: 6,
            resource: {
              kind: 'buffer',
              value: { buffer: input.rays, size: pixelCount * RAY_PATH_STRIDE },
            },
          },
        ],
      });
      if (!bindings.ok) return bindings;
      pass.setPipeline(pipeline.value);
      pass.setBindGroup(0, bindings.value);
      pass.dispatchWorkgroups(Math.ceil(pixelCount / 64));
      return ok(undefined);
    },
  });
}
