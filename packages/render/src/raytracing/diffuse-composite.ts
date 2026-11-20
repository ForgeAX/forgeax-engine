import type {
  Buffer,
  RhiBindingResource,
  RhiDevice,
  RhiRenderPassEncoder,
  ShaderModule,
  TextureView,
} from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { STANDARD_GBUFFER_COMPACT_PIPELINE_CONSTANTS } from '../standard-attachments';
import { RAY_ACCUMULATION_STRIDE } from './path-tracer';
import { rayReferenceFailure } from './scene';

/** One raster frame's attachments and the matching raw unit-receiver D. */
interface RayDiffuseCompositeInputs {
  readonly irradiance: Buffer;
  readonly depth: TextureView;
  readonly normal: TextureView;
  readonly albedoMetallic: TextureView;
  readonly dielectricSpecular: TextureView;
  readonly reflectionResponse?: TextureView;
  readonly compactGbuffer?: true;
  readonly subsurface?: true;
  readonly view: Extract<RhiBindingResource, { kind: 'buffer' }>['value'];
}

/** Record into the caller's linear HDR pass; never owns submission or scene color.
 * The graph owner declares every borrowed read and retires inputs after completion. */
export function createRayDiffuseComposite(
  device: RhiDevice,
  module: ShaderModule,
  signal: 'raw' | 'reconstructed',
) {
  const createPipeline = (reflections: boolean, compact: boolean, subsurface: boolean) => {
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
        ...(reflections
          ? [{ binding: 6, visibility: 2, texture: { sampleType: 'float' as const } }]
          : []),
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
        entryPoint: `${signal === 'raw' ? 'fs_ray_diffuse' : 'fs_ray_diffuse_reconstructed'}${reflections ? '_reflections' : ''}`,
        ...(compact ? { constants: STANDARD_GBUFFER_COMPACT_PIPELINE_CONSTANTS } : {}),
        targets: Array.from({ length: subsurface ? 2 : 1 }, () => ({
          format: 'rgba16float' as const,
          blend: {
            color: {
              srcFactor: 'one' as const,
              dstFactor: 'one' as const,
              operation: 'add' as const,
            },
            alpha: {
              srcFactor: 'zero' as const,
              dstFactor: 'one' as const,
              operation: 'add' as const,
            },
          },
        })),
      },
      primitive: { topology: 'triangle-list' },
    });
    if (!pipeline.ok) return pipeline;
    return ok({ layout: layout.value, pipeline: pipeline.value });
  };
  const base = createPipeline(false, false, false);
  if (!base.ok) return base;
  const variants = new Map<number, ReturnType<typeof createPipeline>>();
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
      let selected = base.value;
      const reflections = input.reflectionResponse !== undefined;
      const compact = input.compactGbuffer === true;
      if (reflections || compact) {
        const subsurface = input.subsurface === true;
        const key = Number(reflections) + 2 * Number(compact) + 4 * Number(subsurface);
        let variant = variants.get(key);
        if (variant === undefined) {
          variant = createPipeline(reflections, compact, subsurface);
          if (variant.ok) variants.set(key, variant);
        }
        if (!variant.ok) return variant;
        selected = variant.value;
      }
      const bindings = device.createBindGroup({
        layout: selected.layout,
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
          ...[input.depth, input.normal, input.albedoMetallic, input.dielectricSpecular].map(
            (value, i) => ({
              binding: i + 1,
              resource: { kind: 'textureView' as const, value },
            }),
          ),
          { binding: 5, resource: { kind: 'buffer', value: input.view } },
          ...(input.reflectionResponse === undefined
            ? []
            : [
                {
                  binding: 6,
                  resource: { kind: 'textureView' as const, value: input.reflectionResponse },
                },
              ]),
        ],
      });
      if (!bindings.ok) return bindings;
      pass.setPipeline(selected.pipeline);
      pass.setBindGroup(0, bindings.value);
      pass.draw(3);
      return ok(undefined);
    },
  });
}
