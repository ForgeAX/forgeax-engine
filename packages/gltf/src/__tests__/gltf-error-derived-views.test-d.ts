import { describe, expectTypeOf, it } from 'vitest';
import {
  type GltfAccessorTypeMismatchDetail,
  type GltfAnimationCubicsplineUnsupportedDetail,
  type GltfAnimationTargetInvalidDetail,
  type GltfBufferOutOfBoundsDetail,
  type GltfColorAccessorMalformedDetail,
  type GltfColorAccessorUnsupportedDetail,
  type GltfDracoDecodeFailedDetail,
  type GltfDracoDetail,
  type GltfError,
  type GltfErrorCode,
  type GltfErrorDetail,
  type GltfExtensionUnsupportedDetail,
  type GltfImageExtractFailedDetail,
  type GltfImageMimeUnsupportedDetail,
  type GltfInstancingCountMismatchDetail,
  type GltfLodInvalidDetail,
  type GltfMalformedHeaderDetail,
  type GltfMaterialPhysicalInvalidDetail,
  type GltfMaterialTransmissionInvalidDetail,
  type GltfMeshBridgeInvalidDetail,
  type GltfMeshoptDecodeFailedDetail,
  type GltfMeshoptDecoderRequiredDetail,
  type GltfMetaMissingDetail,
  type GltfMorphInvalidDetail,
  type GltfMorphUnsupportedDetail,
  type GltfSkinAttrAsymmetricDetail,
  type GltfSkinJointCountExceededDetail,
  type GltfSkinJointNameMissingDetail,
  type GltfTextureLoadFailedDetail,
  type GltfVersionUnsupportedDetail,
  gltfErr,
} from '../errors.js';

type ExpectedDetails = {
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
  readonly 'gltf-lod-invalid': GltfLodInvalidDetail;
  readonly 'gltf-material-transmission-invalid': GltfMaterialTransmissionInvalidDetail;
  readonly 'gltf-material-physical-invalid': GltfMaterialPhysicalInvalidDetail;
};

type ExpectedCodes = keyof ExpectedDetails;
type ExpectedError = {
  readonly [C in ExpectedCodes]: {
    readonly code: C;
    readonly expected: string;
    readonly hint: string;
    readonly detail: ExpectedDetails[C];
  };
}[ExpectedCodes];

function exhaustive(error: GltfError): string {
  switch (error.code) {
    case 'gltf-camera-invalid':
      return String(error.detail.cameraIndex);
    case 'gltf-animation-sampler-invalid':
      return error.detail.reason;
    case 'gltf-malformed-header':
      return `${error.detail.filePath}:${error.detail.byteOffset}`;
    case 'gltf-version-unsupported':
      return error.detail.actualVersion;
    case 'gltf-buffer-out-of-bounds':
      return `${error.detail.accessor}:${error.detail.bufferIndex}`;
    case 'gltf-extension-unsupported':
      return error.detail.extension;
    case 'gltf-lod-invalid':
      return String(error.detail.rootNode);
    case 'gltf-accessor-type-mismatch':
      return error.detail.reason;
    case 'gltf-texture-load-failed':
      return error.detail.uri;
    case 'gltf-meta-missing':
      return error.detail.expectedMetaPath;
    case 'gltf-instancing-count-mismatch':
      return error.detail.accessor;
    case 'gltf-image-mime-unsupported':
      return error.detail.mimeType;
    case 'gltf-skin-joint-count-exceeded':
      return `${error.detail.skinIndex}:${error.detail.maxJoints}`;
    case 'gltf-animation-cubicspline-unsupported':
      return `${error.detail.animationIndex}:${error.detail.samplerIndex}`;
    case 'gltf-morph-unsupported':
      return `${error.detail.animationIndex}:${error.detail.channelIndex}`;
    case 'gltf-skin-joint-name-missing':
      return error.detail.reason;
    case 'gltf-image-extract-failed':
      return error.detail.source;
    case 'gltf-skin-attr-asymmetric':
      return `${error.detail.meshIndex}:${error.detail.primitiveIndex}`;
    case 'gltf-animation-target-invalid':
      return error.detail.reason;
    case 'gltf-draco-decoder-required':
      return String(error.detail.bufferView);
    case 'gltf-draco-decode-failed':
      return error.detail.reason;
    case 'gltf-meshopt-decoder-required':
      return `${error.detail.bufferView}:${error.detail.actual}`;
    case 'gltf-meshopt-decode-failed':
      return `${error.detail.bufferView}:${error.detail.mode}`;
    case 'gltf-morph-invalid':
      return `${error.detail.meshIndex}:${error.detail.primitiveIndex}:${error.detail.reason}`;
    case 'gltf-color-accessor-unsupported':
      return `${error.detail.semantic}:${error.detail.accessorIndex}:${error.detail.reason}`;
    case 'gltf-color-accessor-malformed':
      return `${error.detail.semantic}:${error.detail.accessorIndex}:${error.detail.reason}`;
    case 'gltf-mesh-bridge-invalid':
      return error.detail.reason;
    case 'gltf-material-transmission-invalid':
      return `${error.detail.extension}:${error.detail.field}:${error.detail.reason}`;
    case 'gltf-material-physical-invalid':
      return `${error.detail.extension}:${error.detail.field}:${error.detail.reason}`;
  }
  return error;
}

describe('GltfError derived public views', () => {
  it('keeps the exact closed code vocabulary and correlated union', () => {
    expectTypeOf<GltfErrorCode>().toEqualTypeOf<ExpectedCodes>();
    expectTypeOf<GltfError>().toEqualTypeOf<ExpectedError>();
    expectTypeOf<GltfErrorCode>().toEqualTypeOf<GltfError['code']>();
    expectTypeOf<GltfErrorDetail>().toEqualTypeOf<GltfError['detail']>();
  });

  it('rejects unknown codes and mismatched code/detail pairs', () => {
    // @ts-expect-error unknown literals are outside the closed code view
    const invalidCode: GltfErrorCode = 'gltf-not-a-real-error';
    void invalidCode;

    // @ts-expect-error the detail must match the selected code
    gltfErr('gltf-malformed-header', { uri: 'textures/wrong.png' });
  });

  it('preserves gltfErr inference for a selected correlated variant', () => {
    const error = gltfErr('gltf-version-unsupported', {
      filePath: 'model.gltf',
      actualVersion: '1.0',
    });
    expectTypeOf(error).toEqualTypeOf<
      Extract<GltfError, { readonly code: 'gltf-version-unsupported' }>
    >();
    expectTypeOf(error.detail).toEqualTypeOf<GltfVersionUnsupportedDetail>();
  });

  it('supports exhaustive narrowing across every derived variant', () => {
    expectTypeOf(exhaustive).toBeCallableWith({
      code: 'gltf-meta-missing',
      expected: 'sidecar',
      hint: 'import it',
      detail: { filePath: 'model.gltf', expectedMetaPath: 'model.gltf.meta.json' },
    });
  });
});
