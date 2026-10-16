import type { EntityHandle, World } from '@forgeax/engine-ecs';
import {
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

/**
 * Resolve author intent against the scene-owned valid parent projection.
 * Diagnostics are preserved for callers to repair hierarchy input before retry.
 */
export function resolveVisibility(
  world: World,
  hierarchy: SceneHierarchySnapshot = projectHierarchy(world),
): VisibilitySnapshot {
  // Visibility is an opt-in component. Query only the owning archetypes
  // instead of walking every Entity row with an optional column; the latter
  // made a World with no visibility intents pay a full-scene scan on each
  // extraction. QueryRow.entity is sourced from the essential Entity column,
  // so the required Visibility read retains the same handle and intent
  // semantics while keeping the hot path sparse.
  const query = world.query({ read: [Visibility] });
  const visitVisibilityRows = (visit: (entity: EntityHandle, rawState: number) => void): void => {
    if (!query.ok) return;
    // Dense component spans keep the per-frame summary on typed-array reads
    // instead of allocating a QueryRow facade for every visibility-bearing
    // entity. Keep the row path as a defensive fallback if a future storage
    // mode cannot expose spans.
    const spans = query.value.spans();
    if (spans.ok) {
      for (const span of spans.value) {
        const states = span.get(Visibility).state;
        for (let index = 0; index < span.length; index += 1) {
          visit(span.entities[index] as EntityHandle, states[index] ?? 0);
        }
      }
      return;
    }
    for (const row of query.value) {
      visit(row.entity, row.get(Visibility).state);
    }
  };
  let intentCount = 0;
  let hasAnyHiddenIntent = false;
  visitVisibilityRows((_entity, rawState) => {
    intentCount += 1;
    if (rawState === VisibilityStateValue.hidden) {
      hasAnyHiddenIntent = true;
    }
  });

  let resolveEntity: ((entity: EntityHandle) => ResolutionState | undefined) | undefined;
  let hasIntent: ((entity: EntityHandle) => boolean) | undefined;
  const ensureResolver = (): void => {
    if (resolveEntity !== undefined) return;
    const intentByEntity = new Map<EntityHandle, VisibilityState>();
    visitVisibilityRows((entity, rawState) => {
      const intent = visibilityStateFromU32(rawState);
      if (intent !== undefined) {
        intentByEntity.set(entity, intent);
      }
    });
    hasIntent = (entity: EntityHandle): boolean => intentByEntity.has(entity);
    const resolved = new Map<EntityHandle, ResolutionState>();
    const resolving = new Set<EntityHandle>();
    resolveEntity = (entity: EntityHandle): ResolutionState | undefined => {
      const existing = resolved.get(entity);
      if (existing !== undefined) return existing;
      if (resolving.has(entity)) return undefined;

      const intent = intentByEntity.get(entity) ?? 'inherited';
      resolving.add(entity);

      let result: ResolutionState;
      if (intent === 'hidden') {
        result = { intent, effective: 'hidden', source: 'self' };
      } else if (intent === 'visible') {
        result = { intent, effective: 'visible', source: 'self' };
      } else {
        const parent = hierarchy.getParent(entity);
        const parentResult = parent === undefined ? undefined : resolveEntity?.(parent);
        result =
          parentResult === undefined
            ? { intent, effective: 'visible', source: 'default' }
            : { intent, effective: parentResult.effective, source: 'parent' };
      }

      resolving.delete(entity);
      resolved.set(entity, result);
      return result;
    };
  };

  const snapshot: VisibilitySnapshot = {
    diagnostics: hierarchy.diagnostics,
    hasAnyIntent: intentCount > 0,
    hasAnyHiddenIntent,
    get(entity: EntityHandle): VisibilityResolution | undefined {
      ensureResolver();
      return hasIntent?.(entity) ? resolveEntity?.(entity) : undefined;
    },
    effective(entity: EntityHandle): 'hidden' | 'visible' {
      ensureResolver();
      return resolveEntity?.(entity)?.effective ?? 'visible';
    },
  };
  return snapshot;
}
