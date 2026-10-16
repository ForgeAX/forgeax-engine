// @forgeax/engine-runtime -- skin cluster error classes.
//
// feat-20260704-runtime-tier1-decomposition M2 / w8 (D-3): skin / skeleton
// animation cluster -- joint count / despawn / path / coexistence and
// extract-stage binding failures. Palette/material/GPU failures stay in the
// render error union because render owns the emitting frame stages. Binding
// class names, .code literals, and .detail shapes are preserved byte-for-byte
// (OOS-4).
//
// SkinExtractErrorCode (the 3-member extract-stage subset union) is kept as a
// named export and folded into SkinErrorCode, preserving the pre-existing
// public symbol (OOS-4).

// ── SkinExtractErrorCode subset union ───────────────────────────────────────

/**
 * feat-20260612-skin-palette-per-frame-upload M2 / m2-5 subset union.
 *
 * Covers the three new fail-fast extract-stage errors that fire from
 * `render-system-extract.ts` `hasSkin` segment when the per-frame palette
 * upload pipeline cannot resolve a slice for an entity. Single-entity
 * `continue` semantics: the entity is skipped, sibling entities in the
 * same frame keep extracting (plan-strategy D-5).
 *
 * | code | class | trigger |
 * |:--|:--|:--|
 * | `'skeleton-resolve-failed'` | `SkeletonResolveFailedError` | `assets.get<SkeletonAsset>(skin.skeleton)` returns null/undefined |
 * | `'joint-count-mismatch'` | `JointCountMismatchError` | `Skin.joints.length !== SkeletonAsset.jointCount` |
 * | `'joint-entity-dangling'` | `JointEntityDanglingError` | `Skin.joints[i]` Entity is despawned (GlobalTransform.world view undefined) |
 *
 * AI users discriminate via `switch (err.code)` over `RuntimeErrorCode`;
 * each member narrows to its `*Error` class with structured `.detail`.
 *
 * NOTE: distinct from the pre-existing `'skin-joint-despawned'` /
 * `'skin-joint-path-unresolved'` / `'skin-joint-count-exceeded'`
 * (advanceAnimationPlayer + post-spawn jointPath resolution); plan-strategy
 * D-4 forbids reusing those codes for the new extract-stage triggers.
 */
export type SkinExtractErrorCode =
  | 'skeleton-resolve-failed'
  | 'joint-count-mismatch'
  | 'joint-entity-dangling';

// ── SkinJointCountExceededError ────────────────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'skin-joint-count-exceeded'`.
 *
 * Emitted when a glTF skin has more than MAX_JOINTS (256) joints.
 */
export interface SkinJointCountExceededDetail {
  readonly jointCount: number;
  readonly max: number;
}

/**
 * Structured error for skin joint count exceeding the engine cap.
 *
 * Emitted during skin import/validation. Four-field surface:
 *   - `.code = 'skin-joint-count-exceeded'`
 *   - `.expected` — max allowed (256)
 *   - `.hint` — reduce joint count in the source asset
 *   - `.detail = { jointCount, max }` — actual vs limit
 */
export class SkinJointCountExceededError extends Error {
  readonly code = 'skin-joint-count-exceeded' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: SkinJointCountExceededDetail;

  constructor(jointCount: number, max = 256) {
    const expected = `jointCount <= ${max}`;
    const hint = `skin has ${jointCount} joints (max ${max}); reduce joint count in the source glTF asset (OOS-skin-many-joints)`;
    super(`skin joint count ${jointCount} exceeds max ${max}`);
    this.name = 'SkinJointCountExceededError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { jointCount, max };
  }
}

// ── SkinJointDespawnedError ─────────────────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'skin-joint-despawned'`.
 *
 * Emitted at extract time when a Skin.joints[i] Entity has been despawned.
 */
export interface SkinJointDespawnedDetail {
  readonly meshEntity: number;
  readonly jointIndex: number;
}

/**
 * Structured error for despawned skin joint Entity.
 *
 * Emitted at extract time; the mesh draw is fully skipped.
 *   - `.code = 'skin-joint-despawned'`
 *   - `.expected` — all Skin.joints alive
 *   - `.hint` — remove the Skin component or re-spawn joints
 *   - `.detail = { meshEntity, jointIndex }`
 */
export class SkinJointDespawnedError extends Error {
  readonly code = 'skin-joint-despawned' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: SkinJointDespawnedDetail;

  constructor(meshEntity: number, jointIndex: number) {
    const expected = `Skin.joints[${jointIndex}] references a live entity`;
    const hint = `joint[${jointIndex}] of entity ${meshEntity} has been despawned; remove Skin component or re-spawn the joint entity (OOS-skin-joint-respawn)`;
    super(`skin joint[${jointIndex}] despawned for entity ${meshEntity}`);
    this.name = 'SkinJointDespawnedError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { meshEntity, jointIndex };
  }
}

// ── SkinJointPathUnresolvedError ────────────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'skin-joint-path-unresolved'`.
 *
 * Emitted at post-spawn time when a jointPath leaf name cannot be found.
 */
export interface SkinJointPathUnresolvedDetail {
  readonly skinEntity: number;
  readonly path: readonly string[];
  readonly failedAtIndex: number;
}

/**
 * Structured error for unresolved jointPath post-spawn.
 *
 * Emitted by resolveSkinJoints when Name lookup fails.
 *   - `.code = 'skin-joint-path-unresolved'`
 *   - `.expected` — Name-bearing entity exists for each jointPath leaf
 *   - `.hint` — verify glTF node Name preservation in the importer
 *   - `.detail = { skinEntity, path, failedAtIndex }`
 */
export class SkinJointPathUnresolvedError extends Error {
  readonly code = 'skin-joint-path-unresolved' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: SkinJointPathUnresolvedDetail;

  constructor(skinEntity: number, path: readonly string[], failedAtIndex: number) {
    const leafName = path[failedAtIndex] ?? '<unknown>';
    const expected = `joint entity with Name="${leafName}" exists in the world`;
    const hint = `joint path "${path.join('/')}" for skin entity ${skinEntity} could not be resolved; verify glTF node names are preserved`;
    super(
      `joint path "${path.join('/')}" unresolved at index ${failedAtIndex} for entity ${skinEntity}`,
    );
    this.name = 'SkinJointPathUnresolvedError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { skinEntity, path, failedAtIndex };
  }
}

// ── SkinInstancesCoexistForbiddenError ──────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'skin-instances-coexist-forbidden'`.
 *
 * Emitted at extract time when Skin + Instances coexist on the same entity.
 */
export interface SkinInstancesCoexistForbiddenDetail {
  readonly entity: number;
}

/**
 * Structured error for Skin + Instances coexistence on same entity.
 *
 * Emitted at extract time; the entity draw is skipped.
 *   - `.code = 'skin-instances-coexist-forbidden'`
 *   - `.expected` — Skin and Instances on separate entities
 *   - `.hint` — split skinned meshes from instanced meshes into separate entities (OOS-skin-instances-coexist)
 *   - `.detail = { entity }`
 */
export class SkinInstancesCoexistForbiddenError extends Error {
  readonly code = 'skin-instances-coexist-forbidden' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: SkinInstancesCoexistForbiddenDetail;

  constructor(entity: number) {
    const expected = 'Skin and Instances must not coexist on the same entity';
    const hint = `entity ${entity} has both Skin and Instances; split skinned meshes from instanced meshes into separate entities (OOS-skin-instances-coexist)`;
    super(`Skin + Instances coexistence forbidden on entity ${entity}`);
    this.name = 'SkinInstancesCoexistForbiddenError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { entity };
  }
}

// ── SkeletonResolveFailedError ─────────────────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'skeleton-resolve-failed'`.
 *
 * Emitted at extract time when `assets.get<SkeletonAsset>(skin.skeleton)`
 * returns `null` / `undefined`. The skeleton handle is non-zero (the entity
 * declared a Skin) but the asset is not registered (importer drift /
 * AssetRegistry not warmed).
 */
export interface SkeletonResolveFailedDetail {
  readonly entity: number;
  readonly skeletonHandle: number;
}

/**
 * Structured error for unresolved SkeletonAsset handle at extract time
 * (feat-20260612-skin-palette-per-frame-upload M2 / m2-5).
 *
 * Emitted at extract time; the entity draw is skipped (continue), other
 * entities in the same frame keep extracting.
 *   - `.code = 'skeleton-resolve-failed'`
 *   - `.expected` — Skin.skeleton handle resolves to a registered SkeletonAsset
 *   - `.hint` — verify SkeletonAsset is imported into pack-index AND registered
 *     via AssetRegistry.register(handle, asset) before extractFrame
 *   - `.detail = { entity, skeletonHandle }`
 */
export class SkeletonResolveFailedError extends Error {
  readonly code = 'skeleton-resolve-failed' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: SkeletonResolveFailedDetail;

  constructor(entity: number, skeletonHandle: number) {
    const expected = `Skin.skeleton handle ${skeletonHandle} resolves to a registered SkeletonAsset`;
    const hint = `entity ${entity} Skin.skeleton handle ${skeletonHandle} is not registered; check that the SkeletonAsset went through the gltf importer into pack-index AND that AssetRegistry.register was called for the handle before extractFrame runs`;
    super(`Skin skeleton resolve failed on entity ${entity}: handle ${skeletonHandle}`);
    this.name = 'SkeletonResolveFailedError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { entity, skeletonHandle };
  }
}

// ── JointCountMismatchError ────────────────────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'joint-count-mismatch'`.
 *
 * Emitted at extract time when `Skin.joints.length !== SkeletonAsset.jointCount`.
 * `expected` is the SkeletonAsset's jointCount (the source of truth);
 * `actual` is the entity's `Skin.joints.length` (the runtime entity reference
 * list materialized at post-spawn time).
 */
export interface JointCountMismatchDetail {
  readonly entity: number;
  readonly expected: number;
  readonly actual: number;
}

/**
 * Structured error for SkinAsset.joints[] vs SkeletonAsset.jointCount disagreement
 * (feat-20260612-skin-palette-per-frame-upload M2 / m2-5).
 *
 * Emitted at extract time; the entity draw is skipped (continue).
 *   - `.code = 'joint-count-mismatch'`
 *   - `.expected` — Skin.joints.length === SkeletonAsset.jointCount
 *   - `.hint` — verify SkinAsset.joints[] and SkeletonAsset jointPaths[]
 *     come from the same glTF skin node
 *   - `.detail = { entity, expected, actual }`
 */
export class JointCountMismatchError extends Error {
  readonly code = 'joint-count-mismatch' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: JointCountMismatchDetail;

  constructor(entity: number, expected: number, actual: number) {
    const expectedStr = `Skin.joints.length === SkeletonAsset.jointCount (=${expected})`;
    const hint = `entity ${entity}: Skin.joints.length=${actual} disagrees with SkeletonAsset.jointCount=${expected}; verify SkinAsset.joints[] and SkeletonAsset jointPaths[] come from the same glTF skin node`;
    super(
      `joint count mismatch on entity ${entity}: SkeletonAsset.jointCount=${expected}, Skin.joints.length=${actual}`,
    );
    this.name = 'JointCountMismatchError';
    this.expected = expectedStr;
    this.hint = hint;
    this.detail = { entity, expected, actual };
  }
}

// ── JointEntityDanglingError ──────────────────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'joint-entity-dangling'`.
 *
 * Emitted at extract time when `Skin.joints[i]` points at an Entity that has
 * been despawned (or lost its Transform component) so
 * `worldInternal._getArrayView(jointEntity, GlobalTransform, 'world')` returns
 * undefined. `jointIndex` is the position within `Skin.joints[]`.
 */
export interface JointEntityDanglingDetail {
  readonly entity: number;
  readonly jointIndex: number;
}

/**
 * Structured error for despawned (or Transform-less) joint Entity at extract
 * time (feat-20260612-skin-palette-per-frame-upload M2 / m2-5).
 *
 * Distinct from the pre-existing `SkinJointDespawnedError` which fires from
 * advanceAnimationPlayer (animation-stage); this one fires from extractFrame
 * (palette-upload stage) when the per-joint world mat4 view is missing.
 *
 * Emitted at extract time; the entity draw is skipped (continue).
 *   - `.code = 'joint-entity-dangling'`
 *   - `.expected` — Skin.joints[i] references a live Entity with Transform
 *   - `.hint` — sync Skin.joints[] when joint entities are despawned, or
 *     re-import the scene through the gltf importer to refresh Entity refs
 *   - `.detail = { entity, jointIndex }`
 */
export class JointEntityDanglingError extends Error {
  readonly code = 'joint-entity-dangling' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: JointEntityDanglingDetail;

  constructor(entity: number, jointIndex: number) {
    const expected = `Skin.joints[${jointIndex}] references a live Entity with Transform`;
    const hint = `entity ${entity} Skin.joints[${jointIndex}] points at a despawned (or Transform-less) Entity; sync Skin.joints[] when joint entities are despawned, or re-import the scene through the gltf importer to refresh Entity references`;
    super(`joint entity dangling on entity ${entity} at jointIndex ${jointIndex}`);
    this.name = 'JointEntityDanglingError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { entity, jointIndex };
  }
}

/** Missing automatic SkinAsset metadata during ordinary Scene instantiation. */
export class SkinAssetUnresolvedError extends Error {
  readonly code = 'skin-asset-unresolved' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly skinEntity: number; readonly skeletonHandle: number };

  constructor(skinEntity: number, skeletonHandle: number) {
    super(`SkinAsset unresolved for entity ${skinEntity}: skeleton handle ${skeletonHandle}`);
    this.name = 'SkinAssetUnresolvedError';
    this.expected = `SkinAsset registered for skeleton handle ${skeletonHandle} during Scene instantiation`;
    this.hint =
      'verify the SceneAsset.skinGuids cross-edge and load its SkinAssets before instantiation';
    this.detail = { skinEntity, skeletonHandle };
  }
}

// -- SkinErrorCode / SkinError closed unions ------------------------------------

/**
 * Closed union of skin-cluster error codes derived from the correlated error
 * union. AI users perform exhaustive `switch (err.code)` without default; TS
 * guards completeness.
 */
export type SkinErrorCode = SkinError['code'];

/**
 * Closed union of the skin-cluster structured error classes, each carrying a
 * `SkinErrorCode` discriminant on `.code`.
 */
export type SkinError =
  | SkinAssetUnresolvedError
  | SkinJointCountExceededError
  | SkinJointDespawnedError
  | SkinJointPathUnresolvedError
  | SkinInstancesCoexistForbiddenError
  | SkeletonResolveFailedError
  | JointCountMismatchError
  | JointEntityDanglingError;
