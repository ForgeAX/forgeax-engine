import type { Component } from '../component';
import { componentId } from '../component';
import { Entity } from '../entity';
import { type EntityHandle, encodeEntity, entityIndex } from '../entity-handle';
import { worldPoisonedError } from '../errors/shared-kernel-errors';
import { PROJECTION_BLOCK_SIZE } from '../storage/change-detection';
import type { Table } from '../storage/table';
import type { World } from '../world';
import { worldInternal } from '../world-internal';

interface BlockBaseline {
  readonly entities: Uint32Array;
  readonly membership: number;
}

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
  readonly indices: readonly number[];
  readonly epoch: number;
  readonly scannedRows: number;
  readonly checkedBlocks: number;
  readonly membershipChanged: boolean;
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

/**
 * Current-state candidate discovery. Blocks remember accepted identities, never
 * structural operations. Reads are synchronous and accepting a candidate does
 * not consume evidence belonging to another projection.
 */
export function createStateProjection(
  world: World,
  components: readonly Component[],
  candidates: readonly Component[] = components,
): StateProjection {
  const owner = world[worldInternal];
  const graph = owner.getGraph();
  const ids = components.map(componentId);
  const candidateIds = candidates.map(componentId);
  const sparseCandidates = candidates.some((component) => component.storage === 'sparse');
  const sparseMembership =
    sparseCandidates || components.some((component) => component.storage === 'sparse');
  const baseline = new Map<Table, Map<number, BlockBaseline>>();
  let acceptedEpoch = -1;
  let acceptedStructure = -1;
  let invalid = true;
  let readToken = 0;
  let stamp = new Uint32Array(64);
  let serial = 0;
  const work: number[] = [];

  function enqueue(index: number): void {
    if (index >= stamp.length) {
      let size = stamp.length;
      while (size <= index) size *= 2;
      const next = new Uint32Array(size);
      next.set(stamp);
      stamp = next;
    }
    if (stamp[index] === serial) return;
    stamp[index] = serial;
    work.push(index);
  }

  return {
    isCurrent() {
      return (
        world.execution.health !== 'poisoned' &&
        !invalid &&
        acceptedEpoch === owner.getMutationEpoch() &&
        acceptedStructure === owner.getStructureEpoch()
      );
    },
    entity(index) {
      const record = owner.getRecords()[index];
      if (record === undefined || record.archetypeId < 0) return undefined;
      return encodeEntity(index, record.generation);
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
      const poisoned = worldPoisonedError(world.execution);
      if (poisoned !== undefined) throw poisoned;
      const token = ++readToken;
      const epoch = owner.getMutationEpoch();
      const structure = owner.getStructureEpoch();
      const changedComponents = components.filter(
        (component) =>
          (owner.getComponentMutationEpochs()[componentId(component)] ?? 0) > acceptedEpoch,
      );
      const membershipChanged = invalid || structure !== acceptedStructure;
      const changedRoots =
        invalid ||
        structure !== acceptedStructure ||
        ids.some((id) => (owner.getComponentMutationEpochs()[id] ?? 0) > acceptedEpoch);
      work.length = 0;
      serial = (serial + 1) >>> 0;
      if (serial === 0) {
        stamp.fill(0);
        serial = 1;
      }
      let scannedRows = 0;
      let checkedBlocks = 0;
      const updates: { table: Table; block: number; value: BlockBaseline | undefined }[] = [];
      const visited = new Set<Table>();
      if (changedRoots) {
        const tables = new Set<Table>();
        if (sparseCandidates) {
          for (const table of graph.activeTables) tables.add(table);
        } else {
          for (const id of candidateIds)
            for (const table of graph.activeTablesByComponent.get(id) ?? []) tables.add(table);
        }
        for (const table of tables) {
          visited.add(table);
          const prior = baseline.get(table);
          const entities = table.storage.get(componentId(Entity))?.fields.get('self')?.view;
          if (entities === undefined) continue;
          const columns = ids.flatMap((id) => {
            const epochs = table.storage.get(id)?.epochs;
            return epochs === undefined ? [] : [epochs];
          });
          const blocks = Math.ceil(table.size / PROJECTION_BLOCK_SIZE);
          for (let block = 0; block < blocks; block++) {
            checkedBlocks++;
            const previous = prior?.get(block);
            const membership = table.membership[block] ?? 0;
            const start = block * PROJECTION_BLOCK_SIZE;
            const end = Math.min(table.size, start + PROJECTION_BLOCK_SIZE);
            const membershipChanged =
              invalid || previous === undefined || previous.membership !== membership;
            if (membershipChanged) {
              const current = new Uint32Array(end - start);
              for (let row = start; row < end; row++) {
                current[row - start] = entities[row] as EntityHandle;
              }
              const priorEntities = previous?.entities;
              for (let row = 0; row < Math.max(priorEntities?.length ?? 0, current.length); row++) {
                const before = priorEntities?.[row];
                const after = current[row];
                // Sparse membership can change without moving a table row.
                // Invalidation likewise requires every retained identity.
                if (!invalid && !sparseMembership && before === after) continue;
                if (before !== undefined) enqueue(entityIndex(before as EntityHandle));
                if (after !== undefined) enqueue(entityIndex(after as EntityHandle));
              }
              scannedRows += (priorEntities?.length ?? 0) + end - start;
              updates.push({ table, block, value: { entities: current, membership } });
              if (invalid || sparseMembership || previous === undefined) continue;
            }
            // Stable identities in a structurally changed block may also have
            // component writes since acceptance; membership never replaces them.
            let changedBlock = false;
            for (const column of columns) {
              if ((column.blocks[block] ?? 0) <= acceptedEpoch) continue;
              changedBlock = true;
              for (let row = start; row < end; row++) {
                if ((column.changed[row] ?? 0) > acceptedEpoch)
                  enqueue(entityIndex(entities[row] as EntityHandle));
              }
            }
            if (changedBlock && !membershipChanged) scannedRows += end - start;
          }
          if (prior !== undefined) {
            for (const [block, previous] of prior) {
              if (block < blocks) continue;
              checkedBlocks++;
              for (const entity of previous.entities) enqueue(entityIndex(entity as EntityHandle));
              scannedRows += previous.entities.length;
              updates.push({ table, block, value: undefined });
            }
          }
        }
        for (const [table, prior] of baseline) {
          if (visited.has(table)) continue;
          for (const [block, previous] of prior) {
            checkedBlocks++;
            for (const entity of previous.entities) enqueue(entityIndex(entity as EntityHandle));
            scannedRows += previous.entities.length;
            updates.push({ table, block, value: undefined });
          }
        }
      }
      let accepted = false;
      const validate = (): void => {
        const poisoned = worldPoisonedError(world.execution);
        if (poisoned !== undefined) throw poisoned;
        if (
          token !== readToken ||
          epoch !== owner.getMutationEpoch() ||
          structure !== owner.getStructureEpoch()
        ) {
          throw new StateProjectionExpiredError();
        }
      };
      return {
        indices: work,
        epoch,
        scannedRows,
        checkedBlocks,
        membershipChanged,
        changedComponents,
        validate,
        accept() {
          if (accepted) return;
          validate();
          for (const update of updates) {
            let blocks = baseline.get(update.table);
            if (update.value === undefined) {
              blocks?.delete(update.block);
              if (blocks?.size === 0) baseline.delete(update.table);
            } else {
              if (blocks === undefined) {
                blocks = new Map();
                baseline.set(update.table, blocks);
              }
              blocks.set(update.block, update.value);
            }
          }
          acceptedEpoch = epoch;
          acceptedStructure = structure;
          invalid = false;
          accepted = true;
        },
      };
    },
  };
}
