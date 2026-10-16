// @forgeax/engine-state -- error model SSOT (feat-20260616-engine-state-and-state-scoped-entities M1 / m1w4)
//
// Closed union StateErrorCode (4 members), code-indexed detail payloads,
// and structured StateError carrying .code / .expected / .hint / .detail.
//
// Decision anchors:
// - plan-strategy D-4: 4-code order-locked closed union + discriminated detail
// - requirements sec 2.7: error code union, defineState throws (programmer error),
//   setNextState / getState return Result.err (runtime AI user calls)
// - AGENTS.md Error model: structured errors with .expected / .hint / .detail,
//   never throw for runtime paths; exhaustive switch without default

/** {@link state-already-defined} payload: carries the conflicting name and optional first-definition site. */
export interface StateAlreadyDefinedDetail {
  readonly name: string;
  readonly firstDefinedAt: string | undefined;
}

/** {@link state-not-registered} payload: carries the token name that has no plugin registration. */
export interface StateNotRegisteredDetail {
  readonly name: string;
}

/** {@link invalid-variant} payload: carries the token name, the invalid variant string, and the valid variants list. */
export interface InvalidVariantDetail {
  readonly name: string;
  readonly got: string;
  readonly valid: readonly string[];
}

/** {@link state-default-required} payload: carries the token name whose variants array was empty. */
export interface StateDefaultRequiredDetail {
  readonly name: string;
}

interface StateErrorDetailByCode {
  'state-already-defined': StateAlreadyDefinedDetail;
  'state-not-registered': StateNotRegisteredDetail;
  'invalid-variant': InvalidVariantDetail;
  'state-default-required': StateDefaultRequiredDetail;
}

/**
 * Closed {@link StateErrorCode} union -- 4 members, order-locked.
 * Exhaustive `switch (err.code)` needs no default fallback.
 *
 * | code | trigger |
 * |:--|:--|
 * | `'state-already-defined'` | `defineState()` called with a name already registered |
 * | `'state-not-registered'` | `setNextState()` / `getState()` called before `registerStatesPlugin()` |
 * | `'invalid-variant'` | `setNextState()` called with a variant string not in the token's variants tuple |
 * | `'state-default-required'` | `defineState()` called with empty variants array |
 */
export type StateErrorCode = keyof StateErrorDetailByCode;

/**
 * Detail payload union for {@link StateError}, narrowed per
 * `StateError.code`. AI users obtain the concrete shape via
 * `switch (err.code)` without a fallback `as` cast.
 */
export type StateErrorDetail = StateErrorDetailByCode[StateErrorCode];

/**
 * Structured state-machine error -- four-field surface
 * (`.code` / `.expected` / `.hint` / `.detail`).
 *
 * AI users consume the structured triple by fields, not by parsing `.message`.
 */
type StateErrorVariant<C extends StateErrorCode> = {
  readonly code: C;
  readonly expected: string;
  readonly hint: string;
  readonly detail: StateErrorDetailByCode[C];
};

export type StateError = {
  [C in StateErrorCode]: StateErrorVariant<C>;
}[StateErrorCode];

function makeError<C extends StateErrorCode>(
  code: C,
  expected: string,
  hint: string,
  detail: StateErrorDetailByCode[C],
): StateErrorVariant<C> {
  const error = {
    code,
    expected,
    hint,
    detail,
    get message(): string {
      return `[${code}] ${hint}`;
    },
  };
  return error;
}

/** Convenience throw wrapper for programmer errors (defineState constructor phase). */
export function throwStateError<C extends StateErrorCode>(
  code: C,
  expected: string,
  hint: string,
  detail: StateErrorDetailByCode[C],
): never {
  throw makeError(code, expected, hint, detail);
}

export function stateNotRegistered(name: string): StateError {
  return makeError(
    'state-not-registered',
    'registerStatesPlugin(world) must be called before using setNextState / getState',
    `State "${name}" has not been registered via registerStatesPlugin. createApp auto-registers the plugin in both canvas and assemble forms.`,
    { name },
  );
}

export function invalidVariant(name: string, got: string, valid: readonly string[]): StateError {
  const validSnapshot = [...valid];
  return makeError(
    'invalid-variant',
    `Variant must be one of: ${validSnapshot.join(', ')}`,
    `"${got}" is not a valid variant for state "${name}". Did you mean one of: ${validSnapshot.join(', ')}? Check for typos.`,
    { name, got, valid: validSnapshot },
  );
}
