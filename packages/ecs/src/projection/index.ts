import { err, ok, type Result } from '@forgeax/engine-types';
import type { Component } from '../component';
import { componentId } from '../component';
import type { EntityHandle } from '../entity-handle';
import {
  ComponentNotPresentError,
  createRelationshipTargetReadonlyError,
  worldPoisonedError,
} from '../errors';
import { isRelationshipTarget } from '../relationship-index';
import { archetypeHasComponent } from '../storage/archetype';
import type { ArrayRangesChange } from '../storage/array-range-log';
import type { EcsError, World } from '../world';
import { worldInternal } from '../world-internal';

// Owner packages that need ECS validation/default semantics consume these
// helpers through the explicit projection surface. They are intentionally not
// part of the token-first root barrel.
export { fillComponentDefaults } from '../component-input';
export {
  ComponentNotDefinedError,
  ManagedBufferOutOfBoundsError,
  StaleEntityError,
} from '../errors';
export type { ArrayRange, ArrayRangesChange } from '../storage/array-range-log';

export interface RenderChangeBatch {
  readonly version: RenderReadVersion;
  readonly world: RenderWorldChanges;
}

export interface RenderWorldChanges {
  readonly changedComponentIds: readonly number[];
}

export interface RenderReadLease {
  readonly worldIdentity: string;
  readonly generation: number;
  readChanges(version: RenderReadVersion): RenderChangeBatch;
  captureVersion(): RenderReadVersion;
  dispose(): void;
}

/** Compile immutable component-presence facts once per layout. Each read resolves the live generation. */
export function createArchetypeReader<T extends object>(
  world: World,
  describe: (has: (component: Component) => boolean) => T,
) {
  const owner = world[worldInternal];
  const layouts: T[] = [];
  return (entity: EntityHandle): T | undefined => {
    const archetype = owner.getEntityArchetype(entity);
    if (archetype === undefined) return undefined;
    const existing = layouts[archetype.id];
    if (existing !== undefined) return existing;
    const layout = describe((component) =>
      archetypeHasComponent(archetype, componentId(component)),
    );
    layouts[archetype.id] = layout;
    return layout;
  };
}

/**
 * Read one array field through the render projection boundary without
 * materialising the component object. Render extraction uses this for hot
 * transform/instance columns; the World internals remain owned by ECS.
 */
export function readRenderArrayView(
  world: World,
  entity: EntityHandle,
  component: Component,
  fieldName: string,
): ArrayLike<number> | undefined {
  return world[worldInternal].getArrayView(entity, component, fieldName) as
    | ArrayLike<number>
    | undefined;
}

/**
 * Element ranges of one array field written through `World.setArrayRange`
 * after mutation epoch `since`. `[]` means unchanged; `'whole'` means another
 * write (or an evicted history) makes the whole array suspect.
 */
export function readArrayRangesChangedSince(
  world: World,
  entity: EntityHandle,
  component: Component,
  fieldName: string,
  since: number,
): ArrayRangesChange {
  return world[worldInternal].getArrayRangesChangedSince(entity, component, fieldName, since);
}

/** Current World mutation epoch; the `since` baseline for range queries. */
export function readMutationEpoch(world: World): number {
  return world[worldInternal].getMutationEpoch();
}

/** Current mutation epoch for one World-owned component token. */
export function readComponentMutationEpoch(world: World, component: Component): number {
  return world[worldInternal].componentMutationEpochs[componentId(component)] ?? 0;
}

/** Latest mutation epoch of any component token outside `except`. */
export function readMutationEpochExcept(world: World, except: readonly Component[]): number {
  const epochs = world[worldInternal].componentMutationEpochs;
  let latest = 0;
  for (let id = 0; id < epochs.length; id += 1) {
    const epoch = epochs[id] ?? 0;
    if (epoch <= latest) continue;
    let excluded = false;
    for (const component of except) if (componentId(component) === id) excluded = true;
    if (!excluded) latest = epoch;
  }
  return latest;
}

/**
 * Latest epoch at which `entity`'s `component` was added or written; -1 when
 * the entity is dead or lacks the component.
 */
export function readEntityComponentEpoch(
  world: World,
  entity: EntityHandle,
  component: Component,
): number {
  const change = world[worldInternal].getComponentChange(entity, componentId(component));
  return change === undefined ? -1 : Math.max(change.added, change.changed);
}

export interface RenderReadVersion {
  readonly mutationEpoch: number;
  readonly structureEpoch: number;
}

/** Create the render-owned lease from the ECS projection boundary. */
export function createRenderReadLease(world: World): RenderReadLease {
  let disposed = false;

  const assertLive = (): void => {
    if (disposed) throw new Error('RenderReadLease is disposed.');
  };

  const captureVersion = (): RenderReadVersion => {
    return {
      mutationEpoch: world[worldInternal].getMutationEpoch(),
      structureEpoch: world[worldInternal].getStructureEpoch(),
    };
  };

  return {
    worldIdentity: world.identity,
    get generation(): number {
      return Math.max(1, world[worldInternal].getStructureEpoch());
    },
    captureVersion(): RenderReadVersion {
      assertLive();
      return captureVersion();
    },
    readChanges(start: RenderReadVersion): RenderChangeBatch {
      assertLive();
      const version = captureVersion();
      const componentEpochs = world[worldInternal].componentMutationEpochs;
      const changedComponentIds: number[] = [];
      for (let componentId = 0; componentId < componentEpochs.length; componentId += 1) {
        const epoch = componentEpochs[componentId] ?? 0;
        if (epoch > start.mutationEpoch && epoch <= version.mutationEpoch)
          changedComponentIds.push(componentId);
      }
      return { version, world: { changedComponentIds } };
    },
    dispose(): void {
      disposed = true;
    },
  };
}

/** Publish the change to a component whose payload is managed by its producer. */
export function markDerivedComponentChanged(
  world: World,
  entity: EntityHandle,
  component: Component,
): Result<void, EcsError> {
  const poisoned = worldPoisonedError(world.execution);
  if (poisoned !== undefined) return err(poisoned);
  if (isRelationshipTarget(component))
    return err(
      createRelationshipTargetReadonlyError(component.name, 'markDerivedComponentChanged'),
    );
  const owner = world[worldInternal];
  try {
    if (owner.markComponentChanged(entity, componentId(component))) return ok(undefined);
  } catch (cause) {
    if (component.storage !== 'sparse')
      owner.poisonExecution({
        code: 'shared-kernel-failed',
        kernelName: `derived-component:${component.name}:publish`,
        cause,
        partialWrite: true,
        retryable: false,
      });
    throw cause;
  }
  const live = owner.lookupAlive(entity, 'markDerivedComponentChanged', component.name);
  return live.ok ? err(new ComponentNotPresentError(entity as number, component.name)) : live;
}

/** Route an owner-domain error through the World without exposing raw internals. */
export function routeWorldError(
  world: World,
  error: unknown,
  context?: { readonly systemName: string },
): void {
  world[worldInternal].routeError(error, context);
}

export {
  createStateProjection,
  observeStateChanges,
  type StateChangeObservation,
  type StateProjection,
  type StateProjectionBatch,
  StateProjectionExpiredError,
} from './state-projection';
