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

/** Fixed label-to-value map for the ScopedTo `mode` enum field. */
export const SCOPED_MODE_VALUE = { exit: 0, enter: 1 } as const;

function createScopedComponent(token: StateToken) {
  return defineComponent(`__scopedTo__${token.name}`, {
    value: { type: 'enum', default: 0, labels: Object.fromEntries(token.nameToIdx) },
    mode: { type: 'enum', default: SCOPED_MODE_VALUE.exit, labels: SCOPED_MODE_VALUE },
  });
}

type ScopedComponent = ReturnType<typeof createScopedComponent>;
const SCOPED_COMPONENTS = new Map<string, ScopedComponent>();

export function getScopedComponent(token: StateToken): ScopedComponent {
  const existing = SCOPED_COMPONENTS.get(token.name);
  if (existing) return existing;
  const component = createScopedComponent(token);
  SCOPED_COMPONENTS.set(token.name, component);
  return component;
}

function resolveVariantIndex(token: StateToken, variant: string): number {
  const idx = token.nameToIdx.get(variant);
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
  scoped: ScopedComponent,
  value: number,
  mode: number,
): ReturnType<typeof world.addComponent> {
  return world.addComponent(entity, {
    component: scoped,
    data: { value, mode },
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
