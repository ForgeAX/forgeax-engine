import type { MaterialBindingSlots } from '../record/fold-buckets';
import type { GpuDrivenMaterialBinding } from './production-raster';
import type { PreparedBatch } from './production-raster-prepare';

interface BindingLayout {
  readonly unique: readonly GpuDrivenMaterialBinding[];
  readonly slots: MaterialBindingSlots;
}

interface BindingCapture {
  layout?: BindingLayout;
}

// The captured array owns these detached scalar relations. Borrowed arrays,
// including frozen arrays and copied descriptors, never acquire this proof.
const captures = new WeakMap<readonly GpuDrivenMaterialBinding[], BindingCapture>();

/** Capture one prepared plan's complete material/class relation and slot order. */
export function captureGpuMaterialBindings(
  batches: readonly PreparedBatch[],
): readonly GpuDrivenMaterialBinding[] {
  const bindings = batches.map(({ batch, materialBindingClass }) => {
    const source = batch.binding;
    if (source === undefined) throw new Error('Prepared batch has no shared material binding');
    return Object.freeze({
      material: source.material,
      worldId: source.worldId,
      resourceClass: materialBindingClass,
    });
  });
  const captured = Object.freeze(bindings);
  captures.set(captured, {});
  return captured;
}

/** Only the actual producer capture can supply its immutable slot projection. */
export function capturedGpuMaterialLayout(
  bindings: readonly GpuDrivenMaterialBinding[],
): BindingCapture | undefined {
  return captures.get(bindings);
}
