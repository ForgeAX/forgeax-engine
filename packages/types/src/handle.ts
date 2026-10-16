// @forgeax/engine-types - Handle<T,M> brand + AssetTagMap + TagOf + 3 helpers SSOT.
//
// Single physical source-of-truth (feat-20260517-handle-type-unify M1 / D-2 / D-4 / D-7).
// The package barrel `index.ts` re-exports this file; AI users import the
// brand and helpers via `@forgeax/engine-types`, and IDE hover lands on this
// file (charter F1 single-entry indexability).
//
// Contents (charter P4 consistent abstraction - 5 co-located building blocks):
//   - type Handle<T extends string, M extends 'unique' | 'shared'>
//     (double-axis phantom brand on top of `number`)
//   - type UniqueHandle<T> / SharedHandle<T> (mode-pinned aliases)
//   - interface AssetTagMap (14-member closed map mesh/texture/cube-texture/sampler/material/scene/audio/skin/skeleton/animation-clip/shader/font/render-pipeline/tileset/video)
//   - type TagOf<T extends Asset> (distributive conditional - 14+1 never tail)
//   - function toUnique<T>(raw) / toShared<T>(raw) (brand creation factories)
//   - function unwrapHandle<T,M>(h) (brand removal helper - cast inverse)
//
// The single `as Handle<T, M>` cast inside each factory is the brand-creation
// structural cast (D-7 + AC-01 exemption); all other call sites must route
// through these factories or `unwrapHandle` so that no `as unknown as Handle`
// or `as unknown as number` literal survives anywhere outside this file
// (AC-01 grep gate, M3 / M4 cleanup).
//
// Charter mapping: F1 (single-entry IDE autocomplete from
// `@forgeax/engine-types`) + P3 (cross-mode rejection is a TS compile-time
// failure red line) + P4 (consistent abstraction: brand + map + 3 factories
// + 1 distributive conditional all co-located in this 1 file).

import type { Asset } from './index';

/**
 * Phantom-branded Handle: a `number` carrying two type tags.
 *
 * @typeParam T - asset target tag (string literal, e.g. `'MeshAsset'`)
 * @typeParam M - release mode: `'unique'` (ECS-tracked via UniqueRefStore)
 *   or `'shared'` (external owner, e.g. `AssetRegistry`)
 *
 * Runtime representation is a u32 number so the GPU upload path
 * (`GPUBuffer.writeBuffer(slot, ...)`) keeps zero-cost passthrough; only the
 * TS layer enforces non-assignability across modes / targets via the
 * `__handle` phantom field. The `__handle` field is type-only - runtime
 * objects never carry it (charter P4 zero-overhead abstraction).
 *
 * Cross-tag rejection: `Handle<'MeshAsset', M>` is not assignable to
 * `Handle<'TextureAsset', M>` and vice versa (the brand `target` field
 * differs).
 *
 * Cross-mode rejection: `Handle<T, 'unique'>` is not assignable to
 * `Handle<T, 'shared'>` and vice versa (the brand `mode` field differs);
 * this is the TS compile-time wall that prevents accidentally feeding a
 * unique-mode handle to a registry that owns its own release lifecycle (charter
 * P3 explicit failure red line; tests live in
 * `packages/types/src/__tests__/handle-brand.test-d.ts` and
 * `packages/ecs/src/__tests__/handle.test-d.ts`).
 *
 * AI users do not write `as Handle<...>` - handles come from registry
 * factories (`engine.assets.register<T>(asset).unwrap()` produces
 * `Handle<TagOf<T>, 'shared'>`; `world.uniqueRefs.alloc<T>(value)`
 * produces `Handle<T, 'unique'>` after M2). The only `as Handle` literal in the
 * codebase is the brand-creation cast inside `toUnique` / `toShared`
 * below (AC-01 exemption).
 */
export type Handle<T extends string, M extends 'unique' | 'shared'> = number & {
  readonly __handle: { readonly target: T; readonly mode: M };
};

/**
 * Convenience alias - unique-mode handle for asset target `T`.
 *
 * Intended for ECS-internal consumption (column slot read sites in the
 * unique-ref store, M2 rename). The `@forgeax/engine-ecs` barrel does NOT
 * re-export this alias name (AC-15 grep gate - keeps the AI-facing surface
 * narrow); callers outside ecs continue to write `Handle<T, 'unique'>`
 * literally.
 *
 * Schema vocab `'unique<T>'` derives the column field type to this alias via
 * `FieldValueType<T>` conditional inference (see
 * `packages/ecs/src/component.ts`).
 */
export type UniqueHandle<T extends string> = Handle<T, 'unique'>;

/**
 * Convenience alias - shared-mode handle for asset target `T`.
 *
 * Mirrors `UniqueHandle<T>` for the refcounted-owner side; surfaces on
 * `AssetRegistry.register<T>` return signatures and `MeshFilter.assetHandle`
 * column type. Re-exported by the `@forgeax/engine-ecs` barrel (alongside
 * `Handle`) so AI users importing from ecs see the alias - this remains
 * subordinate to writing `Handle<T, 'shared'>` literally.
 *
 * Schema vocab `'shared<T>'` derives the column field type to this alias
 * via `FieldValueType<T>` conditional inference (feat-20260614 M5).
 */
export type SharedHandle<T extends string> = Handle<T, 'shared'>;

/**
 * Asset.kind tag map - 13-member closed map keying each Asset variant
 * `kind` literal to its TS type name string literal (D-1 path (a)).
 *
 * Used by `TagOf<T>` distributive conditional below to derive the brand
 * `target` tag from an Asset variant TS type at register / inference time;
 * AI users adding a new Asset variant minor-add the corresponding
 * `kind -> 'XxxAsset'` row here so that `register<NewVariant>(asset)` returns
 * the correct `Handle<'XxxAsset', 'shared'>` automatically (this map is
 * the single must-edit point per Asset addition - charter F1 single-entry
 * indexability).
 *
 * The 13 members align byte-for-byte with the closed `Asset` union; adding
 * a new member to `Asset` without adding a row here surfaces as a
 * `TagOf<NewAsset>` resolving to `never` (charter P3 explicit failure -
 * downstream `register<NewAsset>` calls fail to compile).
 */
export interface AssetTagMap {
  plugin: 'PluginAsset';
  mesh: 'MeshAsset';
  terrain: 'TerrainAsset';
  'navigation-mesh': 'NavigationMeshAsset';
  texture: 'TextureAsset';
  equirect: 'EquirectAsset';
  sampler: 'SamplerAsset';
  material: 'MaterialAsset';
  scene: 'SceneAsset';
  audio: 'AudioClipAsset';
  /** feat-20260523-skin-skeleton-animation M0 */
  skin: 'SkinAsset';
  /** feat-20260523-skin-skeleton-animation M0 */
  skeleton: 'SkeletonAsset';
  /** feat-20260523-skin-skeleton-animation M0 */
  'animation-clip': 'AnimationClip';
  /** feat-20260713-animation-state-machine-plugin M2 / w13 */
  'animation-graph': 'AnimationGraph';
  /** feat-20260528-material-shader-registration-unification M1 / w1 */
  /** feat-20260531-world-space-msdf-text-rendering M2 / w5 */
  font: 'FontAsset';
  /** feat-20260601-customizable-render-pipeline-seam-and-dogfood-rend M1 / w5 */
  'render-pipeline': 'RenderPipelineAsset';
  /** feat-20260608-tilemap-object-layer-rendering M0 baseline rebuild */
  tileset: 'TilesetAsset';
  /** feat-20260623-world-space-video-asset M1 / w2 */
  video: 'VideoAsset';
  /** feat-20260728-wave1-vfx-contract-and-asset-cook M1 / m1-i1 */
  'particle-effect': 'ParticleEffectAsset';
  'ies-profile': 'IesProfileAsset';
}

/**
 * Distributive conditional - maps an Asset variant TS type to its brand
 * `target` tag string literal (D-1 path (a)).
 *
 * `TagOf<MeshAsset>` resolves to `'MeshAsset'`; `TagOf<MaterialAsset>`
 * resolves to `'MaterialAsset'` even though `MaterialAsset` is itself the
 * pass-based single interface (MaterialAsset) - the
 * distributive conditional resolves to 'MaterialAsset' via kind: 'material'
 * collapse onto `'MaterialAsset'` because both share `kind: 'material'`
 * (research Finding 2).
 *
 * Asset variants without a matching `AssetTagMap` row (or a `kind` literal
 * outside the 5 closed values) resolve to `never`, surfacing the missing
 * row at every downstream `register<T>` consumer site (charter P3 explicit
 * failure).
 */
export type TagOf<T extends Asset> = T extends { kind: infer K }
  ? K extends keyof AssetTagMap
    ? AssetTagMap[K]
    : never
  : never;

/**
 * Construct a `Handle<T, 'unique'>` from a raw u32. Brand-creation
 * structural cast - the `as Handle<T, 'unique'>` literal here is the
 * AC-01 exemption single point of brand creation (D-7); all other call
 * sites must route through this factory.
 *
 * Used by `World.allocUniqueRef<T>(value)` (M2 rename of allocUniqueRef)
 * to brand fresh handles that the ECS will track via the per-row release
 * loop. AI users typically
 * do not call this directly - it is the brand-creation primitive that the
 * ecs / runtime layers wrap.
 */
export function toUnique<T extends string>(raw: number): Handle<T, 'unique'> {
  return raw as Handle<T, 'unique'>;
}

/**
 * Construct a `Handle<T, 'shared'>` from a raw u32. Brand-creation
 * structural cast - the `as Handle<T, 'shared'>` literal here is the
 * AC-01 exemption single point of brand creation (D-7).
 *
 * Used by `AssetRegistry.register<T>(asset).unwrap()` to brand the returned handle
 * with `Handle<TagOf<T>, 'shared'>`, and by builtin handle constants
 * (`HANDLE_CUBE` / `HANDLE_TRIANGLE` / `HANDLE_ROOM_CUBE` / `BUILTIN_HANDLE_*`)
 * to brand compile-time u32 literals without caller-side `as unknown as`
 * casts (AC-05).
 */
export function toShared<T extends string>(raw: number): Handle<T, 'shared'> {
  return raw as Handle<T, 'shared'>;
}

/**
 * Remove the `Handle<T, M>` brand and recover the raw u32 carried inside.
 * Brand-removal helper - the inverse of `toUnique` / `toShared`.
 *
 * Runtime is identity (the brand `__handle` field is type-only; the
 * underlying number value is unchanged); the helper exists purely to
 * collapse all `as unknown as number` cast sites into a single function so
 * that AC-01 grep can surface stragglers (D-7 / D-8 cast collapse plan).
 *
 * Public on the types barrel (parallel to `toUnique` / `toShared`):
 * column read sites in unique-ref-store (M2 rename) / scene-instance-container,
 * AssetRegistry internal `Map<number, ...>` key reads, and any AI-user
 * code that needs to bridge a branded handle to a numeric ABI all call
 * this. AI users on the typical spawn-site / register-site surface
 * usually do not need it (charter P1 progressive disclosure — handle
 * stays branded end-to-end), but when a numeric escape is required this
 * is the single sanctioned escape.
 */
export function unwrapHandle<T extends string, M extends 'unique' | 'shared'>(
  h: Handle<T, M>,
): number {
  return h;
}

/**
 * Slot boundary between the builtin tier and the user tier (feat-20260614 M6
 * D-15 / D-16). Builtin asset handles (the 5 process-static meshes:
 * HANDLE_CUBE=1 .. HANDLE_NINESLICE_QUAD=5) occupy slots `[1, BUILTIN_BASE)`;
 * user-tier handles minted by `World.sharedRefs.alloc` start at `BUILTIN_BASE`.
 *
 * Defined here in `@forgeax/engine-types` — the single dependency shared by
 * both `@forgeax/engine-ecs` (SharedRefStore `nextSlot` init + builtin-slot
 * fail-fast) and `@forgeax/engine-runtime` (BuiltinAssetRegistry resolve
 * dispatch + AssetRegistry index) — so the boundary is one named constant with
 * no cross-package circular dependency. Value 1024 is the historic
 * `FIRST_USER_HANDLE` literal, promoted to the shared SSOT.
 */
export const BUILTIN_BASE = 1024;

// === Gen-slot codec SSOT (feat-20260623-asset-handle-generation M1 / w2) ==========
//
// Domain-agnostic pure bit operations — max-slot, max-gen, pack, unpack-slot,
// unpack-gen, and the retire predicate (isRetiredSlot: gen > MAX_GEN, so gen
// 255 is usable and a slot retires only when its bump would reach 256). This
// is the single definition point
// for the `(gen << 24) | slot` layout across entity and asset handles (D-1,
// AC-15). Callers (ecs / runtime / ref stores) import from
// @forgeax/engine-types; entity-side overflow throw and sentinel stay in ecs
// (D-1). No domain concepts live here — just mask and shift.
//
// Bit layout (OOS-3: 32-bit number, 24-bit slot + 8-bit gen):
//   - slot: bits [0, 23], max value (1 << 24) - 1 = 16_777_215
//   - gen:  bits [24, 31], max value 0xff = 255
//
// pack(slot, gen) fixed to (((gen & 0xff) << 24) | (slot & 0xffffff)) >>> 0
// per D-7 hard constraint — the `>>> 0` prevents ToInt32 negative when
// gen >= 128 (entity-handle.ts:73 comment documents this trap).

/** Maximum slot index (2^24 - 1 = 16_777_215). */
export const MAX_SLOT = (1 << 24) - 1;

/** Maximum generation value (2^8 - 1 = 255). */
export const MAX_GEN = 0xff;

/**
 * Pack (slot, gen) into a u32 handle.
 *
 * The caller is responsible for ensuring slot does not exceed MAX_SLOT;
 * values above 24 bits are masked by `slot & 0xffffff`. Generation is
 * masked to 8 bits via `gen & 0xff`. The `>>> 0` forces unsigned u32
 * representation — without it, gen >= 128 produces a signed-negative
 * ToInt32 (D-7 hard constraint, entity-handle.ts:73).
 */
export function pack(slot: number, gen: number): number {
  return (((gen & 0xff) << 24) | (slot & 0xffffff)) >>> 0;
}

/** Extract the low 24 bits (slot) from a packed u32 handle. */
export function unpackSlot(v: number): number {
  return v & 0xffffff;
}

/** Extract the high 8 bits (generation) from a packed u32 handle. */
export function unpackGen(v: number): number {
  return (v >>> 24) & 0xff;
}

/**
 * Retire-when-gen-exceeds-MAX_GEN semantic: returns `true` when gen has
 * exceeded MAX_GEN (255), i.e. gen 255 is still a usable handle; a slot
 * retires only when its bumped generation reaches 256. A retired slot
 * never returns to the free list (AC-07).
 */
export function isRetiredSlot(gen: number): boolean {
  return gen > MAX_GEN;
}

// === Handle inspection helpers (feat-20260623-asset-handle-generation M1 / w2) ====
//
// Thin wrappers over the shared codec for Handle<T, M> consumers. handleSlot
// and handleGeneration internally call unpackSlot / unpackGen — these are the
// migration targets for unwrapHandle sites that only need the slot or gen
// (decision q4). unwrapHandle stays as-is for sites that need the full
// encoded value (D-5 excluded round-trip sites).

/**
 * Extract the slot (low 24 bits) from a branded Handle.
 *
 * This is the runtime identity of the handle — the slot index that maps to
 * store payloads / GPU resource keys. Call sites that currently use
 * `unwrapHandle(h)` as a Map key should migrate here so the key stays stable
 * when gen > 0 (AC-09).
 */
export function handleSlot<T extends string, M extends 'unique' | 'shared'>(
  h: Handle<T, M>,
): number {
  return unpackSlot(h as unknown as number);
}

/**
 * Extract the generation (high 8 bits) from a branded Handle.
 *
 * Used by store-level gen comparisons (resolve/retain/release) to detect
 * stale handles — the gen embedded during alloc is compared against the
 * store's current gen for the same slot.
 */
export function handleGeneration<T extends string, M extends 'unique' | 'shared'>(
  h: Handle<T, M>,
): number {
  return unpackGen(h as unknown as number);
}
