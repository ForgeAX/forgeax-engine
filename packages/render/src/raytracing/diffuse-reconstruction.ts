import type {
  Buffer,
  RhiBindingResource,
  RhiComputePassEncoder,
  RhiDevice,
  ShaderModule,
  TextureView,
} from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { RAY_ACCUMULATION_STRIDE } from './path-tracer';
import { rayReferenceFailure } from './scene';

/** GPU history, not raw ray accumulators. Layout is DiffuseHistoryPixel in WGSL. */
export const DIFFUSE_HISTORY_BYTES = 96;
export const DIFFUSE_SIGNAL_BYTES = 16;
export const DIFFUSE_RECONSTRUCTION_UNIFORM_BYTES = 48;

export interface DiffuseReconstructionInputs {
  readonly raw: Buffer;
  readonly records: Extract<RhiBindingResource, { kind: 'buffer' }>['value'];
  readonly previous: Buffer;
  readonly current: Buffer;
  readonly signal: Buffer;
  readonly diagnostics: Buffer;
  readonly depth: TextureView;
  readonly normal: TextureView;
  readonly identity: TextureView;
  readonly motion: TextureView;
  readonly view: Extract<RhiBindingResource, { kind: 'buffer' }>['value'];
  readonly config: Buffer;
}

/** Record-only kernels. The Renderer owns history admission, publication and retirement. */
export function createDiffuseReconstruction(device: RhiDevice, module: ShaderModule) {
  const layout = device.createBindGroupLayout({
    entries: [
      ...[0, 1, 2].map((binding) => ({
        binding,
        visibility: 4,
        buffer: { type: 'read-only-storage' as const },
      })),
      ...[3, 4, 11].map((binding) => ({
        binding,
        visibility: 4,
        buffer: { type: 'storage' as const },
      })),
      { binding: 5, visibility: 4, texture: { sampleType: 'depth' } },
      ...[6, 7].map((binding) => ({
        binding,
        visibility: 4,
        texture: { sampleType: 'uint' as const },
      })),
      { binding: 8, visibility: 4, texture: { sampleType: 'unfilterable-float' } },
      ...[9, 10].map((binding) => ({
        binding,
        visibility: 4,
        buffer: { type: 'uniform' as const },
      })),
    ],
  });
  if (!layout.ok) return layout;
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout.value] });
  if (!pipelineLayout.ok) return pipelineLayout;
  const temporal = device.createComputePipeline({
    label: 'ray-diffuse.reconstruct',
    layout: pipelineLayout.value,
    compute: { module, entryPoint: 'reconstructDiffuse' },
  });
  if (!temporal.ok) return temporal;
  const spatial = device.createComputePipeline({
    label: 'ray-diffuse.spatial',
    layout: pipelineLayout.value,
    compute: { module, entryPoint: 'spatialDiffuse' },
  });
  if (!spatial.ok) return spatial;
  return ok({
    record(
      pass: RhiComputePassEncoder,
      input: DiffuseReconstructionInputs,
      pixels: number,
      stage: 'temporal' | 'spatial',
    ) {
      if (!Number.isInteger(pixels) || pixels < 1 || pixels > 262144)
        return rayReferenceFailure('expected 1..262144 diffuse reconstruction texels', true);
      if (input.previous === input.current)
        return rayReferenceFailure('diffuse history read/write allocations must be distinct', true);
      const buffer = (
        binding: number,
        value: Extract<RhiBindingResource, { kind: 'buffer' }>['value'],
      ) => ({
        binding,
        resource: { kind: 'buffer' as const, value },
      });
      const bindings = device.createBindGroup({
        layout: layout.value,
        entries: [
          buffer(0, { buffer: input.raw, size: pixels * RAY_ACCUMULATION_STRIDE }),
          buffer(1, input.records),
          buffer(2, { buffer: input.previous, size: pixels * DIFFUSE_HISTORY_BYTES }),
          buffer(3, { buffer: input.current, size: pixels * DIFFUSE_HISTORY_BYTES }),
          buffer(4, { buffer: input.signal, size: pixels * DIFFUSE_SIGNAL_BYTES }),
          ...[input.depth, input.normal, input.identity, input.motion].map((value, i) => ({
            binding: i + 5,
            resource: { kind: 'textureView' as const, value },
          })),
          buffer(9, input.view),
          buffer(10, { buffer: input.config, size: DIFFUSE_RECONSTRUCTION_UNIFORM_BYTES }),
          buffer(11, { buffer: input.diagnostics, size: pixels * 16 }),
        ],
      });
      if (!bindings.ok) return bindings;
      pass.setPipeline(stage === 'temporal' ? temporal.value : spatial.value);
      pass.setBindGroup(0, bindings.value);
      pass.dispatchWorkgroups(Math.ceil(pixels / 64));
      return ok(undefined);
    },
  });
}
