// @forgeax/engine-assets-runtime -- asset cluster error classes.
//
// feat-20260704-runtime-tier1-decomposition M2 / w8 (D-3): asset-resolution
// cluster -- material parent-chain resolve, mesh-SSBO grow ceiling, and
// scene-collect GUID / forest-closure fail-fast errors. Class names, .code
// literals, and .detail shapes preserved byte-for-byte (OOS-4).
//
// The cluster union type is named AssetRuntimeError / AssetRuntimeErrorCode
// (not AssetError / AssetErrorCode) because @forgeax/engine-types already owns
// the AssetError class + AssetErrorCode union (asset-system-v1); D-8 grep
// uniqueness forbids the collision.

import type { MeshBinHeader } from '@forgeax/engine-pack';
import {
  AssetError,
  type AssetErrorDetail,
  type AssetMeshBinContractFacts,
  type AssetMeshBinContractViolationReason,
} from '@forgeax/engine-types';

export class MeshBinAssetError extends AssetError {
  readonly subject = 'mesh-bin' as const;
  readonly sourceKey: string;
  readonly actual: string;
  readonly recovery = 're-cook the source with its Meta sidecar through the build-time importer';

  constructor(args: {
    readonly sourceKey: string;
    readonly expected: string;
    readonly actual: string;
    readonly header?: Partial<MeshBinHeader> & { readonly byteLength?: number };
    readonly reason?: AssetMeshBinContractViolationReason;
    readonly expectedFacts?: AssetMeshBinContractFacts;
    readonly actualFacts?: AssetMeshBinContractFacts;
  }) {
    const expectedFacts: AssetMeshBinContractFacts = args.expectedFacts ?? {
      version: args.header?.version ?? 5,
      projectionVersion: 1,
    };
    const actualFacts: AssetMeshBinContractFacts = {
      ...(args.header ?? {}),
      ...(args.actualFacts ?? {}),
    };
    const detail: AssetErrorDetail = {
      code: 'mesh-bin-contract-violation',
      sourceKey: args.sourceKey,
      reason: args.reason ?? 'header-invalid',
      expected: expectedFacts,
      actual: actualFacts,
    };
    super({
      code: 'mesh-bin-contract-violation',
      expected: args.expected,
      hint: 're-cook the source with its Meta sidecar through the build-time importer',
      detail,
    });
    this.sourceKey = args.sourceKey;
    this.actual = args.actual;
  }
}

// ── MaterialResolvedEmptyPassesError ──────────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'material-resolved-empty-passes'`.
 *
 * Emitted at material parent chain walk time when the resolved passes list
 * is empty. Two reasons: `'missing-parent'` (a parent handle is not
 * registered) and `'no-pass-in-chain'` (the entire parent chain has no
 * pass declarations). AI users switch on `.detail.reason` to surface the
 * right recovery guidance.
 *
 * plan-strategy D-2/D-3: empty-passes is a runtime-layer error
 * (RuntimeErrorCode, not AssetErrorCode).
 */
export interface MaterialResolvedEmptyPassesDetail {
  /** GUID of the material whose resolve produced empty passes. */
  readonly materialGuid: string;
  /** Root cause of the empty passes: missing parent vs entire chain has no passes. */
  readonly reason: 'missing-parent' | 'no-pass-in-chain';
  /** The raw numeric handle id of the unregistered parent. Only populated when reason='missing-parent'. */
  readonly missingParentHandle?: number;
}

/**
 * Structured error for material parent chain resolve yielding zero passes.
 *
 * Emitted by `AssetRegistry.passesOf` when the parent chain walk produces
 * an empty passes list (AC-09, D-3 two-reason). Four-field surface:
 *   - `.code = 'material-resolved-empty-passes'` (closed RuntimeErrorCode)
 *   - `.expected` — expected-state description
 *   - `.hint` — actionable recovery guidance (differs per reason)
 *   - `.detail = { materialGuid, reason, missingParentHandle? }`
 */
export class MaterialResolvedEmptyPassesError extends Error {
  readonly code = 'material-resolved-empty-passes' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: MaterialResolvedEmptyPassesDetail;

  constructor(
    materialGuid: string,
    reason: 'missing-parent' | 'no-pass-in-chain',
    missingParentHandle?: number,
  ) {
    const expected =
      reason === 'missing-parent'
        ? `parent handle ${missingParentHandle} present in AssetRegistry`
        : 'at least one material in the parent chain declares passes';
    const hint =
      reason === 'missing-parent'
        ? `material ${materialGuid} references parent handle ${missingParentHandle} which is not registered; inspect AssetRegistry, register the parent first, or rebuild the material chain`
        : `material ${materialGuid} has no passes and its entire parent chain also has no pass declarations; inspect the chain, add pass declarations to one member, then rebuild`;
    const message =
      reason === 'missing-parent'
        ? `material ${materialGuid} parent handle ${missingParentHandle} not registered`
        : `material ${materialGuid} parent chain resolves to zero passes`;

    super(message);
    this.name = 'MaterialResolvedEmptyPassesError';
    this.expected = expected;
    this.hint = hint;
    this.detail = {
      materialGuid,
      reason,
      ...(reason === 'missing-parent' && missingParentHandle !== undefined
        ? { missingParentHandle }
        : {}),
    };
  }
}

// ── MeshSsboCapacityExceededError ────────────────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'mesh-ssbo-capacity-exceeded'`.
 *
 * Fired by `growMeshSsbo` (createRenderer.ts grow factory) when, after
 * attempting pow2 doubling, the resulting `slotCount` still cannot
 * accommodate the requested `requested` slot count under the device's
 * `maxStorageBufferBindingSize` ceiling. This is a defensive fallback —
 * the primary path for "request past device limit" is
 * `mesh-ssbo-ceiling-reached`. The two codes share the same detail shape so
 * AI users handle both arms identically; the discriminant identifies which
 * branch fired so diagnostics can distinguish the primary vs defensive
 * surface (research §F6.c).
 *
 *   - `requested` — slot count requested by the caller (entity count for the frame)
 *   - `capacity`  — current `slotCount` in the grow controller's state
 *   - `ceiling`   — `device.limits.maxStorageBufferBindingSize` in BYTES (not slots)
 */
export interface MeshSsboCapacityExceededDetail {
  readonly requested: number;
  readonly capacity: number;
  readonly ceiling: number;
}

/**
 * Structured error for the post-grow defensive fallback when mesh-SSBO
 * capacity cannot accommodate the requested slot count.
 *
 * Emitted by `growMeshSsbo` in `createRenderer.ts` (D-5: fire, never
 * throw). Four-field surface aligned with `SkinPaletteOverflowError`:
 *   - `.code = 'mesh-ssbo-capacity-exceeded'`
 *   - `.expected` — capacity >= requested
 *   - `.hint` — reduce per-frame entity count or split work across frames
 *   - `.detail = { requested, capacity, ceiling }`
 */
export class MeshSsboCapacityExceededError extends Error {
  readonly code = 'mesh-ssbo-capacity-exceeded' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: MeshSsboCapacityExceededDetail;

  constructor(requested: number, capacity: number, ceiling: number) {
    const expected = `mesh SSBO slotCount >= ${requested} (currently ${capacity}; device ceiling ${ceiling} B)`;
    const hint =
      `mesh SSBO grow could not satisfy needed=${requested} slots (capacity=${capacity}, ceiling=${ceiling} B); ` +
      'reduce per-frame entity count or split work across frames (defensive fallback path)';
    super(
      `mesh SSBO capacity exceeded: needed ${requested} slots, capacity ${capacity}, ceiling ${ceiling} B`,
    );
    this.name = 'MeshSsboCapacityExceededError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { requested, capacity, ceiling };
  }
}

// ── MeshSsboCeilingReachedError ──────────────────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'mesh-ssbo-ceiling-reached'`.
 *
 * Fired by `growMeshSsbo` when the requested slot count would exceed the
 * device's `maxStorageBufferBindingSize` (the only ceiling per D-1; engine
 * carries no private capacity constant). Same detail shape as
 * `MeshSsboCapacityExceededDetail`.
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
 * Detail for `RuntimeErrorCode 'scene-collect-entity-ref-out-of-closure'`.
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
 * Detail for `RuntimeErrorCode 'scene-collect-asset-guid-unresolved'`.
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
 *   - `.expected` — every shared asset reference has a catalogued GUID
 *   - `.hint` — Register the asset in AssetRegistry before collecting.
 *   - `.detail = { field, handle }` (collect) or `{ field, guid }` (serialize)
 */
export class SceneCollectAssetGuidUnresolvedError extends Error {
  readonly code = 'scene-collect-asset-guid-unresolved' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: SceneCollectAssetGuidUnresolvedDetail;

  constructor(field: string, ref: number | string) {
    const where = typeof ref === 'number' ? `handle ${ref}` : `guid '${ref}'`;
    const expected = `shared field '${field}' (${where}) resolves to an asset whose GUID is catalogued`;
    const hint =
      'source SceneAsset is not catalogued: call registry.catalog(guid, payload) first, ' +
      'or load through loadByGuid() which auto-catalogs GUID-scoped assets';
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
  | MaterialResolvedEmptyPassesError
  | MeshSsboCapacityExceededError
  | MeshSsboCeilingReachedError
  | SceneCollectEntityRefOutOfClosureError
  | SceneCollectAssetGuidUnresolvedError;
