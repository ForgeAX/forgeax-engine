import {
  ENTITY_NULL_RAW,
  Entity,
  type EntityHandle,
  type Query,
  type World,
} from '@forgeax/engine-ecs';
import { ChildOf } from '../components/child-of';
import type { SceneErrorCode, SceneErrorDetail } from '../errors';

export interface SceneHierarchyDiagnostic {
  readonly code: SceneErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: SceneErrorDetail;
}

export interface SceneHierarchySnapshot {
  readonly parentOf: ReadonlyMap<EntityHandle, EntityHandle>;
  readonly diagnostics: readonly SceneHierarchyDiagnostic[];
  getParent(entity: EntityHandle): EntityHandle | undefined;
}

interface HierarchyProjectionCacheEntry {
  readonly structureEpoch: number;
  readonly childOfChanges: Query;
  readonly snapshot: SceneHierarchySnapshot;
}

// A World can be observed by the transform system, renderer visibility, and
// editor projections in the same frame. Keep one World-local projection so
// those consumers do not each rescan every archetype. Structure changes and
// the ChildOf component's own mutation token are the invalidation keys; the
// global mutation epoch is intentionally too broad because animation and
// runtime-only component writes may advance it every frame. Direct table
// writes are internal-only and must not mutate authored hierarchy state.
const HIERARCHY_PROJECTION_CACHE = new WeakMap<World, HierarchyProjectionCacheEntry>();

function createChildOfChangeQuery(world: World): Query {
  const result = world.query({ changed: [ChildOf] });
  if (!result.ok) throw result.error;
  return result.value;
}

function drainChanges(query: Query): boolean {
  let changed = false;
  for (const span of query.spans().unwrap()) changed ||= span.length > 0;
  return changed;
}

function diagnostic(
  code: SceneErrorCode,
  entity: EntityHandle,
  parent: EntityHandle,
): SceneHierarchyDiagnostic {
  if (code === 'hierarchy-cycle') {
    return {
      code,
      expected: 'ChildOf parent edges form an acyclic live hierarchy',
      hint: 'remove one ChildOf edge from the reported cycle, then re-run the extract',
      detail: { entity, parent },
    };
  }
  return {
    code,
    expected: 'ChildOf.parent references a live entity in the same World',
    hint: 'remove the stale ChildOf component or restore the referenced parent in this World',
    detail: { entity, parent },
  };
}

/** Build the only World-local projection of ChildOf parent facts. */
export function projectHierarchy(world: World): SceneHierarchySnapshot {
  const cached = HIERARCHY_PROJECTION_CACHE.get(world);
  if (
    cached !== undefined &&
    cached.structureEpoch === world.getStructureEpoch() &&
    !drainChanges(cached.childOfChanges)
  ) {
    return cached.snapshot;
  }
  const parentOf = new Map<EntityHandle, EntityHandle>();
  const diagnostics: SceneHierarchyDiagnostic[] = [];
  // Roots have no parent fact to project. Validate only actual edges against
  // the World's generation-checked Entity presence, including non-Transform parents.
  const query = world.query({ read: [ChildOf] });
  if (query.ok) {
    for (const span of query.value.spans().unwrap()) {
      const parents = span.get(ChildOf).parent;
      for (let index = 0; index < span.length; index++) {
        const entityRaw = span.entities[index],
          parentRaw = parents[index];
        if (entityRaw === undefined || parentRaw === undefined || parentRaw === ENTITY_NULL_RAW)
          continue;
        const entity = entityRaw as EntityHandle;
        const parent = parentRaw as EntityHandle;
        if (world.hasComponent(parent, Entity)) parentOf.set(entity, parent);
        else diagnostics.push(diagnostic('hierarchy-broken', entity, parent));
      }
    }
  }

  const state = new Map<EntityHandle, 0 | 1 | 2>();
  const stack: EntityHandle[] = [];
  const cycleMembers = new Set<EntityHandle>();
  const visit = (entity: EntityHandle): void => {
    const currentState = state.get(entity) ?? 0;
    if (currentState === 2) return;
    if (currentState === 1) {
      const cycleStart = stack.indexOf(entity);
      for (let index = cycleStart; index >= 0 && index < stack.length; index++) {
        const member = stack[index];
        if (member !== undefined) cycleMembers.add(member);
      }
      return;
    }

    state.set(entity, 1);
    stack.push(entity);
    const parent = parentOf.get(entity);
    if (parent !== undefined) visit(parent);
    stack.pop();
    state.set(entity, 2);
  };

  for (const entity of parentOf.keys()) visit(entity);
  for (const entity of cycleMembers) {
    const parent = parentOf.get(entity);
    if (parent !== undefined) diagnostics.push(diagnostic('hierarchy-cycle', entity, parent));
    parentOf.delete(entity);
  }

  diagnostics.sort((left, right) => {
    const entityDelta = (left.detail.entity as number) - (right.detail.entity as number);
    if (entityDelta !== 0) return entityDelta;
    return left.code.localeCompare(right.code);
  });

  const snapshot: SceneHierarchySnapshot = {
    parentOf,
    diagnostics: Object.freeze(diagnostics),
    getParent(entity: EntityHandle): EntityHandle | undefined {
      return parentOf.get(entity);
    },
  };
  const childOfChanges = createChildOfChangeQuery(world);
  drainChanges(childOfChanges);
  HIERARCHY_PROJECTION_CACHE.set(world, {
    structureEpoch: world.getStructureEpoch(),
    childOfChanges,
    snapshot,
  });
  return snapshot;
}
