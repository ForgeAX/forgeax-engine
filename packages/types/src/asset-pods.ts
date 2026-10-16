// Importer-independent sub-asset POD vocabulary.
import type { AnimationTargetIdValue } from './animation-target.js';
import type { ShadowCapsuleSet } from './media-contracts.js';
import type { MorphTarget } from './mesh-contracts.js';

// === Sub-asset POD SSOT (feat-20260615-fbx-importer-via-sdk M1 / t9) ===========
//
// Importer-independent pure-data IR types shared across glTF / FBX / future
// format importers. These are pre-kind, pre-guid data carriers — each importer
// writes these Pods from its format-specific JSON POD, and `to-asset-pack`
// promotes them to registry-ready Asset handles.
//
// Design axioms:
// - SSOT (architecture-principles #1): defined once in @forgeax/engine-types,
//   consumed via import by gltf / fbx / future importer packages.
// - Derive, don't duplicate (#2): gltf/fbx drop their local MeshIr/MeshRecord
//   and import MeshPod — no per-package copy.
// - No format prefix (plan-strategy section 8): Pod types are named after the
//   *asset kind* they represent, not the source format. AI users write code
//   that reads MeshPod regardless of whether the source was FBX or glTF.
// - Pre-kind data (charter P4): Pods carry raw geometric/material data without
//   `kind` discriminant fields. The importer bridge layer adds `kind` when
//   converting Pod -> Asset handle.
//
// Pod roster (AC-01..AC-07):
//   MeshPod          — vertices/indices/attributes/submeshes
//   MaterialPod      — PBR parameter values (baseColor/metallic/roughness)
//   ScenePod         — entity hierarchy + mount points
//   TexturePod       — external file path (cross-platform normalized)
//   SkeletonPod      — joint count + inverse bind matrices
//   SkinPod          — skeleton reference + joint paths
//   AnimationClipPod — duration + channels + samplers

// === AC-01: MeshPod — pure geometric data ===

/** Per-submesh descriptor within a MeshPod. */
export interface MeshSubmeshPod {
  /** Vertex count for this submesh (draw count when non-indexed). */
  readonly vertexCount: number;
  /** Index count when indexed; 0 for non-indexed geometry. */
  readonly indexCount: number;
  /** Byte offset into the shared indices buffer (0-based). */
  readonly indexOffset: number;
  /** Material binding index into the parent document's materials array. */
  readonly materialIndex: number | null;
  /** Primitive topology. */
  readonly topology: 'triangle-list' | 'line-list' | 'line-strip' | 'point-list';
}

/** MeshPod: pre-kind geometric data IR shared across importers. */
export interface MeshPod {
  /** Optional debug name from source document. */
  readonly name?: string;
  /** Packed vertex positions (Float32Array, 3 floats per vertex). */
  readonly vertices: Float32Array;
  /** Packed triangle indices (Uint16Array or Uint32Array). Absent when non-indexed. */
  readonly indices?: Uint16Array | Uint32Array;
  /** Per-vertex attributes keyed by semantic (POSITION/NORMAL/TEXCOORD_0/JOINTS_0/WEIGHTS_0). */
  readonly attributes: Record<string, Float32Array | Uint16Array | Uint32Array>;
  /** Optional additive morph deltas, one entry per target. */
  readonly morphTargets?: readonly MorphTarget[];
  /** Optional default morph weights, one value per target. */
  readonly morphWeights?: Float32Array;
  /** Per-submesh descriptors (>=1). */
  readonly submeshes: readonly MeshSubmeshPod[];
  /** Source mesh index within the original document (for diagnostic mapping). */
  readonly sourceIndex: number;
}

// === AC-02: MaterialPod — PBR parameter values ===

/** MaterialPod: pre-kind PBR material data IR shared across importers. */
export const MATERIAL_TEXTURE_SLOTS = [
  'baseColorTexture',
  'normalTexture',
  'specularTintTexture',
  'metallicRoughnessTexture',
  'metallicTexture',
  'roughnessTexture',
  'alphaTexture',
  'emissiveTexture',
  'occlusionTexture',
] as const;

export type MaterialTextureSlot = (typeof MATERIAL_TEXTURE_SLOTS)[number];

export interface MaterialTextureBindingPod {
  /** Standard material value slot receiving the texture reference. */
  readonly slot: MaterialTextureSlot;
  /** Index into the parent document's textures array. */
  readonly textureIndex: number;
  /** Optional source UV set. */
  readonly texCoord?: number;
}

export interface MaterialPod {
  /** Optional debug name from source document. */
  readonly name?: string;
  /** RGBA base color factor (linear space). */
  readonly baseColorFactor: readonly [number, number, number, number];
  /** Metallic factor (0..1). */
  readonly metallicFactor: number;
  /** Roughness factor (0..1). */
  readonly roughnessFactor: number;
  /** Index into the parent document's textures array for base color map. */
  readonly baseColorTextureIndex?: number;
  /** Index for metallic-roughness packed texture. */
  readonly metallicRoughnessTextureIndex?: number;
  /** Index for normal map. */
  readonly normalTextureIndex?: number;
  /** Index for occlusion map. */
  readonly occlusionTextureIndex?: number;
  /** Index for emissive map. */
  readonly emissiveTextureIndex?: number;
  /** Index for a specular tint map. */
  readonly specularTintTextureIndex?: number;
  /** Engine-owned semantic texture bindings from the producer. */
  readonly textureBindings?: readonly MaterialTextureBindingPod[];
}

// === AC-03: ScenePod — entity hierarchy ===

/** A single entity node within a ScenePod hierarchy. */
export interface SceneEntityPod {
  /** Entity name (for Name component attachment). */
  readonly name: string;
  /** Decomposed local transform (TRS). */
  readonly transform: {
    readonly translation: readonly [number, number, number];
    readonly rotation: readonly [number, number, number, number];
    readonly scale: readonly [number, number, number];
  };
  /** Index into the parent document's meshes array. Null when not a mesh node. */
  readonly meshIndex: number | null;
  /** Children entity indices in the flattened entities array. */
  readonly children: readonly number[];
}

/** ScenePod: entity hierarchy IR shared across importers. */
export interface ScenePod {
  /** Optional scene name. */
  readonly name?: string;
  /** Flattened entity list (topological order, parents before children). */
  readonly entities: readonly SceneEntityPod[];
  /** Index of the default/root scene entity. */
  readonly rootEntityIndex: number;
}

// === AC-04: TexturePod — external file path ===

/** TexturePod: external texture reference IR shared across importers. */
export interface TexturePod {
  /** Optional texture name. */
  readonly name?: string;
  /** Filesystem path relative to the source document, with '/' separators. */
  readonly filePath: string;
  /** The producer-declared relative path before host resolution. */
  readonly relativeFilePath?: string;
  /** Parse-scope absolute hint; never persist this into project metadata. */
  readonly absoluteFilePath?: string;
  /** Embedded encoded image bytes, when the FBX contains the texture payload. */
  readonly embeddedBytes?: Uint8Array;
  /** Producer texture kind; only file/embedded textures are importable. */
  readonly type?: 'file' | 'layered' | 'procedural' | 'shader' | 'unknown';
  /** Source texture index within the original document. */
  readonly sourceIndex: number;
}

// === AC-05: SkeletonPod — joint hierarchy ===

/** SkeletonPod: skeleton joint data IR shared across importers. */
export interface SkeletonPod {
  /** Number of joints. */
  readonly jointCount: number;
  /** Inverse bind matrices, Float32Array of length jointCount * 16. */
  readonly inverseBindMatrices: Float32Array;
  /** Per-joint name path from scene root (parallel to joints array). */
  readonly jointPaths: readonly string[];
  /** Optional producer-authored enclosure for imported animation clips. */
  readonly bounds?: Float32Array;
  /** Optional bind-space capsules approximating the skinned surface for character shadows. */
  readonly shadowCapsules?: ShadowCapsuleSet;
}

// === AC-06: SkinPod — vertex skinning data ===

/** Per-vertex joint influence descriptor. */
export interface SkinVertexInfluencePod {
  /** 4 joint indices (Uint16Array), always padded to 4 entries. */
  readonly jointIndices: Uint16Array;
  /** 4 joint weights (Float32Array), always padded to 4 entries. */
  readonly jointWeights: Float32Array;
}

/** SkinPod: vertex skinning data IR shared across importers. */
export interface SkinPod {
  /** GUID-like identifier for the associated SkeletonAsset (resolved at bridge time). */
  readonly skeletonGuid: string;
  /** Joint name paths (same as SkeletonPod.jointPaths for cross-reference). */
  readonly jointPaths: readonly string[];
  /** Number of influenced vertices. */
  readonly vertexCount: number;
  /** Per-vertex joint influences (4 joints per vertex). */
  readonly influences: readonly SkinVertexInfluencePod[];
}

// === AC-07: AnimationClipPod — keyframe animation ===

/** Animation sampler (keyframe data for one property). */
export interface AnimationSamplerPod {
  /** Keyframe timestamps (ascending, seconds). */
  readonly input: Float32Array;
  /** Keyframe values (packed per-element stride). */
  readonly output: Float32Array;
  /** Interpolation mode. */
  readonly interpolation: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
}

/** Animation channel (one target-property pair). */
export interface AnimationChannelPod {
  /** Stable animation target identity. */
  readonly targetId: AnimationTargetIdValue;
  /** Target property: 'translation' | 'rotation' | 'scale' | 'weights'. */
  readonly property: 'translation' | 'rotation' | 'scale' | 'weights';
  /** Sampler driving this channel. */
  readonly sampler: AnimationSamplerPod;
}

/** AnimationClipPod: keyframe animation clip IR shared across importers. */
export interface AnimationClipPod {
  /** Optional clip name. */
  readonly name?: string;
  /** Clip duration in seconds (max sampler.input[last]). */
  readonly duration: number;
  /** Per-animation-target-property channels. */
  readonly channels: readonly AnimationChannelPod[];
}
