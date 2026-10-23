import {
  ENTITY_NULL_RAW,
  Entity,
  type EntityHandle,
  type Query,
  type World,
} from '@forgeax/engine-ecs';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import {
  ChildOf,
  projectHierarchy,
  type SceneHierarchyDiagnostic,
  type SceneHierarchySnapshot,
} from '@forgeax/engine-scene';
import {
  Visibility,
  type VisibilityState,
  VisibilityStateValue,
  visibilityStateFromU32,
} from '../components/visibility';

export type VisibilitySource = 'default' | 'self' | 'parent';

export interface VisibilityResolution {
  /** The component value authored on this entity before inheritance. */
  readonly intent: VisibilityState;
  /** The state consumed by render candidates after parent resolution. */
  readonly effective: 'hidden' | 'visible';
  /** Explains whether the effective state came from self, parent, or default. */
  readonly source: VisibilitySource;
}

export interface VisibilitySnapshot {
  readonly diagnostics: readonly SceneHierarchyDiagnostic[];
  readonly hasAnyIntent: boolean;
  readonly hasAnyHiddenIntent: boolean;
  get(entity: EntityHandle): VisibilityResolution | undefined;
  /** Resolve effective visibility for a render candidate, including inherited defaults. */
  effective(entity: EntityHandle): 'hidden' | 'visible';
}

interface ResolutionState {
  readonly intent: VisibilityState;
  readonly effective: 'hidden' | 'visible';
  readonly source: VisibilitySource;
}

interface CapturedVisibility {
  readonly intents: ReadonlyMap<EntityHandle, VisibilityState>;
  readonly intentCount: number;
  readonly hasAnyHiddenIntent: boolean;
}

interface VisibilityProjection {
  readonly rows: Query;
  readonly changes: Query;
  structure: number;
  captured: CapturedVisibility | undefined;
}

const projections = new WeakMap<World, VisibilityProjection>();

function captureVisibility(world: World): CapturedVisibility {
  let projection = projections.get(world);
  if (projection === undefined) {
    projection = {
      rows: world.query({ read: [Visibility] }).unwrap(),
      changes: world.query({ changed: [Visibility] }).unwrap(),
      structure: -1,
      captured: undefined,
    };
    projections.set(world, projection);
  }
  let changed = false;
  for (const span of projection.changes.spans().unwrap()) changed ||= span.length > 0;
  const structure = world.getStructureEpoch();
  const previous = projection.captured;
  if (previous !== undefined && !changed && projection.structure === structure) return previous;
  const spans = projection.rows.spans().unwrap();
  let count = 0;
  let validCount = 0;
  let same = previous !== undefined;
  for (const span of spans) {
    const states = span.get(Visibility).state;
    count += span.length;
    for (let index = 0; index < span.length; index++) {
      const entity = span.entities[index] as EntityHandle;
      const intent = visibilityStateFromU32(states[index] ?? 0);
      if (intent !== undefined) validCount++;
      if (previous?.intents.get(entity) !== intent) same = false;
    }
  }
  // FX structural migrations do not usually change visibility. Verify the
  // current scalar facts before retaining the detached intent publication.
  if (
    same &&
    previous !== undefined &&
    count === previous.intentCount &&
    validCount === previous.intents.size
  ) {
    projection.structure = structure;
    return previous;
  }
  const intents = new Map<EntityHandle, VisibilityState>();
  let hasAnyHiddenIntent = false;
  for (const span of spans) {
    const states = span.get(Visibility).state;
    for (let index = 0; index < span.length; index++) {
      const rawState = states[index] ?? 0;
      const intent = visibilityStateFromU32(rawState);
      if (intent !== undefined) intents.set(span.entities[index] as EntityHandle, intent);
      hasAnyHiddenIntent ||= rawState === VisibilityStateValue.hidden;
    }
  }
  projection.structure = structure;
  projection.captured = { intents, intentCount: count, hasAnyHiddenIntent };
  return projection.captured;
}

/**
 * Resolve author intent against the scene-owned valid parent projection.
 * Diagnostics are preserved for callers to repair hierarchy input before retry.
 *
 * Without an explicit hierarchy, parents are read on demand for the entities
 * actually queried, so a frame pays for its changed renderables instead of
 * projecting every ChildOf edge of the World. The whole-World projection is
 * still used for diagnostics, for a detected cycle (cycle members have no
 * valid parent), and once the ChildOf relationship changed after capture.
 */
export function resolveVisibility(
  world: World,
  hierarchy?: SceneHierarchySnapshot,
): VisibilitySnapshot {
  const captured = captureVisibility(world);
  const { intentCount, hasAnyHiddenIntent, intents } = captured;
  const read = world[worldRead];
  const relationshipEpoch = read.getRelationshipEpoch(ChildOf);
  let projected = hierarchy;
  const project = (): SceneHierarchySnapshot => {
    projected ??= projectHierarchy(world);
    return projected;
  };
  const parentOf = (entity: EntityHandle): EntityHandle | undefined => {
    if (projected === undefined && read.getRelationshipEpoch(ChildOf) !== relationshipEpoch)
      project();
    if (projected !== undefined) return projected.getParent(entity);
    const parent = read.getFieldValue(entity, ChildOf, 'parent');
    if (parent === undefined || parent === ENTITY_NULL_RAW) return undefined;
    // A stale edge is a broken-parent diagnostic, never a parent.
    return world.hasComponent(parent as EntityHandle, Entity)
      ? (parent as EntityHandle)
      : undefined;
  };
  let resolveEntity: ((entity: EntityHandle) => ResolutionState | undefined) | undefined;
  const ensureResolver = (): void => {
    if (resolveEntity !== undefined) return;
    let resolved = new Map<EntityHandle, ResolutionState>();
    const resolving = new Set<EntityHandle>();
    const resolveOnce = (entity: EntityHandle): ResolutionState | undefined => {
      const existing = resolved.get(entity);
      if (existing !== undefined) return existing;
      if (resolving.has(entity)) {
        // Cycle members have no parent in the scene projection. Switch to it
        // and let the outer call resolve again from a clean cache.
        if (projected === undefined) throw CYCLE;
        return undefined;
      }

      const intent = intents.get(entity) ?? 'inherited';
      resolving.add(entity);

      let result: ResolutionState;
      if (intent === 'hidden') {
        result = { intent, effective: 'hidden', source: 'self' };
      } else if (intent === 'visible') {
        result = { intent, effective: 'visible', source: 'self' };
      } else {
        const parent = parentOf(entity);
        const parentResult = parent === undefined ? undefined : resolveOnce(parent);
        result =
          parentResult === undefined
            ? { intent, effective: 'visible', source: 'default' }
            : { intent, effective: parentResult.effective, source: 'parent' };
      }

      resolving.delete(entity);
      resolved.set(entity, result);
      return result;
    };
    resolveEntity = (entity: EntityHandle): ResolutionState | undefined => {
      try {
        return resolveOnce(entity);
      } catch (cause) {
        if (cause !== CYCLE) throw cause;
        resolving.clear();
        resolved = new Map();
        project();
        return resolveOnce(entity);
      }
    };
  };

  const snapshot: VisibilitySnapshot = {
    get diagnostics(): readonly SceneHierarchyDiagnostic[] {
      return project().diagnostics;
    },
    hasAnyIntent: intentCount > 0,
    hasAnyHiddenIntent,
    get(entity: EntityHandle): VisibilityResolution | undefined {
      ensureResolver();
      return intents.has(entity) ? resolveEntity?.(entity) : undefined;
    },
    effective(entity: EntityHandle): 'hidden' | 'visible' {
      // Inheritance can only hide below an explicitly hidden entity.
      if (!hasAnyHiddenIntent) return 'visible';
      ensureResolver();
      return resolveEntity?.(entity)?.effective ?? 'visible';
    },
  };
  return snapshot;
}

const CYCLE: unique symbol = Symbol('visibility-hierarchy-cycle');
