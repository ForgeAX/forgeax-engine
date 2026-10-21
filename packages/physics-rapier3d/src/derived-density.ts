import type { DerivedShapeInput } from '@forgeax/engine-physics';
import type { Collider } from '../pkg/rapier.mjs';

/** Every group retains its original logical shape's density on an automatic
 * policy transition; native collider ordinal is not the logical shape ordinal. */
export function restoreDerivedDensities(
  colliders: readonly Collider[],
  override: number | undefined,
  authoredDensity: number,
  shapes: readonly DerivedShapeInput[],
  candidateColliders: readonly { readonly handle: number }[],
  owners: ReadonlyMap<number, { readonly id: string }>,
): void {
  const byId = new Map(shapes.map((shape) => [shape.id, shape.density ?? 1]));
  const active = new Set(candidateColliders.map((collider) => collider.handle));
  for (const collider of colliders) {
    const own = owners.get(collider.handle);
    const candidate = active.has(collider.handle) && own ? byId.get(own.id) : undefined;
    collider.setDensity(
      candidate !== undefined ? (override ?? candidate) : own ? 0 : (override ?? authoredDensity),
    );
  }
}
