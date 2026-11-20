import {
  type Component,
  Disabled,
  ENTITY_NULL_RAW,
  Entity,
  type EntityHandle,
  type World,
} from '@forgeax/engine-ecs';
import { prepareDisabledBatch } from '@forgeax/engine-ecs/internal';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import { err, ok, type Result } from '@forgeax/engine-types';
import { ChildOf } from '../components/child-of';
import { captureSceneSourceGuard, type SceneSourceGuard } from './source-guard';

export type SceneRosterFailure =
  | 'closed'
  | 'stale-input'
  | 'duplicate-member'
  | 'missing-member'
  | 'foreign-author-disabled'
  | 'unexpected-participation'
  | 'foreign-observation'
  | 'source-vocabulary'
  | 'reentrant-operation'
  | 'partial-transition';

export class SceneRosterError extends Error {
  readonly code = 'scene-roster-invalid' as const;
  override readonly name = 'SceneRosterError';
  constructor(
    readonly detail: { readonly reason: SceneRosterFailure; readonly entity?: EntityHandle },
    options?: ErrorOptions,
  ) {
    super(`Scene roster: ${detail.reason}`, options);
  }
}

/** A Scene-owned source observation, not Render or Physics acceptance. */
export interface SceneRosterObservation {
  readonly world: World;
  readonly members: readonly EntityHandle[];
  readonly generation: number;
  readonly active: boolean;
  readonly isAuthorDisabled: (entity: EntityHandle) => boolean;
  /** Pure issuer-owned proof of the source vocabulary observed for every member/ancestor. */
  readonly observes: (components: readonly Component[]) => boolean;
  readonly isCurrent: () => boolean;
}

const observations = new WeakSet<SceneRosterObservation>();
/** Issuance only; no foreign properties or external guard are read. */
export function isSceneRosterObservation(value: unknown): value is SceneRosterObservation {
  return (
    typeof value === 'object' && value !== null && observations.has(value as SceneRosterObservation)
  );
}
export function assertSceneRosterObservation(
  value: SceneRosterObservation,
  components: readonly Component[] = [],
): void {
  if (!isSceneRosterObservation(value))
    throw new SceneRosterError({ reason: 'foreign-observation' });
  if (!value.observes(components)) throw new SceneRosterError({ reason: 'source-vocabulary' });
  if (!value.isCurrent()) throw new SceneRosterError({ reason: 'foreign-observation' });
}

export interface SceneRosterParticipation {
  capture(): Result<SceneRosterObservation, SceneRosterError>;
  /** Caller owns the exclusive legal source boundary. No extension code runs during writes. */
  setActive(
    active: boolean,
    expected: SceneRosterObservation,
  ): Result<SceneRosterObservation, SceneRosterError>;
  inspect(): {
    readonly phase: 'inactive' | 'active' | 'failed' | 'closed';
    readonly participation: 'inactive' | 'active' | 'unconfirmed';
  };
  /** Drops qualification only. Source membership and partial writes remain caller-owned. */
  dispose(): void;
}

export interface SceneRosterPreparation {
  readonly members: readonly EntityHandle[];
  readonly authorDisabled: ReadonlySet<EntityHandle>;
  readonly sourceComponents: readonly Component[];
  /** Fixed content/compiler/schema expectations; never refreshed by a participation switch. */
  readonly isCurrent: () => boolean;
}

function failure(reason: SceneRosterFailure, entity?: EntityHandle, cause?: unknown) {
  return new SceneRosterError(
    { reason, ...(entity === undefined ? {} : { entity }) },
    cause === undefined ? undefined : { cause },
  );
}

function watchedMembers(world: World, members: readonly EntityHandle[]): EntityHandle[] {
  const watched = new Set(members);
  const complete = new Set<EntityHandle>();
  for (const member of members) {
    let entity = member;
    const path = new Set<EntityHandle>();
    for (;;) {
      if (complete.has(entity)) break;
      if (path.has(entity)) throw failure('stale-input', entity);
      path.add(entity);
      if (world[worldRead].getFieldValue(entity, Entity, 'self') !== entity)
        throw failure('missing-member', entity);
      watched.add(entity);
      const parent = world[worldRead].getFieldValue(entity, ChildOf, 'parent');
      if (parent === undefined || parent === ENTITY_NULL_RAW) break;
      entity = parent as EntityHandle;
    }
    for (const entity of path) complete.add(entity);
  }
  return [...watched];
}

class Roster implements SceneRosterParticipation {
  private readonly source: SceneSourceGuard;
  private readonly move: ReturnType<typeof prepareDisabledBatch>;
  private readonly effectiveCount: number;
  private generation = 0;
  private phase: 'inactive' | 'active' | 'failed' | 'closed' = 'inactive';
  private observation: SceneRosterObservation | undefined;
  private fault: SceneRosterError | undefined;
  private busy = false;

  constructor(
    private readonly world: World,
    private readonly members: readonly EntityHandle[],
    private readonly authored: ReadonlySet<EntityHandle>,
    watched: readonly EntityHandle[],
    private readonly components: readonly Component[],
    private readonly contentCurrent: () => boolean,
  ) {
    this.validateInactiveMembers();
    const effective = members.filter((entity) => !authored.has(entity));
    this.move = prepareDisabledBatch(world, effective);
    this.effectiveCount = effective.length;
    this.source = captureSceneSourceGuard(world, watched, components).unwrap();
    this.validate();
  }

  private validate(): void {
    if (this.phase === 'closed') throw failure('closed');
    if (this.fault !== undefined) throw this.fault;
    const source = this.source,
      generation = this.generation,
      phase = this.phase;
    if (
      this.world.execution.health !== 'healthy' ||
      !source.isCurrent() ||
      !this.contentCurrent() ||
      this.source !== source ||
      this.generation !== generation ||
      this.phase !== phase ||
      !source.isCurrent() ||
      this.world.execution.health !== 'healthy'
    )
      throw failure('stale-input');
  }

  private validateInactiveMembers(): void {
    for (const entity of this.members) {
      if (this.world[worldRead].getFieldValue(entity, Entity, 'self') !== entity)
        throw failure('missing-member', entity);
      if (!this.world.hasComponent(entity, Disabled))
        throw failure('unexpected-participation', entity);
    }
  }

  capture(): Result<SceneRosterObservation, SceneRosterError> {
    if (this.busy) return err(failure('reentrant-operation'));
    this.busy = true;
    try {
      this.validate();
      return ok(this.issueObservation());
    } catch (cause) {
      return err(this.reject(cause));
    } finally {
      this.busy = false;
    }
  }

  /** Called only after qualification; issuing an observation executes no external code. */
  private issueObservation(): SceneRosterObservation {
    if (this.observation !== undefined) return this.observation;
    const generation = this.generation,
      source = this.source,
      phase = this.phase;
    const observation = Object.freeze({
      world: this.world,
      members: this.members,
      generation,
      active: phase === 'active',
      isAuthorDisabled: (entity: EntityHandle) => this.authored.has(entity),
      observes: (components: readonly Component[]) =>
        components.every((component) => this.components.includes(component)),
      isCurrent: () => this.observationCurrent(generation, source, phase),
    });
    observations.add(observation);
    this.observation = observation;
    return observation;
  }

  private observationCurrent(generation: number, source: SceneSourceGuard, phase: string): boolean {
    if (
      this.busy ||
      this.generation !== generation ||
      this.source !== source ||
      this.phase !== phase
    )
      return false;
    this.busy = true;
    try {
      this.validate();
      return this.generation === generation && this.source === source && this.phase === phase;
    } catch (cause) {
      this.reject(cause);
      return false;
    } finally {
      this.busy = false;
    }
  }

  setActive(
    active: boolean,
    expected: SceneRosterObservation,
  ): Result<SceneRosterObservation, SceneRosterError> {
    if (
      this.observation === undefined ||
      expected !== this.observation ||
      !observations.has(expected)
    )
      return err(failure('foreign-observation'));
    if (this.busy) return err(failure('reentrant-operation'));
    this.busy = true;
    let writing = false;
    try {
      this.validate();
      if (active === (this.phase === 'active')) return ok(expected);
      // World qualifies the old membership and publishes one structural change for
      // each moved entity. The source guard accepts only that counted transition.
      writing = true;
      this.generation++;
      this.observation = undefined;
      const expectedStructure = this.world.getStructureEpoch() + this.effectiveCount;
      this.move(!active).unwrap();
      if (!this.source.acceptDisabledTransition(expectedStructure)) throw failure('stale-input');
      this.phase = active ? 'active' : 'inactive';
      this.validate();
      const observation = this.issueObservation();
      writing = false;
      return ok(observation);
    } catch (cause) {
      return err(this.reject(writing ? failure('partial-transition', undefined, cause) : cause));
    } finally {
      this.busy = false;
    }
  }

  private reject(cause: unknown): SceneRosterError {
    const error =
      cause instanceof SceneRosterError ? cause : failure('stale-input', undefined, cause);
    if (
      this.phase !== 'closed' &&
      error.detail.reason !== 'foreign-observation' &&
      error.detail.reason !== 'reentrant-operation' &&
      error.detail.reason !== 'closed'
    ) {
      this.fault ??= error;
      this.phase = 'failed';
      this.source?.dispose();
    }
    return error;
  }

  inspect() {
    return {
      phase: this.phase,
      participation:
        this.phase === 'inactive' || this.phase === 'active'
          ? this.phase
          : ('unconfirmed' as const),
    };
  }

  dispose(): void {
    this.phase = 'closed';
    this.generation++;
    this.observation = undefined;
    this.source.dispose();
  }
}

/** Qualify one existing, wholly Disabled Scene roster; creates no ECS membership or resource registry. */
export function prepareSceneRosterParticipation(
  world: World,
  input: SceneRosterPreparation,
): Result<SceneRosterParticipation, SceneRosterError> {
  try {
    const checkContent = input.isCurrent;
    const contentCurrent = () => checkContent.call(input);
    if (!contentCurrent() || world.execution.health !== 'healthy') throw failure('stale-input');
    const members = Object.freeze([...input.members]);
    const unique = new Set(members);
    if (unique.size !== members.length) throw failure('duplicate-member');
    const authored = new Set(input.authorDisabled);
    for (const entity of authored)
      if (!unique.has(entity)) throw failure('foreign-author-disabled', entity);
    const watched = watchedMembers(world, members);
    return ok(
      new Roster(world, members, authored, watched, [...input.sourceComponents], contentCurrent),
    );
  } catch (cause) {
    return err(
      cause instanceof SceneRosterError ? cause : failure('stale-input', undefined, cause),
    );
  }
}
