import type { VfxGpuTickIntent } from '@forgeax/engine-vfx';
import type { RenderFeatureGpuProgramDescriptor } from '../../../render/src/features/prepared-gpu-work';

export interface VfxComputeBatchProgram {
  readonly descriptor: RenderFeatureGpuProgramDescriptor;
  readonly customStride: number;
}
/** The immutable emitter owner consumes the compiler's explicit job ABI. */
export function compileVfxComputeBatchProgram(
  emitter: VfxGpuTickIntent['emitter'],
  program: RenderFeatureGpuProgramDescriptor,
): VfxComputeBatchProgram | undefined {
  const batch = emitter.instanceCompute;
  const customStride = emitter.reflection.layout?.customLayout?.stride ?? 0;
  if (
    batch === undefined ||
    batch.format !== 'forgeax-vfx-instance-compute-1' ||
    batch.jobBytes !== 336 ||
    batch.bindings.length !== 1 ||
    batch.bindings[0]?.entries.length !== 9 ||
    !batch.bindings[0].entries.every(
      (entry, index) =>
        entry.binding === [0, 1, 2, 3, 4, 5, 6, 11, 12][index] &&
        entry.visibility === 4 &&
        entry.buffer?.type ===
          (entry.binding === 1
            ? 'read-only-storage'
            : entry.binding === 12
              ? 'uniform'
              : 'storage') &&
        entry.buffer.hasDynamicOffset !== true,
    ) ||
    !Number.isSafeInteger(customStride) ||
    customStride <= 0 ||
    customStride % 4 !== 0 ||
    !Number.isSafeInteger(emitter.capacity) ||
    emitter.capacity > 256 ||
    emitter.capacity <= 0 ||
    emitter.renderers.some(
      (renderer) => renderer.kind !== 'mesh' && renderer.kind !== 'billboard',
    ) ||
    (emitter.reflection.layout?.parameters.size ?? 0) !== 0 ||
    (emitter.reflection.dataInterfaces?.length ?? 0) !== 0 ||
    emitter.forceFields !== undefined ||
    emitter.reflection.entryPoints.includes('forgeax_vfx_event_main')
  )
    return undefined;
  return {
    customStride,
    descriptor: { wgsl: batch.wgsl, bindings: batch.bindings, entryPoints: program.entryPoints },
  };
}
