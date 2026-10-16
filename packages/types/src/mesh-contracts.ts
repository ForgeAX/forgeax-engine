// Mesh, texture, and material asset primitives.
/// <reference types="@webgpu/types" />
import type { AssetCodec, Integrity } from './asset.js';
import type { AssetGuid } from './image-pack-contracts.js';
import type { VertexAttributeMap } from './media-contracts.js';
import type { MeshDistanceField } from './mesh-distance-field.js';

export type {
  DistanceFieldPolicy,
  FieldBounds,
  FieldVec3,
  MeshDistanceField,
} from './mesh-distance-field.js';

import type { MeshLodLevel } from './mesh.js';
import type { PrimitiveTopology } from './primitive-topology.js';

export type { TextureAsset } from './texture/asset.js';

// === Asset system v1 SSOT (feat-20260511-asset-system-v1) ======================
//
// Decision anchors:
// - requirements §G7 + §2 row 8 + AC-09 / AC-15 / AC-21 (4-variant Asset
//   discriminated union, 14-key VertexAttributeMap closed set,
//   AssetErrorCode 4-member closed union elevated to TS alias)
// - plan-strategy §2 D-P1 (@forgeax/engine-types single-file SSOT for
//   Asset union + AssetErrorCode; 4-member AssetErrorCode independent from
//   RhiErrorCode, AI users discover through one-line import)
// - plan-strategy §7.2 (lowercase key alignment with Three.js r184
//   BufferGeometry mental migration; D-P5 preserves segments 6 params)
// - plan-strategy §7.3 (AssetError .hint strings per error code, verbatim)
// - charter proposition 1 (single-entry IDE autocomplete via
//   `@forgeax/engine-types`) + proposition 3 (machine-readable union >
//   prose) + proposition 4 (explicit failure - exhaustive switch needs no
//   default fallback) + proposition 5 (consistent abstraction - structurally
//   parallel to RhiError / InspectorError / MetricError 4-field surface)
// - architecture-principles #1 SSOT (4 literals + shape live here once;
//   @forgeax/engine-runtime AssetRegistry / tests / AGENTS.md Error model
//   table all reference this module)

/**
 * Mesh asset POD shape aligned with Three.js r184 BufferGeometry mental
 * model (plan-strategy §7.2 naming convention). `vertices` is the interleaved
 * or primary position buffer; `indices` narrows to `Uint16Array | Uint32Array`
 * per WebGPU spec index format; `attributes` is the VertexAttributeMap
 * lowercase-key closed set.
 *
 * Canonical lowercase keys include position, normal, uv, tangent, skinIndex,
 * skinWeight, uv1..uv7 and optional linear RGBA color.
 *
 * Designed for M3 GLTF loader single-layer mapping
 * (`POSITION -> position` / `TEXCOORD_0 -> uv` etc.) without runtime rename.
 */
/** Static, welded collision geometry produced from the mesh's triangle sections. */
export interface MeshCollision {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

export interface MeshAsset {
  readonly kind: 'mesh';
  /** Opt-in build-time collision product; source mesh GUID and lifecycle remain authoritative. */
  readonly collision?: MeshCollision;
  readonly vertices: Float32Array;
  /**
   * Index buffer. Optional: vertex-only meshes (point-list / line-list with no
   * shared vertices) omit it, and the engine takes a non-indexed draw path
   * (`pass.draw(vertexCount)` instead of `pass.drawIndexed`). When present the
   * indexed path is byte-for-byte unchanged.
   */
  readonly indices?: Uint16Array | Uint32Array;
  readonly attributes: VertexAttributeMap;
  /**
   * Axis-aligned bounding box in local space: 6 floats [minX, minY, minZ, maxX, maxY, maxZ].
   *
   * Producer obligation: every MeshAsset MUST carry a computed `aabb` from its
   * position attribute. Built-in producers (glTF, FBX, geometry factories)
   * fill it automatically via `box3.fromPositions` -- the single
   * authoritative implementation in @forgeax/engine-math.
   *
   * When `aabb` is `undefined`, the pick() broad-phase and frustum culling
   * silently skip the mesh -- pick() returns `undefined` for every ray query
   * against it with no diagnostic signal. AI users hand-writing MeshAsset
   * must self-check that `aabb` is populated.
   *
   * Empty / degenerate position input (0 vertices) produces an
   * inverted-infinity empty box (min = +Infinity, max = -Infinity).
   * Consumers reject this for picking (min.x > max.x) and may skip it
   * for culling.
   *
   * The bare Float32Array keeps engine-types math-free (no Box3 branded
   * type dependency). Consumers narrow to the math-layer Box3 via
   * `as Box3Like`.
   */
  readonly aabb?: Float32Array;
  /**
   * Submeshes partition the index/vertex range into independent draw calls,
   * each with its own topology (one of the 5 WebGPU primitives:
   * 'point-list' | 'line-list' | 'line-strip' | 'triangle-list' | 'triangle-strip').
   *
   * Every mesh must declare at least one submesh. The engine draws one
   * `drawIndexed` (or `draw` for vertex-only) per submesh entry, and pairs
   * them with `MeshRenderer.materials[]` by index position.
   *
   * Must be non-empty: an empty array triggers a `mesh-asset-submeshes-empty`
   * AssetError at register-time (fail-fast, charter P3 explicit failure).
   */
  readonly submeshes: readonly Submesh[];
  /** Offline local-space representation of the entire static mesh. */
  readonly cardLayout?: MeshCardLayout;
  /** Optional validated offline visibility data, loaded with this mesh publication. */
  readonly distanceField?: MeshDistanceField & {
    readonly sectionSidedness: readonly (0 | 1)[];
    /** Verified publication facts; absent on a generated field before artifact admission. */
    readonly artifact?: { readonly integrity: Integrity; readonly assetCodec: AssetCodec };
  };
  /** Stable, mesh-owned material entry points shared by every instance. */
  readonly materialSlots: readonly MeshMaterialSlot[];
  /** Ordered lower-detail MeshAsset references; the root remains LOD0. */
  readonly lods?: readonly MeshLodLevel[];
  /** Fractional LOD boundary band; Standard GPU draws crossfade within it. Zero disables the band. */
  readonly lodHysteresis?: number;
  /** Target-major dense morph deltas. */
  readonly morphTargets?: readonly MorphTarget[];
  /** Authored default weights, one value per morph target when present. */
  readonly morphWeights?: Float32Array;
}

export interface MorphTarget {
  readonly position?: Float32Array;
  readonly normal?: Float32Array;
  readonly tangent?: Float32Array;
}

/** Mesh-owned default binding for one stable material slot. */
export interface MeshMaterialSlot {
  /** Unique, non-empty display/tooling name within the mesh. */
  readonly slotName: string;
  /** Producer-owned stable identity used to preserve slot indices on reimport. */
  readonly sourceKey?: string;
  /** Missing means the slot intentionally inherits the neutral engine material. */
  readonly defaultMaterial?: AssetGuid;
}

/** JSON-safe producer topology persisted beside an imported Mesh output. */
export interface MeshMaterialSlotTopologyEntry {
  readonly slotName: string;
  readonly sourceKey?: string;
  readonly defaultMaterialGuid?: string;
  /** Persisted removed-slot identity; never participates in cooked bindings. */
  readonly tombstone?: true;
}

/** Resolve the persisted source/authoring layers to the one runtime Mesh default. */
export function resolveMeshMaterialSlotDefaultGuid(
  slot: MeshMaterialSlotTopologyEntry,
  authoredDefaultMaterialGuid?: string | null,
): string | undefined {
  if (authoredDefaultMaterialGuid !== undefined) {
    return authoredDefaultMaterialGuid === null ? undefined : authoredDefaultMaterialGuid;
  }
  return slot.defaultMaterialGuid;
}

export interface MeshMaterialSlotTopologyChange {
  readonly code: 'mesh-material-slot-topology-change';
  readonly previousIndices: readonly number[];
  readonly nextIndices: readonly number[];
  readonly hint: string;
}

export type MeshMaterialSlotReconcileResult =
  | {
      readonly ok: true;
      readonly slots: readonly MeshMaterialSlotTopologyEntry[];
      /** New source-order slot index -> stable persisted slot index. */
      readonly currentToStableSlot: readonly number[];
    }
  | { readonly ok: false; readonly error: MeshMaterialSlotTopologyChange };

/**
 * Preserve positional renderer overrides across source reimport.
 *
 * Stable sourceKey wins, then a unique slotName. A single remaining pair is
 * the only unambiguous source-order fallback. Removed slots remain as
 * defaultless tombstones; new slots append, so an old index never silently
 * starts naming a different source material.
 */
export function reconcileMeshMaterialSlotTopology(
  current: readonly MeshMaterialSlotTopologyEntry[],
  previous: readonly MeshMaterialSlotTopologyEntry[] = [],
): MeshMaterialSlotReconcileResult {
  if (previous.length === 0) {
    return { ok: true, slots: [...current], currentToStableSlot: current.map((_, index) => index) };
  }

  const stable: MeshMaterialSlotTopologyEntry[] = previous.map((slot) => ({
    slotName: slot.slotName,
    ...(slot.sourceKey === undefined ? {} : { sourceKey: slot.sourceKey }),
    tombstone: true,
  }));
  const mapping = new Array<number>(current.length).fill(-1);
  const usedPrevious = new Set<number>();

  const uniqueIndex = (
    slots: readonly MeshMaterialSlotTopologyEntry[],
    read: (slot: MeshMaterialSlotTopologyEntry) => string | undefined,
  ): Map<string, number> => {
    const first = new Map<string, number>();
    const duplicates = new Set<string>();
    slots.forEach((slot, index) => {
      const key = read(slot)?.trim();
      if (!key) return;
      if (first.has(key)) duplicates.add(key);
      else first.set(key, index);
    });
    for (const duplicate of duplicates) first.delete(duplicate);
    return first;
  };

  const match = (read: (slot: MeshMaterialSlotTopologyEntry) => string | undefined): void => {
    const oldByKey = uniqueIndex(previous, read);
    const nextByKey = uniqueIndex(current, read);
    for (const [key, nextIndex] of nextByKey) {
      if (mapping[nextIndex] !== -1) continue;
      const oldIndex = oldByKey.get(key);
      if (oldIndex === undefined || usedPrevious.has(oldIndex)) continue;
      mapping[nextIndex] = oldIndex;
      usedPrevious.add(oldIndex);
    }
  };

  match((slot) => slot.sourceKey);
  match((slot) => slot.slotName);

  const unmatchedCurrent = mapping
    .map((oldIndex, index) => (oldIndex === -1 ? index : -1))
    .filter((index) => index !== -1);
  const unmatchedPrevious = previous
    .map((_, index) => (usedPrevious.has(index) ? -1 : index))
    .filter((index) => index !== -1);
  if (
    unmatchedCurrent.length === 1 &&
    unmatchedPrevious.length === 1 &&
    current[unmatchedCurrent[0] as number]?.sourceKey === undefined &&
    previous[unmatchedPrevious[0] as number]?.sourceKey === undefined
  ) {
    mapping[unmatchedCurrent[0] as number] = unmatchedPrevious[0] as number;
    usedPrevious.add(unmatchedPrevious[0] as number);
    unmatchedCurrent.length = 0;
    unmatchedPrevious.length = 0;
  }
  const identityInsufficient =
    unmatchedCurrent.some((index) => current[index]?.sourceKey === undefined) &&
    unmatchedPrevious.some((index) => previous[index]?.sourceKey === undefined);
  if (unmatchedCurrent.length > 0 && unmatchedPrevious.length > 0 && identityInsufficient) {
    return {
      ok: false,
      error: {
        code: 'mesh-material-slot-topology-change',
        previousIndices: unmatchedPrevious,
        nextIndices: unmatchedCurrent,
        hint: 'name source materials uniquely or provide stable sourceKey values before reimport',
      },
    };
  }

  for (let currentIndex = 0; currentIndex < current.length; currentIndex++) {
    let stableIndex = mapping[currentIndex] as number;
    if (stableIndex === -1) {
      stableIndex = stable.length;
      mapping[currentIndex] = stableIndex;
    }
    stable[stableIndex] = current[currentIndex] as MeshMaterialSlotTopologyEntry;
  }
  return { ok: true, slots: stable, currentToStableSlot: mapping };
}

export interface MeshMaterialOverrideMigrationContext {
  readonly meshGuid: string;
  readonly sceneGuid: string;
  readonly entityId: number;
}

export interface MeshMaterialOverrideConflict extends MeshMaterialOverrideMigrationContext {
  readonly code: 'mesh-material-slot-override-conflict';
  readonly materialSlot: number;
  readonly submeshIndices: readonly number[];
  readonly overrideHandles?: readonly number[];
  readonly overrideGuids?: readonly string[];
  readonly hint: string;
}

export type MeshMaterialOverrideMigrationResult<T extends number | string = number> =
  | { readonly ok: true; readonly overrides: readonly T[] }
  | { readonly ok: false; readonly error: MeshMaterialOverrideConflict };

/**
 * Collapse legacy per-submesh overrides into v3 per-slot overrides.
 * Conflicting section overrides fail atomically with full dependency context.
 */
export function migrateLegacyMeshMaterialOverrides<T extends number | string>(
  legacyOverrides: readonly T[],
  submeshes: readonly Pick<Submesh, 'materialSlot'>[],
  materialSlotCount: number,
  context: MeshMaterialOverrideMigrationContext,
): MeshMaterialOverrideMigrationResult<T> {
  const inherited = (typeof legacyOverrides[0] === 'string' ? '' : 0) as T;
  const overrides = new Array<T>(materialSlotCount).fill(inherited);
  const sectionsBySlot = new Map<number, number[]>();
  for (let submeshIndex = 0; submeshIndex < submeshes.length; submeshIndex++) {
    const materialSlot = submeshes[submeshIndex]?.materialSlot;
    if (materialSlot === undefined || materialSlot < 0 || materialSlot >= materialSlotCount)
      continue;
    const sections = sectionsBySlot.get(materialSlot) ?? [];
    sections.push(submeshIndex);
    sectionsBySlot.set(materialSlot, sections);
  }
  for (const [materialSlot, submeshIndices] of sectionsBySlot) {
    const handles: T[] = submeshIndices.map((index) => legacyOverrides[index] ?? inherited);
    const distinct = [...new Set(handles)];
    if (distinct.length > 1) {
      return {
        ok: false,
        error: {
          code: 'mesh-material-slot-override-conflict',
          ...context,
          materialSlot,
          submeshIndices,
          ...(typeof handles[0] === 'string'
            ? { overrideGuids: handles as string[] }
            : { overrideHandles: handles as number[] }),
          hint: 'split the source slot or choose one override explicitly before v2 to v3 recook',
        },
      };
    }
    overrides[materialSlot] = distinct[0] ?? inherited;
  }
  return { ok: true, overrides };
}

export interface MeshCardProjection {
  readonly origin: readonly [number, number, number];
  readonly u: readonly [number, number, number];
  readonly v: readonly [number, number, number];
  readonly n: readonly [number, number, number];
  readonly width: number;
  readonly height: number;
  readonly depth: number;
}
export interface MeshCardLayout {
  readonly meshDigest: string;
  readonly bounds: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
  readonly cards: readonly MeshCardProjection[];
  /** Hash of one 0/1 sidedness byte per source triangle. */
  readonly sidednessDigest: string;
  readonly sampling: {
    readonly resolution: number;
    readonly spacing: number;
    readonly rays: number;
    readonly surfels: number;
    readonly weightedCoverage: number;
    readonly representedWeight: number;
    readonly rejectedInside: number;
  };
}

/**
 * Submesh partitions a mesh's index/vertex range into an independent draw
 * call with its own primitive topology.
 *
 * Draw-range and topology fields are required; the caller must state the
 * intended primitive type explicitly. Derived card data is optional.
 *
 * Naming aligns with Unity `SubMeshDescriptor` (without firstVertex /
 * baseVertex / bounds which are out of scope per OOS-3/OOS-4).
 *
 * | field | description |
 * |:--|:--|
 * | `indexOffset` | Start offset into the parent mesh's index buffer (in elements, not bytes). For vertex-only (non-indexed) submeshes, set to 0. |
 * | `indexCount`  | Number of indices consumed from the index buffer starting at `indexOffset`. For vertex-only submeshes, set to 0. |
 * | `vertexCount` | Number of vertices spanned by this submesh range (used for the non-indexed draw path and for index-range OOB validation). |
 * | `topology`    | GPU primitive topology for this submesh (one of the 5 WebGPU primitives: 'point-list' \| 'line-list' \| 'line-strip' \| 'triangle-list' \| 'triangle-strip'). |
 */
export interface Submesh {
  readonly indexOffset: number;
  readonly indexCount: number;
  readonly vertexCount: number;
  readonly topology: PrimitiveTopology;
  /** Index into the owning MeshAsset.materialSlots table. */
  readonly materialSlot: number;
}

/**
 * Texture asset POD shape aligned with `@webgpu/types ^0.1.69`
 * `GPUTextureDescriptor` subset (plan-strategy D-P1; RHI form rule
 * "spec-aligned"). Carries the decoded pixel bytes ready for
 * `GPUQueue.writeTexture` / `copyExternalImageToTexture` upload.
 *
 * `format` is the `GPUTextureFormat` string-literal union; `data` holds the
 * CPU-side decoded pixels (tight-packed, srgb-premultiplied-alpha-false per
 * D-P9). Optional `mipLevelCount` / `sampleCount` default to 1 at upload
 * time; v1 registers only 2D textures (depth / 3D / cube array are future
 * spinoffs).
 *
 * feat-20260515-learn-render-getting-started M3 / T-M3-03 minor-add (Asset
 * closed-union member count unchanged at 5; plan-strategy section 2.5 D Open
 * Q-4 selection (c)):
 *   - `colorSpace: 'srgb' | 'linear'` -- AI-user-semantic SSOT (charter P4
 *     consistent abstraction); `format='*-srgb'` family <-> `colorSpace='srgb'`
 *     enforced by `AssetRegistry.uploadTexture` consistency assertion.
 *   - `mipmap: boolean` -- `true` enables runtime mipmap-generator blit chain
 *     (research F-1 SSOT three-source convergence; plan-strategy section 2.6
 *     D Open Q-5 (a) independent file). `false` ships the single mip level
 *     authored in `data`.
 *
 * Both fields are required (no default value) so consumers always make the
 * decision explicit at register-time (charter P3 explicit failure: silent
 * default would mask sRGB encode mistakes).
 */
/**
 * Equirectangular environment-map asset POD shape -- a single 2D HDR image in
 * latitude-longitude projection (feat-20260630-equirect-kind-internalized-ibl-
 * declarative-skyligh M1, replacing the prior `CubeTextureAsset`).
 *
 * `kind:'equirect'` is the build-time-imported `.hdr` artefact: a single
 * `rgba16float` 2D image whose pixels live in `data` (tight-packed, build .bin).
 * Unlike the retired cube-texture, an equirect HAS a single 2D representation,
 * so it folds to a build-time `.bin` like `TextureAsset` (the cube-to-cube IBL
 * projection is a GPU-side pass driven internally by the render-system record
 * arm; AI users declare `Skylight{equirect}` rather than calling an upload).
 *
 * Fields mirror the `TextureAsset` 2D-image surface (charter P4 consistent
 * abstraction): `width` / `height` / `format` / `data` / `colorSpace`. No
 * `mipmap` chain field -- the IBL prefilter mip chain is a GPU-side pass, not a
 * CPU-authored level set.
 */
export interface EquirectAsset {
  readonly kind: 'equirect';
  readonly width: number;
  readonly height: number;
  readonly format: GPUTextureFormat;
  readonly data: Uint8Array | Uint8ClampedArray;
  readonly colorSpace: 'srgb' | 'linear';
}

/**
 * Sampler asset POD shape aligned with `@webgpu/types ^0.1.69`
 * `GPUSamplerDescriptor` subset. AI users supply filter + address modes;
 * the RHI layer materialises the GPU-side sampler on upload.
 */
export interface SamplerAsset {
  readonly kind: 'sampler';
  readonly magFilter?: GPUFilterMode;
  readonly minFilter?: GPUFilterMode;
  readonly mipmapFilter?: GPUMipmapFilterMode;
  readonly addressModeU?: GPUAddressMode;
  readonly addressModeV?: GPUAddressMode;
  readonly addressModeW?: GPUAddressMode;
  readonly lodMinClamp?: number;
  readonly lodMaxClamp?: number;
  readonly compare?: GPUCompareFunction;
  readonly maxAnisotropy?: number;
}
