import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  fbxErr,
  FBX_ERROR_HINTS,
  type FbxAnimationTargetInvalidDetail,
  type FbxError,
  type FbxErrorCode,
  type FbxErrorDetail,
  type FbxMeshTypeUnsupportedDetail,
  type FbxLodDisplayModeUnsupportedDetail,
} from '../src/errors.js';

type ExpectedDetails = {
  readonly 'fbx-mesh-type-unsupported': FbxMeshTypeUnsupportedDetail;
  readonly 'fbx-animation-target-invalid': FbxAnimationTargetInvalidDetail;
  readonly 'fbx-lod-display-mode-unsupported': FbxLodDisplayModeUnsupportedDetail;
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

const expectedCodes = [
  'fbx-mesh-type-unsupported',
  'fbx-animation-target-invalid',
  'fbx-lod-display-mode-unsupported',
] as const satisfies readonly FbxErrorCode[];

const animationDetails = [
  { reason: 'hierarchy-cycle', nodeIndex: 7 },
  { reason: 'name-missing', clipIndex: 0, channelIndex: 1, targetNode: 'Root' },
  { reason: 'path-invalid', clipIndex: 0, channelIndex: 2, targetNode: 'Root/Arm' },
  { reason: 'path-duplicate', clipIndex: 1, channelIndex: 0, targetNode: 'Root/Arm' },
  { reason: 'path-not-found', clipIndex: 1, channelIndex: 1, targetNode: 'Root/Missing' },
  { reason: 'id-collision', clipIndex: 2, channelIndex: 0, targetNode: 'Root/Arm' },
] as const satisfies readonly FbxAnimationTargetInvalidDetail[];

function exhaustiveSwitch(error: FbxError): string {
  switch (error.code) {
    case 'fbx-mesh-type-unsupported':
      return `${error.detail.meshType}:${error.detail.meshName}`;
    case 'fbx-animation-target-invalid':
      return error.detail.reason;
    case 'fbx-lod-display-mode-unsupported':
      return error.detail.displayMode;
  }
}

describe('FbxErrorCode', () => {
  it('keeps the exact two-code vocabulary and correlated union', () => {
    expect(expectedCodes).toHaveLength(3);
    expect(new Set(expectedCodes)).toHaveLength(3);
    expect(Object.keys(FBX_ERROR_HINTS)).toEqual([...expectedCodes]);
    expectTypeOf<FbxErrorCode>().toEqualTypeOf<ExpectedCodes>();
    expectTypeOf<FbxError>().toEqualTypeOf<ExpectedError>();
    expectTypeOf<FbxErrorCode>().toEqualTypeOf<FbxError['code']>();
    expectTypeOf<FbxErrorDetail>().toEqualTypeOf<FbxError['detail']>();
  });

  it('FbxErrorDetail projects the complete error detail surface', () => {
    expectTypeOf<FbxErrorDetail>().toEqualTypeOf<FbxError['detail']>();
  });

  it('closed union: exhaustive switch compiles without default', () => {
    // If the switch is non-exhaustive, tsc will fail (typecheck enabled).
    expect(
      exhaustiveSwitch(
        fbxErr('fbx-mesh-type-unsupported', {
          meshType: 'nurbs',
          meshName: 'Sphere001',
        }),
      ),
    ).toBe('nurbs:Sphere001');
  });

  it('hint contains actionable guidance', () => {
    const hint = FBX_ERROR_HINTS['fbx-mesh-type-unsupported'];
    expect(hint).toContain('NURBS');
    expect(hint).toContain('polygon mesh');
  });

  it('fbxErr mesh-type-unsupported roundtrip', () => {
    const err = fbxErr('fbx-mesh-type-unsupported', {
      meshType: 'nurbs',
      meshName: 'Sphere001',
    });
    expect(err.code).toBe('fbx-mesh-type-unsupported');
    expect(err.expected).toBeTypeOf('string');
    expect(err.hint).toBeTypeOf('string');
    expect(err.detail.meshType).toBe('nurbs');
    expect(err.detail.meshName).toBe('Sphere001');
    expectTypeOf(err).toEqualTypeOf<
      Extract<FbxError, { readonly code: 'fbx-mesh-type-unsupported' }>
    >();
    expectTypeOf(err.detail).toEqualTypeOf<FbxMeshTypeUnsupportedDetail>();
  });

  it('FBX_ERROR_HINTS covers all FbxErrorCode members', () => {
    // TypeScript forces the Record key set to match FbxErrorCode.
    // This runtime check catches gaps at test time.
    for (const code of expectedCodes) {
      expect(FBX_ERROR_HINTS[code]).toBeTypeOf('string');
      expect(FBX_ERROR_HINTS[code].length).toBeGreaterThan(0);
    }
  });

  it('correlates every animation target reason with its code', () => {
    for (const detail of animationDetails) {
      const error = fbxErr('fbx-animation-target-invalid', detail);
      expect(error.code).toBe('fbx-animation-target-invalid');
      expect(error.detail).toEqual(detail);
      expect(error.hint.length).toBeGreaterThan(0);
    }
  });

  it('rejects unknown codes and mismatched code/detail pairs', () => {
    if (false) {
      // @ts-expect-error unknown literals are outside the closed code view
      fbxErr('fbx-not-a-real-error', { meshType: 'nurbs', meshName: 'x' });

      // @ts-expect-error animation details cannot be paired with mesh errors
      fbxErr('fbx-mesh-type-unsupported', { reason: 'hierarchy-cycle', nodeIndex: 0 });

      // @ts-expect-error mesh details cannot be paired with animation errors
      fbxErr('fbx-animation-target-invalid', { meshType: 'nurbs', meshName: 'x' });
    }
  });
});
