// @forgeax/engine-types — Result<T, E> SSOT (tweak-20260612-result-into-types).
//
// `Result<T, E>` is the project-wide binary success/failure carrier. It used to
// live as TWO byte-aligned copies (`packages/rhi/src/errors.ts` +
// `packages/ecs/src/result.ts`) — that "byte-for-byte aligned" prose was a
// declaration, not a mechanism, and silently drifted. Consolidating here:
//   - One physical source for the discriminated union + `ok`/`err` factories.
//   - rhi / ecs each keep their typed error class (RhiError / EcsError union)
//     and just re-export the Result shape from this module.
//   - Generic parameter is intentionally NOT defaulted — each consumer narrows
//     the error parameter at its own boundary (`Result<T, RhiError>`,
//     `Result<T, EcsError>`).
//
// Charter mapping: P5 consistent abstraction (single Result idiom across rhi
// and ecs); SSOT data layer (one authoritative carrier, derive don't duplicate).

// ────────────────────────────────────────────────────────────────────────────
// Narrow shape — boolean discriminant `.ok` + `.value` / `.error` branches
// ────────────────────────────────────────────────────────────────────────────

/**
 * Success branch — plain field access (`.ok === true`, `.value: T`) plus
 * method chain (`.unwrap()` / `.unwrapOr(default)`).
 *
 * On the ok branch `unwrap()` returns `.value`; `unwrapOr(d)` ignores the
 * default and returns `.value` (charter proposition 4 explicit-failure: the
 * throwing path lives only on the err branch).
 */
export interface ResultOk<T> {
  readonly ok: true;
  readonly value: T;
  /** Return the wrapped value. Never throws on the ok branch. */
  unwrap(): T;
  /** Return the wrapped value; the default argument is unused on the ok branch. */
  unwrapOr(defaultValue: T): T;
}

/**
 * Failure branch — plain field access (`.ok === false`, `.error: E`) plus
 * method chain (`.unwrap()` / `.unwrapOr(default)`).
 *
 * On the err branch `unwrap()` throws the underlying `E` (not wrapped in a
 * fresh `Error`) so AI consumers preserve `.code` / `.expected` / `.hint` for
 * programmatic recovery (charter proposition 4 + AGENTS.md "Errors are
 * structured. Return Result, never throw for expected failures." — `.unwrap()`
 * is the explicit Layer 3 ErrorHandler boundary, not a hidden throw).
 *
 * `unwrapOr(d)` returns the default; the original error is silently dropped.
 * Use `if (!r.ok) ...` plus `r.error` if you need to inspect the failure.
 */
export interface ResultErr<E> {
  readonly ok: false;
  readonly error: E;
  /** Throw the underlying `error` (preserved without rewrapping). */
  unwrap(): never;
  /** Return the supplied default value (the original error is silently dropped). */
  unwrapOr<T>(defaultValue: T): T;
}

/**
 * Discriminated union: either `ResultOk<T>` or `ResultErr<E>`.
 *
 * Use `ok(value)` / `err(error)` factories to create instances.
 * Use `if (r.ok) ...` / `if (!r.ok) ...` to narrow.
 *
 * Width-assignment friendly: a `ResultErr<E>` returned by `err(...)` typed as
 * `Result<never, E>` satisfies any `Result<X, E>` after a `if (!r.ok)` narrow,
 * so `return r;` propagates without a cast.
 */
export type Result<T, E> = ResultOk<T> | ResultErr<E>;

// ────────────────────────────────────────────────────────────────────────────
// Prototype objects (shared methods — dimorphic, V8 friendly)
// ────────────────────────────────────────────────────────────────────────────

const OK_PROTO = {
  unwrap(this: ResultOk<unknown>): unknown {
    return this.value;
  },
  unwrapOr(this: ResultOk<unknown>, _defaultValue: unknown): unknown {
    return this.value;
  },
};

const ERR_PROTO = {
  unwrap(this: ResultErr<unknown>): never {
    // Throw the ORIGINAL error — NOT wrapped in new Error()
    throw this.error;
  },
  unwrapOr<T>(this: ResultErr<unknown>, defaultValue: T): T {
    return defaultValue;
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Factory functions
// ────────────────────────────────────────────────────────────────────────────

/**
 * Construct a success branch.
 *
 * Returns the narrow `ResultOk<T>` shape so direct `.value` access works
 * without a `if (r.ok)` narrow at the call site (a `ResultOk<T>` widens to
 * `Result<T, E>` for any `E` by structural assignment).
 */
export function ok<T>(value: T): ResultOk<T> {
  const r = Object.create(OK_PROTO) as { ok: true; value: T };
  r.ok = true;
  r.value = value;
  return r as ResultOk<T>;
}

/**
 * Construct a failure branch.
 *
 * Returns the narrow `ResultErr<E>` shape so direct `.error` access works
 * without a `if (!r.ok)` narrow at the call site. After a `if (!r.ok) return
 * r;` narrow, `ResultErr<E>` widens structurally to any `Result<X, E>` so
 * `return r;` propagates without a cast.
 */
export function err<E>(error: E): ResultErr<E> {
  const r = Object.create(ERR_PROTO) as { ok: false; error: E };
  r.ok = false;
  r.error = error;
  return r as ResultErr<E>;
}
