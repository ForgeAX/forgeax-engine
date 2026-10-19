import type { Result } from '@forgeax/engine-types';
import type { Component } from '../component';
import { componentId } from '../component';
import type { EntityHandle } from '../entity-handle';
import type { ArrayRangesChange } from '../storage/array-range-log';
import type { EcsError, World } from '../world';
import { worldInternal } from '../world-internal';

// Owner packages that need ECS validation/default semantics consume these
// helpers through the explicit projection surface. They are intentionally not
// part of the token-first root barrel.
export { fillComponentDefaults } from '../component-default-fallback';
export {
  ComponentNotDefinedError,
  InstanceTransformsStrideMismatchError,
  ManagedBufferOutOfBoundsError,
  ResourceInvalidValueError,
  SpawnLightInvalidBoundsError,
  SpriteAnimationInvalidError,
  SpriteInstancesCountMismatchError,
  SpriteInstancesMutuallyExclusiveWithInstancesError,
  SpriteInstancesRequiresSpriteShaderError,
  StaleEntityError,
} from '../errors';
export type { ArrayRange, ArrayRangesChange } from '../storage/array-range-log';

export interface RenderProjectionComponentRequest {
  readonly component: Component;
  readonly fields: readonly string[];
}

export interface RenderProjectionRequest {
  readonly components: readonly RenderProjectionComponentRequest[];
}

export interface RenderProjectionSpan {
  readonly length: number;
  readonly fields: Readonly<Record<string, ArrayLike<number>>>;
}

export interface RenderProjectionSpans {
  readonly generation: number;
  readonly spans: readonly RenderProjectionSpan[];
}

export interface RenderChangeBatch {
  readonly version: RenderReadVersion;
  readonly world: RenderWorldChanges;
}

export interface RenderWorldChanges {
  readonly fromEpoch: number;
  readonly toEpoch: number;
  readonly changedComponentIds: readonly number[];
}

export interface RenderReadLease {
  readonly worldIdentity: string;
  readonly generation: number;
  readChanges(version: RenderReadVersion): RenderChangeBatch;
  querySpans(request: RenderProjectionRequest): RenderProjectionSpans;
  captureVersion(): RenderReadVersion;
  dispose(): void;
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
  return world[worldInternal].getComponentMutationEpochs()[componentId(component)] ?? 0;
}

export interface RenderReadVersion {
  readonly mutationEpoch: number;
  readonly structureEpoch: number;
}

function readProjectionSpans(
  world: World,
  generation: number,
  request: RenderProjectionRequest,
): RenderProjectionSpans {
  const queryResult = world.query({ read: request.components.map((entry) => entry.component) });
  if (!queryResult.ok) throw new Error(queryResult.error.message);
  const spansResult = queryResult.value.spans();
  if (!spansResult.ok) throw new Error(spansResult.error.message);
  const spans: RenderProjectionSpan[] = [];
  for (const span of spansResult.value) {
    const fields: Record<string, ArrayLike<number>> = {};
    for (const entry of request.components) {
      const shape = span.get(entry.component) as unknown as Record<string, ArrayLike<number>>;
      for (const fieldName of entry.fields) {
        const field = shape[fieldName];
        if (field === undefined) {
          throw new Error(
            `Render projection field '${entry.component.name}.${fieldName}' is unavailable.`,
          );
        }
        fields[`${entry.component.name}.${fieldName}`] = field;
        if (request.components.length === 1) fields[fieldName] = field;
      }
    }
    spans.push({ length: span.length, fields: Object.freeze(fields) });
  }
  return {
    generation,
    spans: Object.freeze(spans),
  };
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
      const toEpoch = world[worldInternal].getMutationEpoch() as number;
      const componentEpochs = world[
        worldInternal
      ].getComponentMutationEpochs() as readonly number[];
      const changedComponentIds: number[] = [];
      for (let componentId = 0; componentId < componentEpochs.length; componentId += 1) {
        const epoch = componentEpochs[componentId] ?? 0;
        if (epoch > start.mutationEpoch && epoch <= toEpoch) changedComponentIds.push(componentId);
      }
      const worldRead: RenderWorldChanges = {
        fromEpoch: start.mutationEpoch,
        toEpoch,
        changedComponentIds,
      };
      const version = captureVersion();
      return { version, world: worldRead };
    },
    querySpans(request: RenderProjectionRequest): RenderProjectionSpans {
      assertLive();
      return readProjectionSpans(
        world,
        Math.max(1, world[worldInternal].getStructureEpoch()),
        request,
      );
    },
    dispose(): void {
      disposed = true;
    },
  };
}

/**
 * Publish one owner-derived component value through the component's ordinary
 * version. Numeric consumers observe the same row epoch regardless of which
 * owner computed the value; there is no parallel derived-change vocabulary.
 */
export function setDerivedComponent(
  world: World,
  entity: EntityHandle,
  component: Component,
  value: Record<string, unknown>,
): Result<void, EcsError> {
  const result = world[worldInternal].setQueryRow(entity, component, value);
  if (!result.ok) return result;
  world[worldInternal].markComponentChanged(entity, componentId(component));
  return result;
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
  type StateProjection,
  type StateProjectionBatch,
  StateProjectionExpiredError,
} from './state-projection';
