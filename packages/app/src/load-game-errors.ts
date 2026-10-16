// @forgeax/engine-app -- LoadGameError class + 3-code closed union +
// LOAD_GAME_ERROR_HINTS / LOAD_GAME_EXPECTED tables.
//
// Isomorphic to AppError in errors.ts: class extends Error + 4-field
// surface (.code / .expected / .hint / .detail) + discriminated detail
// per code; the co-located policy-owner proof locks the derived views.
//
// Shape:
//   - LoadGameErrorCode = closed union 3 members (charter P4 closed-union
//     exhaustive switch needs no default fallback; tsc strict mode guards
//     completeness; AGENTS.md "Errors are structured").
//     Members:
//       - 'module-not-found'
//       - 'invalid-format'
//       - 'import-failed'
//
//   - LoadGameError class = 4-field surface (.code / .expected / .hint /
//     .detail) byte-for-byte parallel to AppError. AI users walk .code /
//     .detail by property access (charter P3 explicit failure: never parse
//     the message string).
//
//   - LoadGameError is exposed as a discriminated union (variant per code)
//     so AI users get .detail narrowing for free after
//     `if (err.code === '...')`:
//
//       if (err.code === 'module-not-found') {
//         console.warn('game not found:', err.detail.slug);
//       }
//
//   - LOAD_GAME_ERROR_HINTS / LOAD_GAME_EXPECTED are 3-key Records keyed
//     by LoadGameErrorCode; the private policy owner below is the single
//     source for both projections.
//
// Related: requirements AC-08 (LoadGameError structured error 3 codes +
// hint + detail); plan-strategy D-3 (reuse codebase structured error
// pattern); charter P3 (explicit failure).

/**
 * Closed LoadGameErrorCode union (3 members).
 *
 * | code | trigger |
 * |:--|:--|
 * | `'module-not-found'` | resolver throws an error distinguishable as module-not-found (e.g. "Cannot find module"). Detail carries `slug` so AI users can surface which game path failed. |
 * | `'invalid-format'` | resolver returns a module without a valid native Cordis default export. Detail carries `exportKeys` so AI users can inspect the module shape. |
 * | `'import-failed'` | resolver throws a generic Error (network error, build error, etc.) not distinguishable as module-not-found. Detail carries the original `cause` Error so AI users can chain narrow. |
 *
 * Plan-strategy D-3 locks the count at 3.
 */
export type LoadGameErrorCode = keyof typeof loadGameErrorPolicy;

/**
 * Detail variant for the `'module-not-found'` arm.
 *
 * `slug` carries the game identifier that the resolver failed to locate
 * so AI users can surface exactly which game could not be loaded.
 */
export interface LoadGameDetailModuleNotFound {
  readonly slug: string;
}

/**
 * Detail variant for the `'invalid-format'` arm.
 *
 * `exportKeys` carries the keys of the module object returned by the
 * resolver. AI users inspect these to understand why the native default
 * plugin export was rejected.
 */
export interface LoadGameDetailInvalidFormat {
  readonly exportKeys: string[];
}

/**
 * Detail variant for the `'import-failed'` arm.
 *
 * `cause` carries the original thrown value verbatim so AI users can
 * chain narrow (e.g. `cause instanceof TypeError` for network errors)
 * without losing structure.
 */
export interface LoadGameDetailImportFailed {
  readonly cause: unknown;
}

/**
 * Conditional resolver from `LoadGameErrorCode` to its detail payload type.
 */
export type LoadGameErrorDetailFor<C extends LoadGameErrorCode> = C extends 'module-not-found'
  ? LoadGameDetailModuleNotFound
  : C extends 'invalid-format'
    ? LoadGameDetailInvalidFormat
    : LoadGameDetailImportFailed;

/**
 * Tagged union of `.detail` payloads carried by structured LoadGameError.
 */
export type LoadGameErrorDetail = LoadGameErrorDetailFor<LoadGameErrorCode>;

class LoadGameErrorClass extends Error {
  readonly code: LoadGameErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: LoadGameErrorDetail;

  constructor(args: {
    code: LoadGameErrorCode;
    expected: string;
    hint: string;
    detail: LoadGameErrorDetail;
  }) {
    super(`[LoadGameError ${args.code}] expected: ${args.expected}; hint: ${args.hint}`);
    this.name = 'LoadGameError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
    this.detail = args.detail;
  }
}

/**
 * Variant intersection: a `LoadGameErrorClass` instance whose `code` literal
 * narrows to `C` and whose `detail` narrows to `LoadGameErrorDetailFor<C>`.
 */
type LoadGameErrorVariant<C extends LoadGameErrorCode> = LoadGameErrorClass & {
  readonly code: C;
  readonly detail: LoadGameErrorDetailFor<C>;
};

/**
 * Public LoadGameError type -- discriminated union of the 3 variants.
 *
 * AI-user form (charter P3 explicit failure):
 *
 * ```ts
 * function recover(err: LoadGameError): string {
 *   switch (err.code) {
 *     case 'module-not-found': return `game not found: ${err.detail.slug}`;
 *     case 'invalid-format':   return `bad shape, exports: ${err.detail.exportKeys.join(', ')}`;
 *     case 'import-failed':    return err.detail.cause instanceof Error ? err.detail.cause.message : 'unknown';
 *   }
 * }
 * ```
 */
export type LoadGameError = {
  [C in LoadGameErrorCode]: LoadGameErrorVariant<C>;
}[LoadGameErrorCode];

interface LoadGameErrorConstructor {
  new <C extends LoadGameErrorCode>(args: {
    code: C;
    expected: string;
    hint: string;
    detail: LoadGameErrorDetailFor<C>;
  }): LoadGameErrorVariant<C>;
  readonly prototype: LoadGameErrorClass;
}

/**
 * LoadGameError constructor -- `new LoadGameError({ code, expected, hint, detail })`.
 */
export const LoadGameError: LoadGameErrorConstructor =
  LoadGameErrorClass as unknown as LoadGameErrorConstructor;

/**
 * `expected` table -- the engine-side invariant that was violated when each
 * code surfaces. AI users read this as the L2 detail (charter F2 priority
 * text); `.hint` carries the recovery action.
 *
 * 3 keys; the policy-owner proof locks the exact count, order, and values.
 */
type LoadGameErrorPolicy = { readonly expected: string; readonly hint: string };

const loadGameErrorPolicy = {
  'module-not-found': {
    expected:
      'resolver should return a module with a native Cordis default export for the given slug',
    hint: 'verify the game slug matches an existing template directory; check the resolver import path for typos',
  },
  'invalid-format': {
    expected: 'resolved module must default-export a Cordis function, class, or object plugin',
    hint: 'default-export one plugin and let the Host mount it into App.pluginContext',
  },
  'import-failed': {
    expected:
      'resolver should complete without throwing; import path, network, and build errors are forwarded here',
    hint: 'inspect detail.cause for the original error (network failure, build error, dynamic import timeout, etc.)',
  },
} satisfies Record<string, LoadGameErrorPolicy>;

export const LOAD_GAME_EXPECTED: Readonly<Record<LoadGameErrorCode, string>> = Object.fromEntries(
  Object.entries(loadGameErrorPolicy).map(([code, policy]) => [code, policy.expected]),
) as Readonly<Record<LoadGameErrorCode, string>>;

/**
 * `hint` table -- actionable recovery guidance per code (charter P3).
 *
 * 3 keys; the policy-owner proof locks the exact count, order, and values.
 */
export const LOAD_GAME_ERROR_HINTS: Readonly<Record<LoadGameErrorCode, string>> =
  Object.fromEntries(
    Object.entries(loadGameErrorPolicy).map(([code, policy]) => [code, policy.hint]),
  ) as Readonly<Record<LoadGameErrorCode, string>>;

/**
 * Type guard for narrowing unknown errors to LoadGameError.
 *
 * AI users who catch mixed error types can call `if (isLoadGameError(e))`
 * before walking `.code`. Uses instanceof against the internal class
 * (the public constructor delegates to LoadGameErrorClass).
 */
export function isLoadGameError(err: unknown): err is LoadGameError {
  return err instanceof LoadGameErrorClass;
}
