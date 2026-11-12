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
const NO_CHANGED_COMPONENTS: readonly Component[] = Object.freeze([]);

export class StateProjectionExpiredError extends Error {
  readonly code = 'state-projection-expired' as const;
  readonly expected =
    'unchanged observed components and structure, and the latest projection candidate';
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
  return new CurrentStateProjection(world, components, candidates);
}

class CurrentStateProjection implements StateProjection {
  readonly #owner: World[typeof worldInternal];
  readonly #ids: number[];
  readonly #candidateIds: number[];
  readonly work: number[] = [];
  #flags = new Uint8Array(64);
  #membershipWork = false;
  #stamped = false;
  #acceptedEpoch = -1;
  #acceptedStructure = -1;
  #invalid = true;
  #readToken = 0;
  #scannedRows = 0;
  #partialChanges: readonly Component[] | undefined;

  readonly #world: World;
  readonly #components: readonly Component[];
  constructor(world: World, components: readonly Component[], candidates: readonly Component[]) {
    this.#world = world;
    this.#components = Object.freeze(components.slice());
    this.#owner = world[worldInternal];
    this.#ids = this.#components.map(componentId);
    this.#candidateIds = candidates === components ? this.#ids : candidates.map(componentId);
    // Public callbacks keep their original detached-call behavior and identity.
    this.isCurrent = this.isCurrent.bind(this);
    this.read = this.read.bind(this);
    this.entity = this.entity.bind(this);
    this.changed = this.changed.bind(this);
    this.invalidate = this.invalidate.bind(this);
  }

  #inputsUnchangedSince(epoch: number): boolean {
    const epochs = this.#owner.getComponentMutationEpochs();
    for (let cursor = 0; cursor < this.#ids.length; cursor++)
      if ((epochs[this.#ids[cursor] as number] ?? 0) > epoch) return false;
    for (let cursor = 0; cursor < this.#candidateIds.length; cursor++)
      if ((epochs[this.#candidateIds[cursor] as number] ?? 0) > epoch) return false;
    return true;
  }

  #matches(index: number): boolean {
    const archetype =
      this.#owner.getGraph().archetypes[this.#owner.getRecords().archetypeId[index] ?? -1];
    if (archetype === undefined) return false;
    for (let cursor = 0; cursor < this.#candidateIds.length; cursor++)
      if (archetypeHasComponent(archetype, this.#candidateIds[cursor] as number)) return true;
    return false;
  }

  readonly #enqueue = (index: number): void => {
    const previous = this.#flags[index] ?? 0;
    if ((previous & QUEUED) !== 0) {
      if (this.#membershipWork) this.#flags[index] = previous | MEMBERSHIP;
      return;
    }
    this.#scannedRows++;
    if ((previous & ACCEPTED) === 0 && !this.#matches(index)) return;
    if (index >= this.#flags.length) {
      let size = this.#flags.length;
      while (size <= index) size *= 2;
      const next = new Uint8Array(size);
      next.set(this.#flags);
      this.#flags = next;
    }
    this.#flags[index] = previous | QUEUED | (this.#membershipWork ? MEMBERSHIP : 0);
    this.work.push(index);
  };

  isCurrent(): boolean {
    return (
      this.#world.execution.health !== 'poisoned' &&
      !this.#owner.isDerivedWriteActive() &&
      !this.#invalid &&
      this.#inputsUnchangedSince(this.#acceptedEpoch) &&
      this.#acceptedStructure === this.#owner.getStructureEpoch()
    );
  }
  entity(index: number): EntityHandle | undefined {
    const records = this.#owner.getRecords();
    return (records.archetypeId[index] ?? -1) < 0
      ? undefined
      : encodeEntity(index, records.generation[index] as number);
  }
  changed(entity: EntityHandle, component: Component): boolean {
    const id = componentId(component);
    if ((this.#owner.getComponentMutationEpochs()[id] ?? 0) <= this.#acceptedEpoch) return false;
    return (this.#owner.getComponentChange(entity, id)?.changed ?? -1) > this.#acceptedEpoch;
  }
  invalidate(): void {
    this.#readToken++;
    this.#invalid = true;
  }
  read(): StateProjectionBatch {
    this.assertReadable();
    const poisoned = worldPoisonedError(this.#world.execution);
    if (poisoned !== undefined) throw poisoned;
    const token = ++this.#readToken;
    const epoch = this.#owner.getMutationEpoch();
    const structure = this.#owner.getStructureEpoch();
    if (this.#stamped)
      for (let cursor = 0; cursor < this.work.length; cursor++) {
        const index = this.work[cursor] as number;
        this.#flags[index] = (this.#flags[index] ?? 0) & ACCEPTED;
      }
    this.work.length = 0;
    this.#scannedRows = 0;
    this.#stamped = true;
    const changedComponents = this.#changedComponents();
    const mutationEpochs = this.#owner.getComponentMutationEpochs();
    let checkedIndexEntries = 0;
    if (this.#invalid) {
      this.#membershipWork = true;
      for (let index = 0; index < this.#flags.length; index++)
        if (((this.#flags[index] ?? 0) & ACCEPTED) !== 0) this.#enqueue(index);
      for (let cursor = 0; cursor < this.#candidateIds.length; cursor++) {
        const index = this.#owner.getComponentChangeIndex(this.#candidateIds[cursor] as number);
        index?.visitSince(-1, epoch, this.#enqueue);
        checkedIndexEntries += index?.checkedEntries ?? 0;
      }
    } else {
      this.#membershipWork = false;
      for (let cursor = 0; cursor < this.#ids.length; cursor++) {
        const id = this.#ids[cursor] as number;
        if ((mutationEpochs[id] ?? 0) <= this.#acceptedEpoch) continue;
        const index = this.#owner.getComponentChangeIndex(id);
        index?.visitSince(this.#acceptedEpoch, epoch, this.#enqueue);
        checkedIndexEntries += index?.checkedEntries ?? 0;
      }
      if (structure !== this.#acceptedStructure) {
        this.#membershipWork = true;
        const index = this.#owner.getStructuralChangeIndex();
        index.visitSince(this.#acceptedEpoch, epoch, this.#enqueue);
        checkedIndexEntries += index.checkedEntries;
      }
    }
    return new CurrentStateCandidate(
      this,
      token,
      structure,
      epoch,
      this.#scannedRows,
      checkedIndexEntries,
      this.#invalid || structure !== this.#acceptedStructure,
      changedComponents,
    );
  }

  #changedComponents(): readonly Component[] {
    const epochs = this.#owner.getComponentMutationEpochs();
    let count = 0;
    for (let cursor = 0; cursor < this.#ids.length; cursor++)
      if ((epochs[this.#ids[cursor] as number] ?? 0) > this.#acceptedEpoch) count++;
    if (count === 0) return NO_CHANGED_COMPONENTS;
    if (count === this.#components.length) return this.#components;
    return this.#partialComponentChanges(epochs, count);
  }

  #partialComponentChanges(epochs: readonly number[], count: number): readonly Component[] {
    const previous = this.#partialChanges;
    if (previous?.length === count) {
      let at = 0;
      let same = true;
      for (let cursor = 0; cursor < this.#ids.length; cursor++) {
        if ((epochs[this.#ids[cursor] as number] ?? 0) <= this.#acceptedEpoch) continue;
        if (previous[at++] !== this.#components[cursor]) same = false;
      }
      if (same) return previous;
    }
    const changed: Component[] = [];
    for (let cursor = 0; cursor < this.#ids.length; cursor++)
      if ((epochs[this.#ids[cursor] as number] ?? 0) > this.#acceptedEpoch)
        changed.push(this.#components[cursor] as Component);
    this.#partialChanges = Object.freeze(changed);
    return this.#partialChanges;
  }

  assertReadable(): void {
    if (this.#owner.isDerivedWriteActive()) throw new DerivedWriteActiveError();
  }
  validateCandidate(token: number, epoch: number, structure: number): void {
    this.assertReadable();
    const poisoned = worldPoisonedError(this.#world.execution);
    if (poisoned !== undefined) throw poisoned;
    if (
      token !== this.#readToken ||
      !this.#inputsUnchangedSince(epoch) ||
      structure !== this.#owner.getStructureEpoch()
    )
      throw new StateProjectionExpiredError();
  }
  structuralChange(token: number, index: number): boolean {
    if (token !== this.#readToken) throw new StateProjectionExpiredError();
    return ((this.#flags[index] ?? 0) & MEMBERSHIP) !== 0;
  }
  commitCandidate(epoch: number, structure: number): void {
    for (let cursor = 0; cursor < this.work.length; cursor++) {
      const index = this.work[cursor] as number;
      const state = this.#flags[index] ?? 0;
      this.#flags[index] =
        (state & MEMBERSHIP) !== 0 ? (this.#matches(index) ? ACCEPTED : 0) : state & ACCEPTED;
    }
    this.#stamped = false;
    this.#acceptedEpoch = epoch;
    this.#acceptedStructure = structure;
    this.#invalid = false;
  }
}

/** Independent commit capability; only requested public callbacks are bound. */
class CurrentStateCandidate implements StateProjectionBatch {
  readonly indices: readonly number[];
  readonly checkedBlocks = 0;
  #accepted = false;
  #boundValidate: (() => void) | undefined;
  #boundAccept: (() => void) | undefined;
  #boundStructural: ((index: number) => boolean) | undefined;
  readonly #projection: CurrentStateProjection;
  readonly #token: number;
  readonly #structure: number;
  constructor(
    projection: CurrentStateProjection,
    token: number,
    structure: number,
    readonly epoch: number,
    readonly scannedRows: number,
    readonly checkedIndexEntries: number,
    readonly membershipChanged: boolean,
    readonly changedComponents: readonly Component[],
  ) {
    this.#projection = projection;
    this.#token = token;
    this.#structure = structure;
    this.indices = projection.work;
  }
  get validate(): () => void {
    this.#boundValidate ??= this.#check.bind(this);
    return this.#boundValidate;
  }
  get accept(): () => void {
    this.#boundAccept ??= this.#commit.bind(this);
    return this.#boundAccept;
  }
  get hasStructuralChange(): (index: number) => boolean {
    this.#boundStructural ??= this.#structural.bind(this);
    return this.#boundStructural;
  }
  #check(): void {
    this.#projection.validateCandidate(this.#token, this.epoch, this.#structure);
  }
  #commit(): void {
    this.#projection.assertReadable();
    if (this.#accepted) return;
    this.#check();
    this.#projection.commitCandidate(this.epoch, this.#structure);
    this.#accepted = true;
  }
  #structural(index: number): boolean {
    if (this.#accepted) throw new StateProjectionExpiredError();
    return this.#projection.structuralChange(this.#token, index);
  }
}
