import type { Component } from '../component';
import { componentId } from '../component';
import { type EntityHandle, encodeEntity } from '../entity-handle';
import { DerivedWriteActiveError } from '../errors';
import { worldPoisonedError } from '../errors/shared-kernel-errors';
import { archetypeHasComponent } from '../storage/archetype';
import type { World } from '../world';
import { worldInternal } from '../world-internal';

const QUEUED = 1;
const MEMBERSHIP = 2;
const ACCEPTED = 4;

export class StateProjectionExpiredError extends Error {
  readonly code = 'state-projection-expired' as const;
  readonly expected = 'an unmodified source and the latest valid projection candidate';
  readonly hint = 'Read and apply the current state again before accepting the candidate.';

  constructor() {
    super('State projection candidate expired; read and apply the current state again.');
    this.name = 'StateProjectionExpiredError';
  }
}

export interface StateProjectionBatch {
  /** Source indices, deduplicated across migration and generation replacement. */
  /** Borrowed until the next read, which expires the preceding candidate. */
  readonly indices: readonly number[];
  readonly epoch: number;
  readonly scannedRows: number;
  readonly checkedBlocks: number;
  readonly checkedIndexEntries: number;
  readonly membershipChanged: boolean;
  /** Existing per-index structural evidence; valid only before this candidate is accepted or superseded. */
  hasStructuralChange(index: number): boolean;
  readonly changedComponents: readonly Component[];
  /** Commit only after the owning consumer has successfully applied its candidate. */
  validate(): void;
  accept(): void;
}

export interface StateProjection {
  /** Whether the accepted source still matches the live World, without creating a candidate. */
  isCurrent(): boolean;
  read(): StateProjectionBatch;
  /** Resolve the final live generation directly through the World record. */
  entity(index: number): EntityHandle | undefined;
  changed(entity: EntityHandle, component: Component): boolean;
  invalidate(): void;
}

/** Independent synchronous current-state cursors over World-owned write evidence. */
export function createStateProjection(
  world: World,
  components: readonly Component[],
  candidates: readonly Component[] = components,
): StateProjection {
  const owner = world[worldInternal];
  const ids = components.map(componentId);
  const candidateIds = candidates.map(componentId);
  const work: number[] = [];
  let flags = new Uint8Array(64);
  let membershipWork = false;
  let stamped = false;
  let acceptedEpoch = -1;
  let acceptedStructure = -1;
  let invalid = true;
  let readToken = 0;
  let scannedRows = 0;

  function matches(index: number): boolean {
    const record = owner.getRecords()[index];
    const archetype =
      record === undefined ? undefined : owner.getGraph().archetypes[record.archetypeId];
    if (archetype === undefined) return false;
    for (const id of candidateIds) if (archetypeHasComponent(archetype, id)) return true;
    return false;
  }

  function enqueue(index: number): void {
    const previous = flags[index] ?? 0;
    if ((previous & QUEUED) !== 0) {
      if (membershipWork) flags[index] = previous | MEMBERSHIP;
      return;
    }
    scannedRows++;
    if ((previous & ACCEPTED) === 0 && !matches(index)) return;
    if (index >= flags.length) {
      let size = flags.length;
      while (size <= index) size *= 2;
      const next = new Uint8Array(size);
      next.set(flags);
      flags = next;
    }
    flags[index] = previous | QUEUED | (membershipWork ? MEMBERSHIP : 0);
    work.push(index);
  }

  return {
    isCurrent() {
      return (
        world.execution.health !== 'poisoned' &&
        !owner.isDerivedWriteActive() &&
        !invalid &&
        acceptedEpoch === owner.getMutationEpoch() &&
        acceptedStructure === owner.getStructureEpoch()
      );
    },
    entity(index) {
      const record = owner.getRecords()[index];
      return record === undefined || record.archetypeId < 0
        ? undefined
        : encodeEntity(index, record.generation);
    },
    changed(entity, component) {
      const id = componentId(component);
      if ((owner.getComponentMutationEpochs()[id] ?? 0) <= acceptedEpoch) return false;
      return (owner.getComponentChange(entity, id)?.changed ?? -1) > acceptedEpoch;
    },
    invalidate() {
      readToken++;
      invalid = true;
    },
    read() {
      if (owner.isDerivedWriteActive()) throw new DerivedWriteActiveError();
      const poisoned = worldPoisonedError(world.execution);
      if (poisoned !== undefined) throw poisoned;
      const token = ++readToken;
      const epoch = owner.getMutationEpoch();
      const structure = owner.getStructureEpoch();
      if (stamped) for (const index of work) flags[index] = (flags[index] ?? 0) & ACCEPTED;
      work.length = 0;
      scannedRows = 0;
      stamped = true;
      const changedComponents: Component[] = [];
      for (const component of components)
        if ((owner.getComponentMutationEpochs()[componentId(component)] ?? 0) > acceptedEpoch)
          changedComponents.push(component);
      let checkedIndexEntries = 0;
      if (invalid) {
        // Explicit baseline rebuild includes accepted identities that have disappeared.
        membershipWork = true;
        for (let index = 0; index < flags.length; index++)
          if (((flags[index] ?? 0) & ACCEPTED) !== 0) enqueue(index);
        for (const id of candidateIds) {
          const index = owner.getComponentChangeIndex(id);
          index?.visitSince(-1, epoch, enqueue);
          checkedIndexEntries += index?.checkedEntries ?? 0;
        }
      } else {
        membershipWork = false;
        for (const id of ids) {
          if ((owner.getComponentMutationEpochs()[id] ?? 0) <= acceptedEpoch) continue;
          const index = owner.getComponentChangeIndex(id);
          index?.visitSince(acceptedEpoch, epoch, enqueue);
          checkedIndexEntries += index?.checkedEntries ?? 0;
        }
        if (structure !== acceptedStructure) {
          membershipWork = true;
          const index = owner.getStructuralChangeIndex();
          index.visitSince(acceptedEpoch, epoch, enqueue);
          checkedIndexEntries += index.checkedEntries;
        }
      }
      let accepted = false;
      const validate = (): void => {
        if (owner.isDerivedWriteActive()) throw new DerivedWriteActiveError();
        const poisoned = worldPoisonedError(world.execution);
        if (poisoned !== undefined) throw poisoned;
        if (
          token !== readToken ||
          epoch !== owner.getMutationEpoch() ||
          structure !== owner.getStructureEpoch()
        )
          throw new StateProjectionExpiredError();
      };
      return {
        indices: work,
        epoch,
        scannedRows,
        checkedBlocks: 0,
        checkedIndexEntries,
        membershipChanged: invalid || structure !== acceptedStructure,
        changedComponents,
        hasStructuralChange(index) {
          if (accepted || token !== readToken) throw new StateProjectionExpiredError();
          return ((flags[index] ?? 0) & MEMBERSHIP) !== 0;
        },
        validate,
        accept() {
          if (owner.isDerivedWriteActive()) throw new DerivedWriteActiveError();
          if (accepted) return;
          validate();
          for (const index of work) {
            const state = flags[index] ?? 0;
            // Value-only writes cannot alter candidate membership. Reconcile
            // only identities carrying structural or explicit-baseline work.
            flags[index] =
              (state & MEMBERSHIP) !== 0 ? (matches(index) ? ACCEPTED : 0) : state & ACCEPTED;
          }
          stamped = false;
          acceptedEpoch = epoch;
          acceptedStructure = structure;
          invalid = false;
          accepted = true;
        },
      };
    },
  };
}
