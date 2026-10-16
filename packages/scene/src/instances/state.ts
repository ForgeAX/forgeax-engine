import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { Handle, LocalEntityId } from '@forgeax/engine-types';
import type { MountOverride } from './runtime-types.js';

/**
 * Per-component, per-field override record carried in `SceneInstanceState`.
 *
 * Composite key `<componentName>:<fieldName>` keeps the override map flat
 * (single Map nesting level) so AI users walking `state.overrides` see one
 * iteration depth — D-2 prefers a single SSOT over multi-Map nesting that
 * would make iteration order ambiguous (charter F1: single mental model).
 *
 * The value is `unknown` because the per-component schema vocab lives in the
 * ECS layer; runtime fail-fast via `EcsErrorCode = 'scene-override-type-
 * mismatch'` (plan-strategy §D-9) catches type drift on the apply path.
 *
 * @internal Surface from `state.overrides` only; AI users never construct a
 *   record directly. Use `world.setSceneOverride(root, member, comp,
 *   field, value)` to write and `world.removeSceneOverride(root, member,
 *   comp, field)` to roll back to the source SceneAsset value.
 */
export interface SceneInstanceOverrideRecord {
  readonly comp: string;
  /**
   * Component-granular add-or-patch discriminant (feat-20260713 M1 / w4):
   * present -> this record patches a single field; absent -> it adds/upserts
   * the whole `comp` (M2 apply semantics). Mirrors `MountOverride.field`.
   */
  readonly field?: string;
  readonly value: unknown;
}

/**
 * Dynamic state payload for one SceneInstance — held in the World's
 * UniqueRefStore behind a `unique<SceneInstanceState>` slot on the synthetic
 * root entity. Mirrors the old class-based layout (plan-strategy §D-2 +
 * design doc §11.2 internal-state-table) but flattened into plain JS Maps/Sets so
 * AI users can iterate without indirection.
 *
 * Lifecycle:
 *   - allocated by `world.instantiateScene(handle, parent?)` — the W in
 *     `world.allocUniqueRef('SceneInstanceState', state)` returns the u32
 *     slot id stored in the SceneInstance.state column;
 *   - released by `world.despawn(root)` (the standard managed-handle release loop)
 *     or explicitly via `world.despawnScene(root)` / `world.despawnDescendants(root)`.
 *
 * Readers use `worldGetSceneInstanceState(world, root)`; the World resolves
 * the component's managed handle and rejects released generations. Scene
 * override operations own mutation of the maps.
 */
export interface SceneInstanceState {
  readonly source: Handle<'SceneAsset', 'shared'>;
  readonly sceneSourceKey?: string;
  /** Authored key for each private numeric slot, retained for collection. */
  readonly keyByLocalId: Map<number, string>;
  /** Authored key of this instance when it is nested in a parent scene. */
  readonly instanceKey?: string;
  readonly bindings: Map<string, EntityHandle>;
  readonly entityToLocalId: Map<EntityHandle, LocalEntityId>;
  readonly detachedLocalIds: Set<LocalEntityId>;
  readonly overrides: Map<LocalEntityId, Map<string, SceneInstanceOverrideRecord>>;
  readonly rootEntities: EntityHandle[];
  readonly mountRoots: EntityHandle[];
  readonly totalSlots: number;
  readonly mountTimeOverrides: readonly MountOverride[];
}

export interface SceneWorldState {
  resolver: unknown;
}

const sceneWorldStates = new WeakMap<World, SceneWorldState>();

export function sceneWorldState(world: World): SceneWorldState {
  const current = sceneWorldStates.get(world);
  if (current !== undefined) return current;
  const created: SceneWorldState = { resolver: null };
  sceneWorldStates.set(world, created);
  return created;
}

export function mountOverrideStateKey(ov: MountOverride): string {
  return ov.field !== undefined ? `${ov.comp}:${ov.field}` : ov.comp;
}

export function isPrimitiveScalarFieldType(fieldType: string): boolean {
  if (
    fieldType === 'f32' ||
    fieldType === 'f64' ||
    fieldType === 'u32' ||
    fieldType === 'i32' ||
    fieldType === 'u8' ||
    fieldType === 'i8' ||
    fieldType === 'u16' ||
    fieldType === 'i16' ||
    fieldType === 'bool' ||
    fieldType === 'enum' ||
    fieldType === 'string'
  ) {
    return true;
  }
  return fieldType.startsWith('enum<');
}

export function primitiveJsType(fieldType: string): string {
  if (fieldType === 'bool') return 'boolean';
  if (fieldType === 'string') return 'string';
  return 'number';
}
