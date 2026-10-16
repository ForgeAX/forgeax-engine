// @forgeax/engine-state -- ScopedTo components + despawnOnExit/Enter (M3 / m3w2)
//
// Per-token __scopedTo__<name> components: defineComponent with two enum fields
// (value = u32 variant index, mode = exit/enter enum). Components are lazily
// created on first use via getScopedComponent.
//
// despawnOnExit / despawnOnEnter are free functions that add the corresponding
// ScopedTo component to an entity. On duplicate add the ECS returns
// ComponentAlreadyPresentError, which we throw.
//
// Decision anchors:
// - plan-strategy D-1: value field uses 'enum' (u32 index into token.variants)
// - requirements F-7/F-8: despawnOnExit/despawnOnEnter free functions
// - requirements AC-11: duplicate add fail-fast via ECS default exclusive=false
// - research F-2: 'enum' is already a ScalarFieldType

import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import type { StateToken, StateTokenVariant } from './define-state';

const SCOPED_COMPONENTS = new Map<string, ReturnType<typeof defineComponent>>();

/** Fixed label-to-value map for the ScopedTo `mode` enum field. */
export const SCOPED_MODE_VALUE = { exit: 0, enter: 1 } as const;

export function getScopedComponent(token: StateToken): ReturnType<typeof defineComponent> {
  const existing = SCOPED_COMPONENTS.get(token.name);
  if (existing) return existing;

  // `value` is the token's variant index — derive its label→index map from
  // `token.variants` so reflection (describeComponent) can name each variant;
  // `mode` uses the fixed exit/enter map. Both attach labels to the enum field
  // (Derive, don't Duplicate: the variant order IS the label source).
  const valueLabels: Record<string, number> = {};
  token.variants.forEach((v, i) => {
    valueLabels[v] = i;
  });

  const comp = defineComponent(`__scopedTo__${token.name}`, {
    value: { type: 'enum', default: 0, labels: valueLabels },
    mode: { type: 'enum', default: SCOPED_MODE_VALUE.exit, labels: SCOPED_MODE_VALUE },
  });
  SCOPED_COMPONENTS.set(token.name, comp);
  return comp;
}

function resolveVariantIndex(token: StateToken, variant: string): number {
  const idx = token.nameToIdx.get(variant as never);
  if (idx === undefined) {
    throw new Error(
      `Invalid variant "${variant}" for state "${token.name}". Valid: ${token.variants.join(', ')}`,
    );
  }
  return idx;
}

/**
 * Mark `entity` to be despawned when `token` leaves `variant`.
 *
 * Adds a `__scopedTo__<token.name>` component with mode=exit
 * and value=<variant index>. When transitionStatesSystem detects
 * the token transitions away from `variant`, it despawns the entity.
 *
 * Throws if `entity` already carries this token's ScopedTo component
 * (ECS default exclusive=false fail-fast).
 */
function addScopedComponent(
  world: World,
  entity: EntityHandle,
  scoped: ReturnType<typeof defineComponent>,
  value: number,
  mode: number,
): ReturnType<typeof world.addComponent> {
  return world.addComponent(entity, {
    component: scoped,
    // generic ComponentSchema loses the concrete {value, mode} enum-field
    // types; data is u32 at runtime.
    data: { value, mode } as Record<string, unknown> as Parameters<
      typeof world.addComponent
    >[1]['data'],
  });
}

export function despawnOnExit<T extends StateToken>(
  world: World,
  entity: EntityHandle,
  token: T,
  variant: StateTokenVariant<T>,
): void {
  const idx = resolveVariantIndex(token, variant);
  const scoped = getScopedComponent(token);
  const result = addScopedComponent(world, entity, scoped, idx, SCOPED_MODE_VALUE.exit);
  if (!result.ok) {
    throw result.error;
  }
}

/**
 * Mark `entity` to be despawned when `token` enters `variant`.
 *
 * Adds a `__scopedTo__<token.name>` component with mode=enter
 * and value=<variant index>. When transitionStatesSystem detects
 * the token transitions into `variant`, it despawns the entity.
 *
 * Throws if `entity` already carries this token's ScopedTo component
 * (ECS default exclusive=false fail-fast).
 */
export function despawnOnEnter<T extends StateToken>(
  world: World,
  entity: EntityHandle,
  token: T,
  variant: StateTokenVariant<T>,
): void {
  const idx = resolveVariantIndex(token, variant);
  const scoped = getScopedComponent(token);
  const result = addScopedComponent(world, entity, scoped, idx, SCOPED_MODE_VALUE.enter);
  if (!result.ok) {
    throw result.error;
  }
}

/**
 * Count entities carrying `token`'s ScopedTo component, grouped by the variant
 * index they are scoped to (irrespective of exit/enter mode). Returns an array
 * aligned to `token.variants` (index i = count for `token.variants[i]`).
 *
 * Used by the `state get <name>` CLI inspector to report per-variant scoped
 * entity counts (requirements AC-15). Reflection only — does not mutate World.
 */
export function countScopedEntitiesByVariant(world: World, token: StateToken): number[] {
  const counts = new Array<number>(token.variants.length).fill(0);
  const scoped = getScopedComponent(token);
  const query = world.query({ read: [scoped] }).unwrap();
  for (const row of query) {
    const idx = row.get(scoped).value;
    if (typeof idx !== 'number') continue;
    if (idx >= 0 && idx < counts.length) counts[idx] = (counts[idx] ?? 0) + 1;
  }
  return counts;
}

// resolveScopedComponent removed — transitionStatesSystem uses the World-local catalog.
