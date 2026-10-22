// @forgeax/engine-assets-runtime -- asset cluster error classes.
//
// feat-20260704-runtime-tier1-decomposition M2 / w8 (D-3): asset-resolution
// cluster -- mesh-SSBO grow ceiling and scene-collect GUID / forest-closure
// fail-fast errors. Class names, .code
// literals, and .detail shapes preserved byte-for-byte (OOS-4).
//
// The cluster union type is named AssetRuntimeError / AssetRuntimeErrorCode
// (not AssetError / AssetErrorCode) because @forgeax/engine-types already owns
// the AssetError class + AssetErrorCode union (asset-system-v1); D-8 grep
// uniqueness forbids the collision.

// ── MeshSsboCeilingReachedError ──────────────────────────────────────────────

/**
 * Detail for `AssetRuntimeErrorCode 'mesh-ssbo-ceiling-reached'`.
 *
 * Fired by `growMeshSsbo` when the requested slot count would exceed the
 * device's `maxStorageBufferBindingSize` (the only ceiling per D-1; engine
 * carries no private capacity constant).
 *
 *   - `requested` — slot count requested by the caller
 *   - `capacity`  — current `slotCount` in the grow controller's state
 *   - `ceiling`   — `device.limits.maxStorageBufferBindingSize` in BYTES
 */
export interface MeshSsboCeilingReachedDetail {
  readonly requested: number;
  readonly capacity: number;
  readonly ceiling: number;
}

/**
 * Structured error for mesh-SSBO grow refused because the request exceeds
 * `device.limits.maxStorageBufferBindingSize`.
 *
 * Emitted by `growMeshSsbo` (D-5: fire, never throw). The frame renders a
 * degraded subset (truncated to pre-grow capacity) per plan-strategy D-2 —
 * no black frame. Four-field surface aligned with `SkinPaletteOverflowError`:
 *   - `.code = 'mesh-ssbo-ceiling-reached'`
 *   - `.expected` — requested * stride <= device.limits.maxStorageBufferBindingSize
 *   - `.hint` — reduce per-frame entity count or pick a higher-tier adapter
 *   - `.detail = { requested, capacity, ceiling }`
 */
export class MeshSsboCeilingReachedError extends Error {
  readonly code = 'mesh-ssbo-ceiling-reached' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: MeshSsboCeilingReachedDetail;

  constructor(requested: number, capacity: number, ceiling: number) {
    const expected = `mesh SSBO slot byte size <= device.limits.maxStorageBufferBindingSize (${ceiling} B)`;
    const hint =
      `requested ${requested} mesh SSBO slots would exceed device.limits.maxStorageBufferBindingSize (${ceiling} B); ` +
      'reduce per-frame entity count or run on an adapter with a larger storage buffer binding size';
    super(
      `mesh SSBO ceiling reached: needed ${requested} slots; capacity ${capacity}; ceiling ${ceiling} B`,
    );
    this.name = 'MeshSsboCeilingReachedError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { requested, capacity, ceiling };
  }
}

// ── SceneCollectEntityRefOutOfClosureError ──────────────────────────

/**
 * Detail for `AssetRuntimeErrorCode 'scene-collect-entity-ref-out-of-closure'`.
 *
 * Emitted during rootsToSceneAsset when an entity field references a target
 * outside the collected forest closure.
 */
export interface SceneCollectEntityRefOutOfClosureDetail {
  readonly entity: number;
  readonly field: string;
  readonly target: number;
}

/**
 * Structured error for entity ref pointing outside the forest closure.
 *
 * Emitted during rootsToSceneAsset collect; fail-fast per charter P3.
 *   - `.code = 'scene-collect-entity-ref-out-of-closure'`
 *   - `.expected` — all entity refs resolve within the closure
 *   - `.hint` — Expand roots to include the target entity, or remove the reference.
 *   - `.detail = { entity, field, target }`
 */
export class SceneCollectEntityRefOutOfClosureError extends Error {
  readonly code = 'scene-collect-entity-ref-out-of-closure' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: SceneCollectEntityRefOutOfClosureDetail;

  constructor(entity: number, field: string, target: number) {
    const expected = `entity ${entity}.${field} references entity ${target} which is inside the forest closure`;
    const hint = 'Expand roots to include the target entity, or remove the reference.';
    super(`${expected} — ${hint}`);
    this.name = 'SceneCollectEntityRefOutOfClosureError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { entity, field, target };
  }
}

// ── SceneCollectAssetGuidUnresolvedError ────────────────────────────

/**
 * Detail for `AssetRuntimeErrorCode 'scene-collect-asset-guid-unresolved'`.
 *
 * Emitted at two points with different context on hand:
 *   - collect (handle→GUID): the shared handle is known → `.handle` is set.
 *   - serialize (GUID→refs): the GUID string is known but absent from the
 *     refs index → `.guid` is set. (`.handle` is meaningless there.)
 * Exactly one of `handle` / `guid` is present per instance.
 */
export interface SceneCollectAssetGuidUnresolvedDetail {
  readonly field: string;
  readonly handle?: number;
  readonly guid?: string;
}

/**
 * Structured error for a shared asset reference whose GUID cannot be resolved.
 *
 * Emitted during rootsToSceneAsset collect (handle) or
 * serializeSceneAssetToPack (guid); fail-fast per charter P3.
 *   - `.code = 'scene-collect-asset-guid-unresolved'`
 *   - `.expected` — every managed asset reference has a source GUID
 *   - `.hint` — Load the referenced asset from its source before collecting.
 *   - `.detail = { field, handle }` (collect) or `{ field, guid }` (serialize)
 */
export class SceneCollectAssetGuidUnresolvedError extends Error {
  readonly code = 'scene-collect-asset-guid-unresolved' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: SceneCollectAssetGuidUnresolvedDetail;

  constructor(field: string, ref: number | string) {
    const where = typeof ref === 'number' ? `handle ${ref}` : `guid '${ref}'`;
    const expected = `asset field '${field}' (${where}) resolves to a source-loaded asset GUID`;
    const hint =
      'load the asset with registry.load(guid, kind) and bind its returned handle; ' +
      'save code-created content to a source asset before exporting a GUID reference';
    super(`${expected} — ${hint}`);
    this.name = 'SceneCollectAssetGuidUnresolvedError';
    this.expected = expected;
    this.hint = hint;
    this.detail = typeof ref === 'number' ? { field, handle: ref } : { field, guid: ref };
  }
}

// -- AssetRuntimeErrorCode / AssetRuntimeError closed unions --------------------

/**
 * Closed union of asset-cluster error codes. AI users perform exhaustive
 * `switch (err.code)` without default; TS guards completeness.
 */
export type AssetRuntimeErrorCode = AssetRuntimeError['code'];

/**
 * Closed union of the asset-cluster structured error classes, each carrying
 * an `AssetRuntimeErrorCode` discriminant on `.code`.
 */
export type AssetRuntimeError =
  | MeshSsboCeilingReachedError
  | SceneCollectEntityRefOutOfClosureError
  | SceneCollectAssetGuidUnresolvedError;
