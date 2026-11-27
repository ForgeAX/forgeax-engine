import {
  type Component,
  Disabled,
  Entity,
  type EntityHandle,
  type World,
} from '@forgeax/engine-ecs';
import { observeStateChanges, type StateChangeObservation } from '@forgeax/engine-ecs/projection';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import { err, ok, type Result } from '@forgeax/engine-types';
import { ScenePreparationError } from './preparation';

export interface SceneSourceGuard {
  /** Sticky invalidation; an invalid candidate cannot become current again. */
  readonly isCurrent: () => boolean;
  /** Advance across an exclusive, counted series of successful Disabled migrations. */
  readonly acceptDisabledTransition: (expectedStructure: number) => boolean;
  readonly inspect: () => {
    readonly checks: number;
    readonly scannedRows: number;
    readonly checkedIndexEntries: number;
  };
  readonly dispose: () => void;
}

/**
 * Capture after materialization/overrides finish, at an exclusive source boundary.
 * The closed source vocabulary excludes legitimate domain-derived writes.
 * The roster supplies its own identities. Every
 * structural fact for an owned index still invalidates, including removal and
 * generation reuse. Asset/schema validity stays with the calling owner.
 */
export function captureSceneSourceGuard(
  world: World,
  members: readonly EntityHandle[],
  sourceComponents: readonly Component[],
): Result<SceneSourceGuard, ScenePreparationError> {
  if (world.execution.health !== 'healthy')
    return err(
      new ScenePreparationError({
        reason: 'stale-input',
        entity: members[0] ?? (0 as EntityHandle),
      }),
    );
  const indices = new Set<number>();
  for (const entity of members) {
    if (world[worldRead].getFieldValue(entity, Entity, 'self') === undefined)
      return err(new ScenePreparationError({ reason: 'missing-member', entity }));
    indices.add(Number(entity) & 0x00ffffff);
  }
  let projection: StateChangeObservation | undefined = observeStateChanges(
    world,
    sourceComponents,
    indices,
  );
  let checks = 0;
  let scannedRows = 0;
  let checkedIndexEntries = 0;
  let valid = true;
  const observe = (changes: ReturnType<StateChangeObservation['read']>): void => {
    scannedRows += changes.scannedRows;
    checkedIndexEntries += changes.checkedIndexEntries;
  };
  return ok({
    isCurrent: () => {
      checks++;
      if (!valid || projection === undefined || world.execution.health !== 'healthy') return false;
      if (projection.isCurrent()) return true;
      const changes = projection.read();
      observe(changes);
      if (changes.indices.length > 0) {
        valid = false;
        return false;
      }
      changes.accept();
      return true;
    },
    acceptDisabledTransition: (expectedStructure) => {
      if (!valid || projection === undefined || world.execution.health !== 'healthy') return false;
      // Each successful Disabled migration publishes exactly one structural change.
      // A different count or any other observed authored write breaks the proof.
      if (world.getStructureEpoch() !== expectedStructure) {
        valid = false;
        return false;
      }
      if (projection.isCurrent()) return true;
      const changes = projection.read();
      observe(changes);
      if (changes.changedComponents.some((component) => component !== Disabled)) {
        valid = false;
        return false;
      }
      changes.accept();
      return true;
    },
    inspect: () => ({ checks, scannedRows, checkedIndexEntries }),
    dispose: () => {
      valid = false;
      indices.clear();
      projection = undefined;
    },
  });
}
