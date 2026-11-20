import { Disabled, Entity, type EntityHandle } from '@forgeax/engine-ecs';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import {
  assertSceneRosterObservation,
  captureSceneSourceGuard,
  isSceneRosterObservation,
  type SceneRosterObservation,
  type SceneSourceGuard,
} from '@forgeax/engine-scene/internal';
import type { PreparedExtractContext } from '../render-system-extract';
import { meshSourceComponents, prepareMeshSourceSteps } from './prepared-mesh-source';
import {
  MeshSourceStage,
  type MeshSourceStageInput,
  type StagedMeshSource,
  StagedMeshSourceError,
} from './staged-mesh-source';

/** Source-realm ECS capture. Its observations never leave this realm. */
export class LocalMeshSource implements MeshSourceStageInput {
  private stopGuard: SceneSourceGuard | undefined;
  private stopMembers: Iterator<EntityHandle> | undefined;
  private stopCandidate: EntityHandle | undefined;

  constructor(
    private observation: SceneRosterObservation,
    private readonly context: () => PreparedExtractContext,
  ) {
    if (observation.active) throw new StagedMeshSourceError({ reason: 'source' });
    this.assertCurrent();
  }

  get namespace() {
    return this.observation.world;
  }

  get members() {
    return this.observation.members;
  }

  get version() {
    return this.observation;
  }

  assertCurrent(): void {
    const observation = this.observation;
    assertSceneRosterObservation(observation, meshSourceComponents(observation.world));
  }

  isCurrent(): boolean {
    return this.observation.isCurrent();
  }

  extract(current: () => boolean) {
    const roster = this.observation;
    return prepareMeshSourceSteps(roster.world, this.context(), {
      members: roster.members,
      authorDisabled: new Set(roster.members.filter(roster.isAuthorDisabled)),
      roster,
      isCurrent: current,
    });
  }

  advance(next: SceneRosterObservation): void {
    const previous = this.observation;
    if (
      !isSceneRosterObservation(next) ||
      next.members !== previous.members ||
      next.world !== previous.world ||
      (next !== previous &&
        (next.generation !== previous.generation + 1 || next.active === previous.active))
    )
      throw new StagedMeshSourceError({ reason: 'successor' });
    assertSceneRosterObservation(next, meshSourceComponents(next.world));
    if (this.observation !== previous) throw new StagedMeshSourceError({ reason: 'source' });
    this.observation = next;
  }

  stopped(): boolean {
    const world = this.namespace;
    // A poisoned World can never publish again. Its ECS still owns its own cleanup.
    if (world.execution.health === 'poisoned') return true;
    const live = (entity: EntityHandle) =>
      world[worldRead].getFieldValue(entity, Entity, 'self') === entity;
    if (this.stopGuard === undefined) {
      this.stopGuard = captureSceneSourceGuard(world, this.members.filter(live), [
        Disabled,
      ]).unwrap();
      this.stopMembers = this.members[Symbol.iterator]();
    }
    if (!this.stopGuard.isCurrent()) {
      this.dispose();
      return false;
    }
    this.stopCandidate ??= this.stopMembers?.next().value;
    const entity = this.stopCandidate;
    if (entity === undefined) return true;
    if (live(entity) && !world.hasComponent(entity, Disabled))
      throw new StagedMeshSourceError({ reason: 'source' });
    this.stopCandidate = undefined;
    return false;
  }

  dispose(): void {
    this.stopGuard?.dispose();
    this.stopGuard = undefined;
    this.stopMembers = undefined;
    this.stopCandidate = undefined;
  }
}

export class LocalMeshSourceStage
  extends MeshSourceStage<LocalMeshSource>
  implements StagedMeshSource
{
  acceptSource(next: SceneRosterObservation) {
    return this.transitionSource((input) => input.advance(next));
  }
}
