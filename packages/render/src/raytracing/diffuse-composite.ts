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
type RayDiffuseCompositeInputs = {
  readonly irradiance: Buffer;
  readonly depth: TextureView;
  readonly normal: TextureView;
  readonly compactGbuffer?: true;
} & (
  | { readonly baseline: Buffer; readonly subsurface: boolean }
  | {
      readonly baseline?: undefined;
      readonly albedoMetallic: TextureView;
      readonly dielectricSpecular: TextureView;
      readonly reflectionResponse?: TextureView;
      readonly view: Extract<RhiBindingResource, { kind: 'buffer' }>['value'];
    }
);

/** Record into the caller's linear HDR pass; never owns submission or scene color.
 * The graph owner declares every borrowed read and retires inputs after completion. */
export function createRayDiffuseComposite(
  device: RhiDevice,
  module: ShaderModule,
  signal: 'raw' | 'reconstructed',
) {
  const createPipeline = (
    mode: 'add' | 'reflections' | 'replace' | 'replace_subsurface',
    compact: boolean,
  ) => {
    const replacement = mode === 'replace' || mode === 'replace_subsurface';
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 2, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: 2, texture: { sampleType: 'depth' } },
        ...(replacement ? [2] : [2, 3, 4]).map((binding) => ({
          binding,
          visibility: 2,
          texture: { sampleType: 'uint' as const },
        })),
        ...(replacement
          ? [{ binding: 7, visibility: 2, buffer: { type: 'read-only-storage' as const } }]
          : [{ binding: 5, visibility: 2, buffer: { type: 'uniform' as const } }]),
        ...(mode === 'reflections'
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
        entryPoint: `${signal === 'raw' ? 'fs_ray_diffuse' : 'fs_ray_diffuse_reconstructed'}${mode === 'add' ? '' : `_${mode}`}`,
        ...(compact && !replacement
          ? { constants: STANDARD_GBUFFER_COMPACT_PIPELINE_CONSTANTS }
          : {}),
        targets: Array.from({ length: mode === 'replace_subsurface' ? 2 : 1 }, () => ({
          format: 'rgba16float',
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
          },
        })),
      },
      primitive: { topology: 'triangle-list' },
    });
    if (!pipeline.ok) return pipeline;
    return ok({ layout: layout.value, pipeline: pipeline.value });
  };
  const pipelines = new Map<string, ReturnType<typeof createPipeline>>();
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
      const mode =
        input.baseline !== undefined
          ? input.subsurface === true
            ? 'replace_subsurface'
            : 'replace'
          : input.reflectionResponse !== undefined
            ? 'reflections'
            : 'add';
      const compact = input.compactGbuffer === true;
      const key = `${mode}:${compact}`;
      let pipeline = pipelines.get(key);
      if (pipeline === undefined) {
        pipeline = createPipeline(mode, compact);
        pipelines.set(key, pipeline);
      }
      if (!pipeline.ok) return pipeline;
      const selected = pipeline.value;
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
          ...(input.baseline === undefined
            ? [input.depth, input.normal, input.albedoMetallic, input.dielectricSpecular]
            : [input.depth, input.normal]
          ).map((value, i) => ({
            binding: i + 1,
            resource: { kind: 'textureView' as const, value },
          })),
          ...(input.baseline === undefined
            ? [{ binding: 5, resource: { kind: 'buffer' as const, value: input.view } }]
            : [
                {
                  binding: 7,
                  resource: { kind: 'buffer' as const, value: { buffer: input.baseline } },
                },
              ]),
          ...(input.baseline !== undefined || input.reflectionResponse === undefined
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
