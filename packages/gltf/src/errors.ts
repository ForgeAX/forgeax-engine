// errors.ts - GltfError definitions SSOT + factory.
//
// Per requirements AC-28 + plan-strategy D-5 (DIP), GltfErrorCode +
// GltfErrorDetail + GltfError + GLTF_ERROR_HINTS are the glTF importer's
// own error SSOT, local to this package. They were migrated here from
// @forgeax/engine-types in feat-20260615-fbx-importer-via-sdk M1 (t7).
//
// Producers MUST go through `gltfErr` so any GltfErrorCode addition that
// lacks a matching detail variant fails at the call site (TS exhaustive
// per-arm).
//
// Result<T, E> + ok / err live in `@forgeax/engine-types` (tweak-20260612-result-
// into-types) and are re-exported for ergonomic single-import from this module.

export {
  createMaterialError,
  err,
  type GltfMaterialUvSetMissingDetail,
  type MaterialError,
  ok,
  type Result,
} from '@forgeax/engine-types';

import type { VertexAttributePackDetail } from '@forgeax/engine-types';

// === Meshopt vocabulary owner ===

export const GLTF_MESHOPT_MODES = ['ATTRIBUTES', 'TRIANGLES', 'INDICES'] as const;
export type GltfMeshoptMode = (typeof GLTF_MESHOPT_MODES)[number];

export const GLTF_MESHOPT_FILTERS = ['NONE', 'OCTAHEDRAL', 'QUATERNION', 'EXPONENTIAL'] as const;
export type GltfMeshoptFilter = (typeof GLTF_MESHOPT_FILTERS)[number];

// === Per-code detail shapes (22 interfaces, 1 discriminated union) ===

/** `gltf-malformed-header` payload: GLB magic / chunk header surface. */
export interface GltfMalformedHeaderDetail {
  readonly filePath: string;
  readonly byteOffset: number;
  readonly magic?: number;
}

/** `gltf-version-unsupported` payload: surfaced asset.version literal. */
export interface GltfVersionUnsupportedDetail {
  readonly filePath: string;
  readonly actualVersion: string;
}

/** `gltf-buffer-out-of-bounds` payload: accessor + bufferView coordinates. */
export interface GltfBufferOutOfBoundsDetail {
  readonly accessor: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly bufferIndex: number;
}

/** `gltf-extension-unsupported` payload: extension name + which array it appeared in. */
export interface GltfExtensionUnsupportedDetail {
  readonly extension: string;
  readonly source: 'extensionsRequired' | 'extensionsUsed';
}

export interface GltfLodInvalidDetail {
  readonly rootNode: number;
  readonly ids: readonly number[];
  readonly reason: 'missing-node' | 'duplicate-node' | 'not-integer' | 'coverage';
}

export interface GltfMaterialTransmissionInvalidDetail {
  readonly extension: 'KHR_materials_transmission' | 'KHR_materials_ior' | 'KHR_materials_volume';
  readonly field: string;
  readonly reason: 'type' | 'range' | 'non-finite' | 'blend';
  readonly actual?: unknown;
}

export interface GltfMaterialPhysicalInvalidDetail {
  readonly extension:
    | 'KHR_materials_clearcoat'
    | 'KHR_materials_anisotropy'
    | 'KHR_materials_sheen'
    | 'KHR_materials_iridescence'
    | 'KHR_materials_specular'
    | 'KHR_materials_diffuse_transmission'
    | 'KHR_materials_emissive_strength';
  readonly field: string;
  readonly reason: 'type' | 'range' | 'non-finite';
  readonly actual?: unknown;
}

/** `gltf-accessor-type-mismatch` payload with a closed reason discriminator. */
export interface GltfAccessorTypeMismatchDetail {
  readonly accessorIndex: number;
  readonly reason: 'sparse' | 'layout' | 'unknownComponentType';
}

/** `gltf-texture-load-failed` payload: URI that failed to load. */
export interface GltfTextureLoadFailedDetail {
  readonly uri: string;
}

/** `gltf-meta-missing` payload: source path + expected sidecar path. */
export interface GltfMetaMissingDetail {
  readonly filePath: string;
  readonly expectedMetaPath: string;
}

/** `gltf-image-mime-unsupported` payload: rejected MIME type. */
export interface GltfImageMimeUnsupportedDetail {
  readonly mimeType: string;
}

/** `gltf-skin-joint-count-exceeded` payload: skin joint count exceeds MAX_JOINTS. */
export interface GltfSkinJointCountExceededDetail {
  readonly skinIndex: number;
  readonly jointCount: number;
  readonly maxJoints: number;
}

/** `gltf-animation-cubicspline-unsupported` payload: CUBICSPLINE sampler. */
export interface GltfAnimationCubicsplineUnsupportedDetail {
  readonly animationIndex: number;
  readonly samplerIndex: number;
}

/** `gltf-morph-unsupported` payload: channel targeting morph weights. */
export interface GltfMorphUnsupportedDetail {
  readonly animationIndex: number;
  readonly channelIndex: number;
  readonly nodeIndex: number;
}

/** `gltf-skin-joint-name-missing` payload: joint node has no name. */
export interface GltfSkinJointNameMissingDetail {
  readonly reason: 'name-missing' | 'hierarchy-cycle';
  readonly skinIndex: number;
  readonly jointPathIndex: number;
  readonly nodeIndex: number;
}

/** `gltf-image-extract-failed` payload: image bytes extraction failure. */
export interface GltfImageExtractFailedDetail {
  readonly imageIndex: number;
  readonly source: 'bufferView' | 'data-uri' | 'external-uri';
  readonly reason: string;
}

/** `gltf-instancing-count-mismatch` payload: TRS accessor count disagreement. */
export interface GltfInstancingCountMismatchDetail {
  readonly nodeIndex: number;
  readonly accessor: 'TRANSLATION' | 'ROTATION' | 'SCALE';
  readonly expectedCount: number;
  readonly actualCount: number;
}

/** `gltf-skin-attr-asymmetric` payload: JOINTS_0/WEIGHTS_0 paired-presence fail. */
export interface GltfSkinAttrAsymmetricDetail {
  readonly meshIndex: number;
  readonly primitiveIndex: number;
  readonly hasJoints: boolean;
  readonly hasWeights: boolean;
}

export interface GltfAnimationTargetInvalidDetail {
  readonly reason:
    | 'name-missing'
    | 'path-invalid'
    | 'path-duplicate'
    | 'path-not-found'
    | 'hierarchy-cycle'
    | 'id-collision';
  readonly animationIndex: number;
  readonly channelIndex: number;
  readonly nodeIndex: number;
}

export interface GltfMeshoptDecoderRequiredDetail {
  readonly bufferView: number;
  readonly actual: 'required' | 'compressed-only';
  readonly hasCoreFallback: boolean;
}

export interface GltfMeshoptDecodeFailedDetail {
  readonly bufferView: number;
  readonly actual: string;
  readonly mode: GltfMeshoptMode;
  readonly filter: GltfMeshoptFilter;
}

export interface GltfMorphInvalidDetail {
  readonly meshIndex: number;
  readonly primitiveIndex: number;
  readonly reason:
    | 'target-count-exceeded'
    | 'attribute-count-exceeded'
    | 'attribute-length-mismatch'
    | 'weights-length-mismatch'
    | 'sparse-or-unsupported-accessor';
  readonly targetCount: number;
  readonly attributeCount: number;
  readonly vertexCount: number;
}

export interface GltfColorAccessorUnsupportedDetail {
  readonly semantic: 'COLOR_0';
  readonly accessorIndex: number;
  readonly reason: 'component' | 'type' | 'normalized' | 'sparse' | 'morph';
  readonly expectedType?: string;
  readonly expectedComponent?: string;
  readonly expectedNormalized?: boolean;
}

export interface GltfColorAccessorMalformedDetail {
  readonly semantic: 'COLOR_0';
  readonly accessorIndex: number;
  readonly reason: 'count' | 'bounds' | 'finite' | 'range' | 'reference';
  readonly expectedCount?: string;
  readonly expectedRange?: string;
}

/** Bridge-side mesh merge failure after the parser has produced a GltfMeshIr. */
export type GltfMeshBridgeInvalidDetail =
  | {
      readonly reason: 'tangent-frame';
      readonly meshIndex: number;
      readonly primitiveIndex: number;
    }
  | {
      readonly reason: 'empty-input';
      readonly primitiveCount: 0;
    }
  | {
      readonly reason: 'morph-count-mismatch';
      readonly meshIndex: number;
      readonly primitiveIndex: number;
      readonly expectedTargetCount: number;
      readonly actualTargetCount: number;
    }
  | {
      readonly reason: 'color-cardinality';
      readonly semantic: 'COLOR_0';
      readonly meshIndex: number;
      readonly primitiveIndex: number;
      readonly vertexCount: number;
      readonly expectedLength: number;
      readonly actualLength: number;
    }
  | {
      readonly reason: 'layout-invalid';
      readonly meshIndex: number;
      readonly cause: VertexAttributePackDetail;
    };

/** Discriminated detail family unifying all 19 GltfError variants. */
export type GltfErrorDetail = DetailFor[GltfErrorCode];

// === GltfErrorCode and GltfError discriminated union ===

export type GltfErrorCode = keyof DetailFor;

export type GltfError = {
  readonly [C in GltfErrorCode]: {
    readonly code: C;
    readonly expected: string;
    readonly hint: string;
    readonly detail: DetailFor[C];
  };
}[GltfErrorCode];

// === Private per-code policy owner ===

type GltfErrorPolicy = { readonly expected: string; readonly hint: string };

const gltfErrorPolicy = {
  'gltf-camera-invalid': {
    expected: 'a valid referenced glTF perspective or orthographic camera',
    hint: 'Repair camera indices, positive magnification/FOV, and ordered clipping planes.',
  },
  'gltf-animation-sampler-invalid': {
    expected: 'strictly increasing finite times and matching values/tangent cardinality',
    hint: 'Repair animation input, output and interpolation, then reimport the same GUID.',
  },
  'gltf-malformed-header': {
    expected:
      'GLB 12-byte header (magic 0x46546C67 + version=2 + length) plus mandatory JSON chunk',
    hint: 'verify .glb is not truncated; rerun: forgeax asset import <path> --root <project> --json',
  },
  'gltf-version-unsupported': {
    expected: 'asset.version === "2.0"',
    hint: 'asset.version must be "2.0"; v1 or v3 not supported',
  },
  'gltf-buffer-out-of-bounds': {
    expected: 'accessor byte range within bufferView.byteLength',
    hint: 'rebuild .gltf with valid bufferViews; check accessor index; ensure accessor.byteOffset + EFFECTIVE_STRIDE * (count - 1) + element_size <= bufferView.byteLength',
  },
  'gltf-extension-unsupported': {
    expected:
      'extension listed in the supported allowlist (see EXTENSION_ALLOWLIST in @forgeax/engine-gltf)',
    hint: 'remove the unsupported required extension or use a supported glTF extension; extensionsUsed-only entries remain diagnostic',
  },
  'gltf-lod-invalid': {
    expected: 'MSFT_lod ids to reference unique existing node indices with valid coverage',
    hint: 'repair the MSFT_lod node relation or remove it from extensionsRequired before re-importing',
  },
  'gltf-material-transmission-invalid': {
    expected: 'KHR transmission, IOR, and volume values are finite and within their glTF ranges',
    hint: 'repair the named glTF material extension value and re-import the source',
  },
  'gltf-material-physical-invalid': {
    expected:
      'KHR clearcoat, anisotropy, sheen, iridescence, and specular values are finite and within their glTF ranges',
    hint: 'repair the named physical material extension value and re-import the source',
  },
  'gltf-accessor-type-mismatch': {
    expected:
      'bounded, aligned accessor with valid dense/strided storage and ordered sparse overrides',
    hint: 'repair component/type, byte ranges, stride/alignment or sparse indices in the source accessor',
  },
  'gltf-texture-load-failed': {
    expected: 'externalLoader resolved the URI into an ArrayBuffer without throwing',
    hint: 'check sidecar meta.json + textures/ directory + vite-plugin-pack /__pack/lookup route',
  },
  'gltf-meta-missing': {
    expected: "sidecar <source>.meta.json (importer: 'gltf') present in same directory",
    hint: 'run: forgeax asset import <path> --root <project> --json',
  },
  'gltf-instancing-count-mismatch': {
    expected: 'all instance attribute accessors share the same count',
    hint: 'EXT_mesh_gpu_instancing requires TRANSLATION/ROTATION/SCALE accessors to share count; see https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/EXT_mesh_gpu_instancing/README.md#extending-nodes-with-instance-attributes',
  },
  'gltf-image-mime-unsupported': {
    expected: 'image/mimeType is image/jpeg or image/png',
    hint: 'convert to JPG/PNG via external tool; only image/jpeg and image/png are supported',
  },
  'gltf-skin-joint-count-exceeded': {
    expected: 'skin.joints.length <= MAX_JOINTS (256)',
    hint: 'reduce joint count below MAX_JOINTS (256) or see OOS-skin-max-joints',
  },
  'gltf-animation-cubicspline-unsupported': {
    expected: 'animation sampler interpolation is LINEAR, STEP or CUBICSPLINE',
    hint: 'this retained wire error is no longer emitted; inspect gltf-animation-sampler-invalid for malformed source',
  },
  'gltf-morph-unsupported': {
    expected: 'animation channel target path is one of translation, rotation, scale, or weights',
    hint: 'animation target path must be translation, rotation, scale, or weights',
  },
  'gltf-skin-joint-name-missing': {
    expected: 'every joint node has a non-empty name and belongs to an acyclic hierarchy',
    hint: 'ensure every joint node has a non-empty name and the node hierarchy is acyclic',
  },
  'gltf-image-extract-failed': {
    expected:
      'image bytes extractable from bufferView / data-URI / external URI without corruption',
    hint: 'verify the bufferView byte range / data: URI base64 / external URI sibling file is intact next to the .gltf source; rerun: forgeax asset import <path> --root <project> --json',
  },
  'gltf-skin-attr-asymmetric': {
    expected:
      'mesh primitive declares JOINTS_0 and WEIGHTS_0 symmetrically (both present or both absent)',
    hint: 'glTF spec requires JOINTS_0 and WEIGHTS_0 to appear together for each skinned primitive; add the missing attribute or remove the present one in the DCC tool',
  },
  'gltf-animation-target-invalid': {
    expected:
      'every animation channel resolves to one uniquely named scene node and stable target ID',
    hint: 'name every node in the animated hierarchy and ensure each animated full path is unique',
  },
  'gltf-draco-decoder-required': {
    expected: 'a decoder for required or compressed-only KHR_draco_mesh_compression',
    hint: 'Use the build-only gltf/importer entry or supply a Draco decoder capability.',
  },
  'gltf-draco-decode-failed': {
    expected: 'valid Draco triangle data matching the declared accessors',
    hint: 'Repair the compressed source or accessor declarations and reimport.',
  },
  'gltf-meshopt-decoder-required': {
    expected:
      'a required or compressed-only EXT_meshopt_compression bufferView has a ready decoder capability',
    hint: 'provide the build-only EXT_meshopt_compression decoder or author a valid core fallback bufferView',
  },
  'gltf-meshopt-decode-failed': {
    expected: 'the EXT_meshopt_compression declaration and decoder output are structurally valid',
    hint: 'the meshopt decoder accepts the declared compressed range and produces the declared byte count',
  },
  'gltf-morph-invalid': {
    expected:
      'morph target and default-weight arrays are dense, bounded, and match the base vertex count',
    hint: 're-export dense morph targets with at most eight targets/attributes and matching vertex/default-weight lengths',
  },
  'gltf-color-accessor-unsupported': {
    expected: 'COLOR_0 dense accessor uses VEC3/VEC4 FLOAT or normalized UBYTE/USHORT',
    hint: 're-export COLOR_0 with a supported type/component/normalized combination; morph and sparse COLOR_0 remain deferred',
  },
  'gltf-color-accessor-malformed': {
    expected: 'COLOR_0 accessor is non-empty, finite, in range, and fully addressable',
    hint: 'repair the COLOR_0 accessor count, reference, range, or buffer bounds, then re-import the glTF source',
  },
  'gltf-mesh-bridge-invalid': {
    expected:
      'a non-empty merged mesh with valid tangent frames and consistent morph and COLOR_0 cardinality',
    hint: 'repair the source primitive and re-import; inspect detail.reason and its typed facts',
  },
} satisfies Record<GltfErrorCode, GltfErrorPolicy>;

export const GLTF_ERROR_HINTS: Readonly<Record<GltfErrorCode, string>> = Object.fromEntries(
  Object.entries(gltfErrorPolicy).map(([code, policy]) => [code, policy.hint]),
) as Readonly<Record<GltfErrorCode, string>>;

export interface GltfDracoDetail {
  readonly meshIndex: number;
  readonly primitiveIndex: number;
  readonly bufferView: number;
}
export interface GltfDracoDecodeFailedDetail extends GltfDracoDetail {
  readonly reason: string;
}

// === DetailFor map + gltfErr factory ===

interface DetailFor {
  readonly 'gltf-camera-invalid': { readonly cameraIndex: number };
  readonly 'gltf-animation-sampler-invalid': {
    readonly animationIndex: number;
    readonly samplerIndex: number;
    readonly reason: 'times' | 'values' | 'interpolation';
  };
  readonly 'gltf-draco-decoder-required': GltfDracoDetail;
  readonly 'gltf-draco-decode-failed': GltfDracoDecodeFailedDetail;
  readonly 'gltf-malformed-header': GltfMalformedHeaderDetail;
  readonly 'gltf-version-unsupported': GltfVersionUnsupportedDetail;
  readonly 'gltf-buffer-out-of-bounds': GltfBufferOutOfBoundsDetail;
  readonly 'gltf-extension-unsupported': GltfExtensionUnsupportedDetail;
  readonly 'gltf-lod-invalid': GltfLodInvalidDetail;
  readonly 'gltf-accessor-type-mismatch': GltfAccessorTypeMismatchDetail;
  readonly 'gltf-texture-load-failed': GltfTextureLoadFailedDetail;
  readonly 'gltf-meta-missing': GltfMetaMissingDetail;
  readonly 'gltf-instancing-count-mismatch': GltfInstancingCountMismatchDetail;
  readonly 'gltf-image-mime-unsupported': GltfImageMimeUnsupportedDetail;
  readonly 'gltf-skin-joint-count-exceeded': GltfSkinJointCountExceededDetail;
  readonly 'gltf-animation-cubicspline-unsupported': GltfAnimationCubicsplineUnsupportedDetail;
  readonly 'gltf-morph-unsupported': GltfMorphUnsupportedDetail;
  readonly 'gltf-skin-joint-name-missing': GltfSkinJointNameMissingDetail;
  readonly 'gltf-image-extract-failed': GltfImageExtractFailedDetail;
  readonly 'gltf-skin-attr-asymmetric': GltfSkinAttrAsymmetricDetail;
  readonly 'gltf-animation-target-invalid': GltfAnimationTargetInvalidDetail;
  readonly 'gltf-meshopt-decoder-required': GltfMeshoptDecoderRequiredDetail;
  readonly 'gltf-meshopt-decode-failed': GltfMeshoptDecodeFailedDetail;
  readonly 'gltf-morph-invalid': GltfMorphInvalidDetail;
  readonly 'gltf-color-accessor-unsupported': GltfColorAccessorUnsupportedDetail;
  readonly 'gltf-color-accessor-malformed': GltfColorAccessorMalformedDetail;
  readonly 'gltf-mesh-bridge-invalid': GltfMeshBridgeInvalidDetail;
  readonly 'gltf-material-transmission-invalid': GltfMaterialTransmissionInvalidDetail;
  readonly 'gltf-material-physical-invalid': GltfMaterialPhysicalInvalidDetail;
}

/**
 * Build a fully-typed GltfError. The discriminated-union return type lets
 * call sites narrow with `switch (e.code)` on the result.
 *
 * Charter proposition 4 explicit-failure: `expected` + `hint` fields are
 * sourced from the SSOT tables - no producer can omit them.
 */
export function gltfErr<C extends GltfErrorCode>(
  code: C,
  detail: DetailFor[C],
): Extract<GltfError, { readonly code: C }> {
  return {
    code,
    expected: gltfErrorPolicy[code].expected,
    hint: gltfErrorPolicy[code].hint,
    detail,
  } as Extract<GltfError, { readonly code: C }>;
}
