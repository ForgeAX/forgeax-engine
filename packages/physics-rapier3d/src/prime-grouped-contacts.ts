import type { World } from '../pkg/rapier.mjs';
import type { DerivedBodyRecord, DerivedShapeRecord } from './derived-candidate-records.js';
import type { GroupedContactEvents } from './grouped-contact-events.js';

/** One-time layout transition fence. Seed only contacts that were already active
 * before the whole collider is disabled. Native started/stopped ordering then
 * cannot turn an internal replacement into a new logical impact. No scene scan. */
export function primeGroupedContacts(
  world: World,
  previous: DerivedBodyRecord | undefined,
  next: readonly DerivedShapeRecord[],
  owners: ReadonlyMap<number, { entity: number; id: string; grouped?: boolean }>,
  ledger: GroupedContactEvents,
): void {
  if (!previous || !next.some((shape) => (shape.colliderHandles?.length ?? 0) > 1)) return;
  let visits = 0;
  for (const shape of previous.shapes) {
    if (
      shape.colliderHandles ||
      !next.some((row) => row.input.id === shape.input.id && row.colliderHandles)
    )
      continue;
    const collider = world.getCollider(shape.colliderHandle);
    if (!collider || collider.handle !== shape.colliderHandle || !collider.isEnabled()) continue;
    const seed = (other: typeof collider) => {
      if (++visits > 4096)
        throw new Error('compound layout contact transition exceeds 4096 neighbors');
      if (!other?.isEnabled()) return;
      const parent = other.parent();
      if (typeof parent?.userData !== 'number') return;
      const own = { entity: previous.entity, id: shape.input.id };
      const second = { entity: parent.userData, ...owners.get(other.handle) };
      if (collider.isSensor() || other.isSensor()) {
        if (world.intersectionPair(collider, other))
          ledger.seed(collider.handle, other.handle, own, second);
      } else {
        // Rapier ContactPair.has_any_active_contact is defined by nonempty solver contacts.
        const contacts = world.narrowPhase.contactPairHasSolverContact(
          collider.handle,
          other.handle,
          4096,
        );
        if (contacts.manifoldCount > 4096)
          throw new Error('compound layout contact transition exceeds 4096 manifolds');
        if (contacts.touching) ledger.seed(collider.handle, other.handle, own, second);
      }
    };
    world.contactPairsWith(collider, seed);
    world.intersectionPairsWith(collider, seed);
  }
}
