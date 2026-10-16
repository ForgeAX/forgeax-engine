// Video, skeleton, skin, and vertex attribute contracts.
/// <reference types="@webgpu/types" />

// === VideoAsset POD shape (feat-20260623-world-space-video-asset M1) ==========
//
// Decision anchors:
//   - requirements AC-01 (VideoAsset is Asset closed-union 15th member;
//     kind discriminator 'video'; payload { url: string }, no width/height/duration).
//   - requirements constraint: payload must not inline video bytes, only a URL descriptor.
//   - plan-strategy D-4 (VideoAsset descriptor naming aligns with TextureAsset/AudioClipAsset).
//   - charter F1 (AI users discover the schema via IDE autocomplete on the closed
//     `Asset` union + `Handle<VideoAsset>` returns from `AssetRegistry.register`).
//   - plan-strategy D-5 (resolveTexLike identifies video kind via `payload.kind === 'video'`;
//     video does not masquerade as 'texture').
//
// `refs` is always empty (isolated leaf) — VideoAsset carries no sub-asset
// references (plan-strategy S6.3). The `url` field points to an external video
// file; the runtime resolves it into an HTMLVideoElement via the host-provided
// `VideoSourceProvider` World Resource (plan-strategy D-1).

/**
 * Video asset POD shape -- pure `{url}` descriptor.
 *
 * `VideoAsset` is a runtime-only asset kind (OOS-1: no import/cook pipeline).
 * The `url` field points to an external video file (e.g. `*.webm` / `*.mp4`);
 * the engine does NOT decode video bytes -- it delegates to the host-side
 * `HTMLVideoElement` via `VideoSourceProvider` (plan-strategy D-1).
 *
 * `width` / `height` / `duration` are deliberately absent from the POD:
 * the runtime reads them from `HTMLVideoElement.videoWidth` /
 * `videoHeight` / `duration` after `loadedmetadata` fires (requirements
 * constraint "payload must not inline video bytes").
 *
 * Consumers reference a VideoAsset via a material texture value
 * fields (e.g. `baseColorTexture`), sharing the same `texture2d` slot with
 * static textures (charter P4 consistent abstraction). The extraction layer
 * (render-system-extract `resolveTexLike`) identifies the video kind and
 * routes to the per-frame transient texture pathway instead of the static
 * `GpuResourceStore.ensureResident` cache (plan-strategy D-5).
 */
export interface VideoAsset {
  readonly kind: 'video';
  readonly url: string;
}

/**
 * Skeleton asset POD shape — pure rig data, no mesh attachment.
 *
 * `inverseBindMatrices` is a Float32Array of length jointCount * 16
 * (column-major mat4 per joint). Missing IBM in source glTF is filled
 * with identity mat4 at importer time.
 *
 * `jointCount` is the number of joints (= IBM array length / 16).
 * Keys off the glTF skin's `joints[]` array length; validated against
 * MAX_JOINTS (256) at importer time.
 */
export interface SkeletonAsset {
  readonly kind: 'skeleton';
  readonly inverseBindMatrices: Float32Array;
  readonly jointCount: number;
  /**
   * Optional producer-authored enclosure for imported animation clips.
   * Runtime IK or physics can move joints outside that source envelope;
   * Render derives current-pose visibility from the actual Mesh and palette.
   */
  readonly bounds?: Float32Array;
  /**
   * Optional directional shadow proxy in mesh bind space. Each capsule is
   * rigidly attached to one joint and deforms with that joint's palette
   * matrix, so the renderer can replace the skinned mesh in shadow cascades.
   */
  readonly shadowCapsules?: ShadowCapsuleSet;
}

/**
 * Capsules approximating a skinned mesh volume for shadow casting.
 *
 * `shapes` holds seven floats per capsule: segment start xyz, segment end
 * xyz, radius, all in mesh bind space (meters). A sphere has equal ends.
 * Capsules must lie inside the mesh volume; the mesh receives their shadow.
 */
export interface ShadowCapsuleSet {
  /** One joint index per capsule, each `< jointCount`. */
  readonly joints: Uint16Array;
  /** `joints.length * 7` floats. */
  readonly shapes: Float32Array;
}

/**
 * Skin sub-asset — the binding between a skeleton and a scene node hierarchy.
 *
 * `skeletonGuid` references a SkeletonAsset by GUID (string form).
 * `jointPaths` is a parallel array to the skeleton's joints; each entry
 * is a Name-component path from scene root to the joint entity, used
 * at post-spawn time to populate Skin.joints: Entity[].
 *
 * Zero-Entity-reference at the asset layer (AC-06): no Entity or
 * LocalEntityId fields — the binding is name-based, resolved at instantiate time.
 */
export interface SkinAsset {
  readonly kind: 'skin';
  readonly skeletonGuid: string;
  readonly jointPaths: readonly string[];
}

/**
 * VertexAttributeMap — 14-key closed set (feat-20260823 vertex-color asset closure).
 *
 * Canonical interleaved order (plan-strategy F-1, must match bridge + layout layers):
 *   position / normal / uv / tangent / skinIndex / skinWeight / uv1..uv7 / color
 *
 * @location mapping per plan-strategy D-4:
 *   position@0  normal@1  uv@2  tangent@3  skinIndex@4  skinWeight@5
 *   uv1@6  uv2@7  uv3@8  uv4@9  uv5@10  uv6@11  uv7@12  color@13
 *
 * Keys align with Three.js r184 `BufferGeometry.attributes` naming (D-P1 +
 * plan-strategy §7.2 mental migration stance). Importers rename at ingest
 * (`POSITION -> position` / `TEXCOORD_0 -> uv` / `JOINTS_0 -> skinIndex` /
 * `WEIGHTS_0 -> skinWeight`) so the runtime key space remains lowercase.
 *
 * All 14 keys are optional; a mesh with only `position` (static unlit) is
 * valid. Values accept the three common binary shapes:
 * `ArrayBuffer | Float32Array | Uint16Array` (extend only via minor add per
 * the closed-union evolution contract).
 *
 * AC-15 narrowing: consumer sites writing
 * `for (const [key, buffer] of Object.entries(attributes))` observe `key`
 * typed as the 14-member literal union without `as` casts; any typo (e.g.
 * `'POSITION'`) is a TS compile-time error.
 */
export interface VertexAttributeMap {
  position?: ArrayBuffer | Float32Array | Uint16Array;
  normal?: ArrayBuffer | Float32Array | Uint16Array;
  uv?: ArrayBuffer | Float32Array | Uint16Array;
  tangent?: ArrayBuffer | Float32Array | Uint16Array;
  skinIndex?: ArrayBuffer | Float32Array | Uint16Array;
  skinWeight?: ArrayBuffer | Float32Array | Uint16Array;
  /** UV set 1 (feat-20260629-multi-uv-set-support m3-w3, pre-added by M1 for bridge typecheck). */
  uv1?: ArrayBuffer | Float32Array | Uint16Array;
  /** UV set 2 */
  uv2?: ArrayBuffer | Float32Array | Uint16Array;
  /** UV set 3 */
  uv3?: ArrayBuffer | Float32Array | Uint16Array;
  /** UV set 4 */
  uv4?: ArrayBuffer | Float32Array | Uint16Array;
  /** UV set 5 */
  uv5?: ArrayBuffer | Float32Array | Uint16Array;
  /** UV set 6 */
  uv6?: ArrayBuffer | Float32Array | Uint16Array;
  /** UV set 7 */
  uv7?: ArrayBuffer | Float32Array | Uint16Array;
  /** Optional per-vertex linear RGBA color, exactly four finite floats per vertex. */
  color?: Float32Array;
}

/** Closed storage vocabulary used by the geometry pack boundary. */
export type VertexAttributeStorage = 'array-buffer' | 'float32' | 'uint16' | 'other';

/** Lossless detail for one rejected canonical vertex attribute pack. */
export type VertexAttributePackDetail =
  | {
      readonly field: 'vertexCount';
      readonly reason: 'vertex-count-invalid';
      readonly actual: number;
    }
  | {
      readonly field: 'attributes';
      readonly reason: 'attributes-empty';
      readonly actualCount: 0;
    }
  | {
      readonly field: keyof VertexAttributeMap;
      readonly reason: 'attribute-storage-invalid';
      readonly expectedStorage: 'float32' | 'uint16';
      readonly actualStorage: VertexAttributeStorage;
    }
  | {
      readonly field: keyof VertexAttributeMap;
      readonly reason: 'attribute-cardinality-mismatch';
      readonly vertexCount: number;
      readonly componentsPerVertex: number;
      readonly expectedLength: number;
      readonly actualLength: number;
    }
  | {
      readonly field: keyof VertexAttributeMap;
      readonly reason: 'attribute-non-finite';
      readonly elementIndex: number;
      readonly actual: 'nan' | 'positive-infinity' | 'negative-infinity';
    };

/**
 * Canonical UV attribute key order (set 0 = `uv`, sets 1..7 = `uv1..uv7`),
 * matching the VertexAttributeMap declaration + @location numbering (D-4).
 * SSOT for "how many UV sets does this attribute map carry" so the import,
 * gpu-resource, and layout-derivation layers count identically (no drift).
 */
export const UV_ATTRIBUTE_KEYS = ['uv', 'uv1', 'uv2', 'uv3', 'uv4', 'uv5', 'uv6', 'uv7'] as const;

/**
 * Structural input for the UV-set counters: any object that may carry the
 * canonical UV attribute keys. Both the loosely-typed mesh-attribute record
 * (`Record<string, unknown>`) and the closed `VertexAttributeMap` satisfy it,
 * so the import / gpu-resource / layout layers all call one counter.
 */
export type UvAttributeSource = Partial<Record<(typeof UV_ATTRIBUTE_KEYS)[number], unknown>>;

/**
 * Total number of UV sets present in an attribute map: the highest populated
 * `uv`/`uv1..uv7` index + 1, or 0 when none are present. A populated key is one
 * whose value is a typed array / array buffer / number array (the binary shapes
 * a vertex attribute can take). This is the single counter all multi-UV layers
 * derive from (feat-20260629 F-4 DRY collapse).
 */
export function countUvSets(attrs: UvAttributeSource | undefined): number {
  if (attrs === undefined) return 0;
  for (let i = UV_ATTRIBUTE_KEYS.length - 1; i >= 0; i--) {
    // biome-ignore lint/style/noNonNullAssertion: bounded index on const tuple
    const v = attrs[UV_ATTRIBUTE_KEYS[i]!];
    if (
      v instanceof Float32Array ||
      v instanceof Uint16Array ||
      v instanceof ArrayBuffer ||
      Array.isArray(v)
    ) {
      return i + 1;
    }
  }
  return 0;
}

/**
 * Extra UV sets beyond set 0 (= `countUvSets - 1`, floored at 0). The
 * gpu-resource + register layers size the dynamic vertex stride from this.
 */
export function countExtraUvSets(attrs: UvAttributeSource | undefined): number {
  const total = countUvSets(attrs);
  return total > 0 ? total - 1 : 0;
}
