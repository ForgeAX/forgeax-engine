import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  FBX_ERROR_HINTS,
  fbxErr,
  type FbxError,
  type FbxErrorCode,
} from '../src/index.js';

const expectedCodes = [
  'fbx-mesh-type-unsupported',
  'fbx-animation-target-invalid',
  'fbx-lod-display-mode-unsupported',
] as const satisfies readonly FbxErrorCode[];

describe('FBX error policy owner', () => {
  it('derives the exact public hint record without changing its own keys', () => {
    expect(expectedCodes).toHaveLength(3);
    expect(new Set(expectedCodes)).toHaveLength(3);
    expect(Object.keys(FBX_ERROR_HINTS)).toEqual([...expectedCodes]);
    expect(Object.getOwnPropertyNames(FBX_ERROR_HINTS)).toEqual([...expectedCodes]);
    expect(Object.getOwnPropertySymbols(FBX_ERROR_HINTS)).toEqual([]);
    expectTypeOf(FBX_ERROR_HINTS).toEqualTypeOf<Readonly<Record<FbxErrorCode, string>>>();

    for (const code of expectedCodes) {
      const descriptor = Object.getOwnPropertyDescriptor(FBX_ERROR_HINTS, code);
      expect(Object.prototype.propertyIsEnumerable.call(FBX_ERROR_HINTS, code)).toBe(true);
      expect(descriptor).toMatchObject({
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }

    expect(FBX_ERROR_HINTS['fbx-mesh-type-unsupported']).toBe(
      'NURBS and patch surfaces are not supported; convert to polygon mesh in a DCC tool before import',
    );
    expect(FBX_ERROR_HINTS['fbx-animation-target-invalid']).toBe(
      'name every node, keep the hierarchy acyclic, and export unique full animation target paths',
    );
  });

  it('keeps expected and hint values on the same correlated fbxErr output', () => {
    const meshError = fbxErr('fbx-mesh-type-unsupported', {
      meshType: 'nurbs',
      meshName: 'Sphere001',
    });
    expect(meshError).toEqual({
      code: 'fbx-mesh-type-unsupported',
      expected: 'all meshes in the file are polygon (triangles/quads), not NURBS or patch surfaces',
      hint: 'NURBS and patch surfaces are not supported; convert to polygon mesh in a DCC tool before import',
      detail: { meshType: 'nurbs', meshName: 'Sphere001' },
    });
    expect(Object.keys(meshError)).toEqual(['code', 'expected', 'hint', 'detail']);
    expectTypeOf(meshError).toEqualTypeOf<
      Extract<FbxError, { readonly code: 'fbx-mesh-type-unsupported' }>
    >();

    const animationError = fbxErr('fbx-animation-target-invalid', {
      reason: 'path-invalid',
      clipIndex: 2,
      channelIndex: 3,
      targetNode: 'Root/Arm',
    });
    expect(animationError.expected).toBe(
      'an acyclic hierarchy where every animation channel uniquely matches one named Scene node and stable target ID',
    );
    expect(animationError.hint).toBe(
      'name every node, keep the hierarchy acyclic, and export unique full animation target paths',
    );
    expect(animationError.detail).toEqual({
      reason: 'path-invalid',
      clipIndex: 2,
      channelIndex: 3,
      targetNode: 'Root/Arm',
    });
    expect(Object.keys(animationError)).toEqual(['code', 'expected', 'hint', 'detail']);
    expectTypeOf(animationError).toEqualTypeOf<
      Extract<FbxError, { readonly code: 'fbx-animation-target-invalid' }>
    >();
  });
});
