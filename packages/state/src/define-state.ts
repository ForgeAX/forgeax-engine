// @forgeax/engine-state -- defineState + StateToken SSOT (feat-20260616 M1 / m1w2)
//
// Module-level state registration: defineState(name, variants as const) returns a
// branded StateToken. The token holds the variants vocabulary (name <-> idx lookup)
// and is used both as a compile-time type witness and as a runtime key for Resource
// registration.
//
// Decision anchors:
// - plan-strategy D-1: variants vocabulary lives in StateToken, not in ECS types
// - plan-strategy D-4: defineState throws on programmer errors (duplicate name / empty variants)
// - plan-strategy sec 8.1: as const + readonly tuple for compile-time variant narrowing
// - defineState registers schemas at module level; active state plugins project them into Worlds

import { throwStateError } from './errors';

/**
 * Opaque branded type for type-level state-machine tokens.
 *
 * Use {@link defineState} to create a token; never construct manually.
 * The {@link __forgeaxState} brand prevents plain-object assignment and
 * enables TypeScript narrowing of variant literal types.
 *
 * @typeParam Name - The string literal name of the state machine.
 * @typeParam V - The union of variant string literals derived from the const tuple.
 */
export interface StateToken<Name extends string = string, V extends string = string> {
  /** Brand -- prevents structural compatibility with plain objects. */
  readonly __forgeaxState: typeof FORGEAX_STATE_BRAND;
  /** The user-supplied state-machine name. */
  readonly name: Name;
  /** The ordered, read-only variants tuple. */
  readonly variants: readonly V[];
  /** Fast lookup: variant string -> its zero-based index in `variants`. */
  readonly nameToIdx: ReadonlyMap<V, number>;
  /** Convenience: `variants[0]`, the default / initial state value. */
  readonly defaultValue: V;
}

/**
 * Brand symbol for {@link StateToken}. Declared (not runtime-initialised) so
 * the token interface carries nominal identity without a runtime allocation.
 */
declare const FORGEAX_STATE_BRAND: unique symbol;

/**
 * Extract the variant union from a {@link StateToken}.
 *
 * ```ts
 * const L = defineState('LevelId', ['menu', 'game'] as const);
 * type LevelVariant = StateTokenVariant<typeof L>;
 * //   ^? 'menu' | 'game'
 * ```
 */
export type StateTokenVariant<T extends StateToken> =
  T extends StateToken<infer _Name, infer V> ? V : never;

/**
 * Extract the name literal from a {@link StateToken}.
 */
export type StateTokenName<T extends StateToken> =
  T extends StateToken<infer Name, infer _V> ? Name : never;

/**
 * Global registry of all state tokens, keyed by token name.
 *
 * `defineState` writes here; active state plugins project it into Worlds;
 * live `forgeax dev eval` inspection also reads it.
 */
const STATE_REGISTRY = new Map<string, StateToken>();
const STATE_DEFINED_LISTENERS = new Set<(token: StateToken) => void>();

/**
 * Internal: get the read-only snapshot of all registered tokens.
 * Exported for the state plugin and live inspection.
 */
export function getRegisteredTokens(): ReadonlyMap<string, StateToken> {
  return STATE_REGISTRY;
}

/** @internal Subscribe one active World adapter to future module-level tokens. */
export function onStateDefined(listener: (token: StateToken) => void): () => void {
  STATE_DEFINED_LISTENERS.add(listener);
  return () => STATE_DEFINED_LISTENERS.delete(listener);
}

/**
 * Define a typed state machine.
 *
 * Must be called at module level. The `as const` assertion on the variants
 * array enables TypeScript to infer the exact literal tuple type, giving
 * compile-time narrowing on variant parameters (e.g. `setNextState(world,
 * token, 'misspell')` is a type error).
 *
 * @param name - Unique state-machine identifier (e.g. `'LevelId'`).
 * @param variants - Readonly tuple of variant string literals. Must be non-empty.
 * @returns A branded {@link StateToken} for use with `setNextState`, `getState`, etc.
 * @throws StateError if `name` is already registered or `variants` is empty.
 *
 * ```ts
 * export const LevelId = defineState('LevelId', ['main-menu', 'tutorial', 'street-a'] as const);
 * // LevelId.variants           -> readonly ['main-menu', 'tutorial', 'street-a']
 * // LevelId.nameToIdx.get('tutorial') -> 1
 * // LevelId.defaultValue       -> 'main-menu'
 * ```
 */
export function defineState<Name extends string, const Variants extends readonly string[]>(
  name: Name,
  variants: Variants,
): StateToken<Name, Variants[number]> {
  if (STATE_REGISTRY.has(name)) {
    throwStateError(
      'state-already-defined',
      'Each StateToken name must be registered exactly once at module level',
      `State "${name}" is already defined. Use the existing token.`,
      { name, firstDefinedAt: undefined },
    );
  }

  if (variants.length === 0) {
    throwStateError(
      'state-default-required',
      'defineState requires at least one variant (non-empty array)',
      `State "${name}" was defined with an empty variants array. Provide at least one variant, e.g. defineState("${name}", ["default"] as const).`,
      { name },
    );
  }

  // Check for duplicate variants within the array
  const nameToIdx = new Map<Variants[number], number>();
  for (const [i, v] of variants.entries()) {
    if (nameToIdx.has(v)) {
      throwStateError(
        'state-default-required',
        'Variants must be unique within a state token',
        `State "${name}" has duplicate variant "${v}". Each variant must appear exactly once.`,
        { name },
      );
    }
    nameToIdx.set(v as Variants[number], i);
  }

  const token = {
    __forgeaxState: undefined as unknown as typeof FORGEAX_STATE_BRAND,
    name,
    variants,
    nameToIdx,
    defaultValue: variants[0] as Variants[number],
  } as StateToken<Name, Variants[number]>;

  STATE_REGISTRY.set(name, token as unknown as StateToken);
  for (const listener of STATE_DEFINED_LISTENERS) listener(token as unknown as StateToken);
  return token;
}
