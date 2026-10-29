import { ENTITY_NULL_RAW, Entity, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { createStateProjection, type StateProjection } from '@forgeax/engine-ecs/projection';
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
import { type IdentityMap, IdentityMapEditor } from '../scene/identity-map';

const intentOf = (intents: IdentityMap, entity: EntityHandle): VisibilityState | undefined => {
  const raw = intents.get(0, entity);
  return raw === undefined ? undefined : visibilityStateFromU32(raw);
};

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
  /** Valid author intents by entity handle; an immutable root per capture. */
  readonly intents: IdentityMap;
  /** Entities carrying Visibility, including corrupted states. */
  readonly intentCount: number;
  readonly hasAnyHiddenIntent: boolean;
}

const ABSENT = -1;

/**
 * Author intents kept current from the World's own Visibility write and
 * structural evidence: a frame visits the entities whose intent changed, never
 * the Visibility population. Each capture seals an immutable intent root, so
 * earlier snapshots stay valid.
 */
interface VisibilityProjection {
  readonly source: StateProjection;
  readonly intents: IdentityMapEditor;
  /** Raw stored state (or ABSENT) and entity handle of each tracked entity index. */
  readonly states: number[];
  readonly handles: (EntityHandle | undefined)[];
  count: number;
  hidden: number;
  captured: CapturedVisibility | undefined;
}

const projections = new WeakMap<World, VisibilityProjection>();

function captureVisibility(world: World): CapturedVisibility {
  let projection = projections.get(world);
  if (projection === undefined) {
    projection = {
      source: createStateProjection(world, [Visibility]),
      intents: new IdentityMapEditor(),
      states: [],
      handles: [],
      count: 0,
      hidden: 0,
      captured: undefined,
    };
    projections.set(world, projection);
  }
  const batch = projection.source.read();
  if (batch.indices.length === 0 && projection.captured !== undefined) {
    batch.accept();
    return projection.captured;
  }
  const read = world[worldRead];
  const { intents, states, handles } = projection;
  for (const index of batch.indices) {
    const entity = projection.source.entity(index);
    const raw =
      entity !== undefined && world.hasComponent(entity, Visibility)
        ? ((read.getFieldValue(entity, Visibility, 'state') as number | undefined) ?? 0)
        : ABSENT;
    const before = states[index] ?? ABSENT;
    const previousHandle = handles[index];
    if (before !== ABSENT) {
      projection.count--;
      if (before === VisibilityStateValue.hidden) projection.hidden--;
    }
    if (previousHandle !== undefined && (raw === ABSENT || previousHandle !== entity))
      intents.delete(0, previousHandle);
    if (raw === ABSENT || entity === undefined) {
      states[index] = ABSENT;
      handles[index] = undefined;
      continue;
    }
    projection.count++;
    if (raw === VisibilityStateValue.hidden) projection.hidden++;
    states[index] = raw;
    handles[index] = entity;
    if (visibilityStateFromU32(raw) === undefined) intents.delete(0, entity);
    else intents.set(0, entity, raw);
  }
  batch.accept();
  projection.captured = {
    intents: intents.capture(),
    intentCount: projection.count,
    hasAnyHiddenIntent: projection.hidden > 0,
  };
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

      const intent = intentOf(intents, entity) ?? 'inherited';
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
      return intents.has(0, entity) ? resolveEntity?.(entity) : undefined;
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
