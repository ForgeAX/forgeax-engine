// @forgeax/engine-ecs — test fixture: brand-unwrap helper.
//
// @internal Test-only brand unwrapping for Object.is identity assertions
// across the family of phantom-branded numeric ids (Handle<T, M>, Entity,
// SceneInstanceId — all defined as `number & {brand}`). Charter P4
// (consistent abstraction) — collapses 42 historical brand-unwrap cast
// sites into one helper so AI users reading the test fixtures see a
// single intent marker rather than scattered casts. The helper is
// fixture-scope (lives under __tests__/utils, never re-exported from
// packages/ecs/src/index.ts) and must not appear in any production code
// path (AC-08 grep gate).
//
// Implementation uses `Number()` to preserve numeric identity while
// shedding the phantom brand; this avoids the legacy double-cast idiom
// and keeps the AC-07 grep gate clean even though this file lives
// inside packages/ecs/src/__tests__/.

/**
 * Unwrap a phantom-branded numeric id (`Handle<T, M>`, `Entity`,
 * `SceneInstanceId`, ...) to its underlying `number` representation. Used
 * by test fixtures that need to compare brand-erased numeric values via
 * `Object.is` / `===`.
 *
 * The constraint `H extends number` keeps the helper aligned with the
 * brand idiom (`number & {brand}`) used throughout the codebase without
 * coupling to any specific brand class.
 *
 * @internal
 */
export const handleNumeric = <H extends number>(h: H): number => Number(h);
