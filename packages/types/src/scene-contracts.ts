// === Package interface (feat-20260618-asset-and-pack-name-fields M1 / w2) ======
//
// Decision anchors:
//   - plan-strategy D-7 (Package interface in @forgeax/engine-types, same layer
//     as Asset union, for multi-package consumer discoverability per charter F1)
//   - architecture-principles #2 (Derive, Don't Duplicate): assetCount is
//     derived from assetGuids.size, never stored independently
//   - plan-strategy D-5 (builtin assets -> null Package, not a synthetic path)
//   - Package does not carry a `name` field — resolved names flow through
//     resolveName (D-6), not stored on Package
//
// AI users discover Package via IDE autocomplete on @forgeax/engine-types;
// the runtime AssetRegistry.packageOf Map carries Package | null per guid.

/**
 * Runtime view of one import-source package -- the grouping unit for
 * the two-segment asset identity (`<packagePath>.<name>`).
 *
 * `path` is the import file path (e.g. `'assets/hero.glb'`).  Multiple
 * assets imported from the same source file share one `Package`.
 *
 * `assetGuids` lists every GUID that belongs to this package.  The
 * runtime keeps it in sync with `registerPackage` insertions.
 *
 * `assetCount` is a derived view (`assetGuids.size`); it is **not**
 * stored as a standalone field (Derive axiom #2).
 */
export interface Package {
  readonly path: string;
  readonly assetGuids: ReadonlySet<string>;
  readonly assetCount: number;
}

// === Scene asset POD shape ======================================================
//
// SceneAsset is the authoring and decoded model. The key in `entities` is the
// only persistent scene-local identity. Runtime SceneInstance mapping remains
// an implementation detail of the Scene owner and is deliberately absent from
// this package contract.
//
// The unique-symbol brand stays private to this module so the brand
// identity is anchored exactly here; consumers refer to LocalEntityId
// as opaque number subtypes.

declare const LocalEntityIdBrand: unique symbol;

/**
 * Runtime SceneInstance slot brand (u32).
 *
 * This brand exists for the transient Scene owner projection only. It is not
 * part of the keyed SceneAsset authoring or decoded payload contract.
 */
export type LocalEntityId = number & { readonly [LocalEntityIdBrand]: void };

/** A stable, non-empty scene-local author key. Slashes are ordinary characters. */
export type SceneEntityKey = string;

/**
 * An entity address in the scene that declares the reference. A string names
 * an entity in that scene; an array walks named instance entities and finishes
 * at an entity in the selected child scene.
 */
export type SceneEntityAddress = string | readonly [string, ...string[]];

/**
 * Open map shape from component name to the per-component value record
 * authored on a `SceneEntity` (feat-20260514 w2).
 *
 * The map is keyed by component-token name (`'Transform' | 'MeshFilter' |
 * 'ChildOf' | ...`) and each per-component record is a free-form
 * `Record<string, unknown>` POD shape; the precise field types live in the
 * ecs `defineComponent(...)` schema (one layer up). This package stays
 * math-free + ecs-free; the layered alignment with the ecs schema vocab is
 * documented in plan-strategy §3.1 types_pkg sub-graph and tested by w3 /
 * w22 at the ecs / runtime layer.
 *
 * Open shape is intentional: components evolve via add-only minor in their
 * own packages; locking this map to a closed union here would force an edit
 * in @forgeax/engine-types every time a new component appears (charter
 * proposition 5 consistent abstraction — registration discipline owned by
 * each component's defineComponent site).
 */
export type ComponentValuesMap = {
  readonly [componentName: string]: Readonly<Record<string, unknown>>;
};

/**
 * Single keyed SceneEntity POD shape.
 *
 * The containing SceneAsset key is the only persistent identity. The partial
 * component map lets component defaults fill fields at instantiate time.
 */
export interface SceneEntity {
  readonly components: Partial<ComponentValuesMap>;
  /** Optional nested SceneAsset declaration owned by this entity. */
  readonly instance?: SceneInstanceDeclaration;
}

/** Ordered explicit component updates applied to a nested scene instance. */
export interface SceneInstanceOverride {
  /** Address relative to the nested source scene. */
  readonly target: readonly [string, ...string[]];
  /** Component fields are validated using the target component schemas. */
  readonly components: Partial<ComponentValuesMap>;
}

/**
 * Nested scene declaration attached to a named entity. `source` is a producer
 * GUID in the public model; pack refs indices are resolved by the decoder and
 * never leak into authored data.
 */
export interface SceneInstanceDeclaration {
  readonly source: string;
  readonly overrides?: readonly SceneInstanceOverride[];
}

/**
 * Scene asset POD shape.
 *
 * The keyed entities and nested `instance` declarations are the complete
 * authoring and decoded model. Runtime numeric mappings remain private to the
 * Scene owner.
 */
export interface SceneAsset {
  readonly kind: 'scene';
  /** Stable named author entities; object insertion order is not semantic. */
  readonly entities: Readonly<Record<SceneEntityKey, SceneEntity>>;
  /**
   * GUIDs of `SkinAsset`s the scene's skinned entities reference (one per
   * SkeletonAsset bound by a `Skin: { skeleton }` component). SkinAssets are
   * not reachable through any `handle<*>` field on a SceneEntity component
   * (`Skin.skeleton` carries the SkeletonAsset GUID; the SkinAsset itself is
   * a sibling identified by matching `skeletonGuid`), so the scene's pack
   * load chain has to surface them explicitly. Without this list the
   * browser-async-pack-fetch path would never load SkinAssets, leaving
   * `postSpawnResolveJoints` unable to populate `Skin.joints[]` and the
   * extract pass fail-fasting on `Skin.joints.length=0` every frame
   * (feat-20260612-skin-palette-per-frame-upload M2 fixup).
   *
   * On disk: refs[] indices for skin asset dependencies.
   * Post-parseScenePayload: GUID strings (resolved via refs[]).
   * Enumerated in the scene envelope's `refs[]` (the recursion source) so
   * `loadByGuid<SceneAsset>` recursively pulls each SkinAsset before
   * `instantiate`.
   */
  readonly skinGuids?: readonly string[];
}
