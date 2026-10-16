import type { Buffer, RhiComputePassEncoder, RhiDevice, ShaderModule } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { RasterRayInputs } from './raster-source';

export const PROBE_PLACEMENT_STRIDE = 32;
export const PROBE_PLACEMENT_DIAGNOSTIC_STRIDE = 16;

/** Borrowed native Standard G-buffer inputs from one submitted perspective frame.
 * The caller qualifies the admitted rows as lit Standard surfaces. Visible
 * identity alone is not a generic material/shading-model eligibility flag.
 * The caller supplies finite, mutually inverse View matrices; view.size must
 * be exactly VIEW_UNIFORM_BYTES, with a device-aligned byte offset. */
export interface RasterProbePlacementInputs
  extends Pick<RasterRayInputs, 'depth' | 'normal' | 'identity' | 'records' | 'view'> {
  /** 32 bytes/probe: f32 base.xyz/cellSize, u32 id/generation/traced/reserved.
   * IDs and generations are nonzero; traced is 0 or 1, reserved is zero. */
  readonly probes: Buffer;
  /** 32 bytes/probe: f32 offset.xyz/reserved, u32 id/generation/0/0.
   * Initialize/reset externally; offsets stay within +/- cellSize/4. */
  readonly accepted: Buffer;
  /** Separate 32-byte states. Only the caller may publish after successful submit. */
  readonly candidate: Buffer;
  /** u32 id/generation/status/sampleCount per probe. Status: 0 no samples,
   * 1 placed, 2 invalid probe/state, 3 invalid extent/projection mode/range.
   * None of these outcomes declares field coverage or lighting validity. */
  readonly diagnostics: Buffer;
  /** 16-byte u32 viewport x/y/width/height in the supplied attachments. */
  readonly viewRect: Buffer;
}

/** Records one 64-lane workgroup per probe. Owns no buffer, submission, history,
 * field, or clipmap. No-sample/rejected work copies the accepted state unchanged. */
export function createRasterProbePlacement(device: RhiDevice, module: ShaderModule) {
  const failure = (expected: string, code: RhiError['code'] = 'rhi-descriptor-invalid') =>
    err(
      new RhiError({
        code,
        expected,
        hint: 'Supply supported device limits and matching native raster/probe ranges before recording placement.',
      }),
    );
  if (!device.caps.compute || !device.caps.storageBuffer)
    return failure(
      'compute and storage-buffer support for raster probe placement',
      'rhi-not-available',
    );
  for (const [name, required] of [
    ['maxBindGroups', 1],
    ['maxBindingsPerBindGroup', 10],
    ['maxStorageBuffersPerShaderStage', 5],
    ['maxSampledTexturesPerShaderStage', 3],
    ['maxUniformBuffersPerShaderStage', 2],
    ['maxUniformBufferBindingSize', VIEW_UNIFORM_BYTES],
    ['maxComputeWorkgroupSizeX', 64],
    ['maxComputeInvocationsPerWorkgroup', 64],
    ['maxComputeWorkgroupStorageSize', 16],
  ] as const)
    if (!(device.limits[name] >= required))
      return failure(
        `raster probe placement requires ${name} >= ${required}; got ${device.limits[name]}`,
        'limit-exceeded',
      );
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: 4, texture: { sampleType: 'depth' } },
      ...[1, 2].map((binding) => ({
        binding,
        visibility: 4,
        texture: { sampleType: 'uint' as const },
      })),
      { binding: 3, visibility: 4, buffer: { type: 'read-only-storage' } },
      {
        binding: 4,
        visibility: 4,
        buffer: { type: 'uniform', minBindingSize: VIEW_UNIFORM_BYTES },
      },
      { binding: 5, visibility: 4, buffer: { type: 'read-only-storage' } },
      { binding: 6, visibility: 4, buffer: { type: 'read-only-storage' } },
      { binding: 7, visibility: 4, buffer: { type: 'storage' } },
      { binding: 8, visibility: 4, buffer: { type: 'storage' } },
      { binding: 9, visibility: 4, buffer: { type: 'uniform' } },
    ],
  });
  if (!layout.ok) return layout;
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout.value] });
  if (!pipelineLayout.ok) return pipelineLayout;
  const pipeline = device.createComputePipeline({
    label: 'ray-probe-placement.update',
    layout: pipelineLayout.value,
    compute: { module, entryPoint: 'placeRasterProbes' },
  });
  if (!pipeline.ok) return pipeline;
  return ok({
    record(
      pass: RhiComputePassEncoder,
      input: RasterProbePlacementInputs,
      probeCount: number,
    ): Result<void, RhiError> {
      if (
        !Number.isSafeInteger(probeCount) ||
        probeCount < 1 ||
        !(probeCount <= device.limits.maxComputeWorkgroupsPerDimension)
      )
        return failure(
          `raster probe count in 1..${device.limits.maxComputeWorkgroupsPerDimension}`,
          'limit-exceeded',
        );
      if (
        probeCount * PROBE_PLACEMENT_STRIDE > device.limits.maxStorageBufferBindingSize ||
        probeCount * PROBE_PLACEMENT_STRIDE > device.limits.maxBufferSize ||
        input.records.size > device.limits.maxStorageBufferBindingSize
      )
        return failure(
          'probe and row binding ranges within the device storage-buffer limits',
          'limit-exceeded',
        );
      if (
        !Number.isSafeInteger(input.records.size) ||
        input.records.size < 64 ||
        input.records.size % 64 !== 0
      )
        return failure('a nonempty exact range of 64-byte frame rows');
      const viewOffset = input.view.offset ?? 0;
      if (
        input.view.size !== VIEW_UNIFORM_BYTES ||
        !Number.isSafeInteger(viewOffset) ||
        viewOffset < 0 ||
        viewOffset % device.limits.minUniformBufferOffsetAlignment !== 0
      )
        return failure(`an exact ${VIEW_UNIFORM_BYTES}-byte View range at a device-aligned offset`);
      const reads = [
        input.records.buffer,
        input.view.buffer,
        input.probes,
        input.accepted,
        input.viewRect,
      ];
      if (
        input.candidate === input.diagnostics ||
        reads.includes(input.candidate) ||
        reads.includes(input.diagnostics)
      )
        return failure('placement outputs must not alias each other or borrowed inputs');
      const bindings = device.createBindGroup({
        layout: layout.value,
        entries: [
          ...[input.depth, input.normal, input.identity].map((value, binding) => ({
            binding,
            resource: { kind: 'textureView' as const, value },
          })),
          { binding: 3, resource: { kind: 'buffer', value: input.records } },
          { binding: 4, resource: { kind: 'buffer', value: input.view } },
          ...[input.probes, input.accepted, input.candidate, input.diagnostics, input.viewRect].map(
            (buffer, index) => ({
              binding: 5 + index,
              resource: {
                kind: 'buffer' as const,
                value: {
                  buffer,
                  size:
                    index === 4
                      ? 16
                      : probeCount *
                        (index === 3 ? PROBE_PLACEMENT_DIAGNOSTIC_STRIDE : PROBE_PLACEMENT_STRIDE),
                },
              },
            }),
          ),
        ],
      });
      if (!bindings.ok) return bindings;
      pass.setPipeline(pipeline.value);
      pass.setBindGroup(0, bindings.value);
      pass.dispatchWorkgroups(probeCount);
      return ok(undefined);
    },
  });
}
