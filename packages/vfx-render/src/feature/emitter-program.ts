import { ownRenderFeatureProgramData } from '@forgeax/engine-render/internal';
import type { VfxGpuTickIntent } from '@forgeax/engine-vfx';
import type { RenderFeatureGpuProgramDescriptor } from '../../../render/src/features/prepared-gpu-work';

import type { VfxComputeBatchProgram } from './batched-compute-program';

type Emitter = VfxGpuTickIntent['emitter'];

/** Static reflection shares the existing immutable compute-program lifetime.
 * Raw/inline emitters keep the ordinary current-source path. */
export function createVfxEmitterProgramOwner(
  immutable: Pick<WeakSet<object>, 'has'>,
  compile: (emitter: Emitter) => RenderFeatureGpuProgramDescriptor,
  compileBatch?: (
    emitter: Emitter,
    program: RenderFeatureGpuProgramDescriptor,
  ) => VfxComputeBatchProgram | undefined,
) {
  const programs = new WeakMap<
    Emitter,
    {
      readonly program: RenderFeatureGpuProgramDescriptor;
      readonly batch?: VfxComputeBatchProgram;
      readonly entryPoints: ReadonlySet<string>;
      readonly requirements: NonNullable<Emitter['reflection']['dataInterfaces']>;
    }
  >();
  return (emitter: Emitter) => {
    if (!immutable.has(emitter)) return undefined;
    const previous = programs.get(emitter);
    if (previous !== undefined) return previous;
    const program = ownRenderFeatureProgramData(compile(emitter));
    const entryPoints = new Set(emitter.reflection.entryPoints);
    const reflectedBindings = new Set(
      emitter.reflection.bindings.flatMap((group) => group.entries.map((entry) => entry.binding)),
    );
    const requirements = (emitter.reflection.dataInterfaces ?? []).filter((requirement) =>
      reflectedBindings.has(requirement.binding),
    );
    const compiledBatch = compileBatch?.(emitter, program);
    const batch =
      compiledBatch === undefined
        ? undefined
        : { ...compiledBatch, descriptor: ownRenderFeatureProgramData(compiledBatch.descriptor) };
    const prepared = {
      program,
      entryPoints,
      requirements,
      ...(batch === undefined ? {} : { batch }),
    };
    programs.set(emitter, prepared);
    return prepared;
  };
}
