// bridge-sampler-required.test-d.ts - type-level assertions for
// toMaterialAsset (pass-based, feat-20260526-material-asset-multipass-renderstate M4 / w31).
//
// toMaterialAsset no longer takes a shadingModel parameter; it accepts
// GltfMaterialIr + optional MaterialBridgeContext and returns MaterialAsset.

import type { Handle } from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';
import type { MaterialBridgeContext } from '../bridge.js';
import { toMaterialAsset } from '../bridge.js';
import type { GltfMaterialIr } from '../parse-gltf.js';

const matIr: GltfMaterialIr = {
  name: 'test-material',
  baseColorFactor: [1, 1, 1, 1],
  metallicFactor: 0,
  roughnessFactor: 0.5,
};

const textureHandles = new Map<number, Handle<'TextureAsset', 'shared'>>();
const samplerHandles = new Map<number, Handle<'SamplerAsset', 'shared'>>();

describe('toMaterialAsset — pass-based type-level', () => {
  it('positive: with undefined ctx compiles', () => {
    const result = toMaterialAsset(matIr, undefined);
    expectTypeOf(result).toMatchTypeOf<ReturnType<typeof toMaterialAsset>>();
  });

  it('positive: without ctx compiles', () => {
    const result = toMaterialAsset(matIr);
    expectTypeOf(result).toMatchTypeOf<ReturnType<typeof toMaterialAsset>>();
  });

  it('positive: with both textureHandles and samplerHandles compiles', () => {
    const result = toMaterialAsset(matIr, {
      textureHandles,
      samplerHandles,
    });
    expectTypeOf(result).toMatchTypeOf<ReturnType<typeof toMaterialAsset>>();
  });

  it('positive: with textureHandles only compiles', () => {
    const result = toMaterialAsset(matIr, { textureHandles });
    expectTypeOf(result).toMatchTypeOf<ReturnType<typeof toMaterialAsset>>();
  });

  it('type-level: MaterialBridgeContext has optional samplerHandles', () => {
    const ctx: MaterialBridgeContext = { textureHandles };
    expectTypeOf(ctx).toMatchTypeOf<MaterialBridgeContext>();
  });

  it('type-level: toMaterialAsset is callable as a function', () => {
    expectTypeOf(toMaterialAsset).toBeCallableWith(matIr);
    expectTypeOf(toMaterialAsset).toBeCallableWith(matIr, {
      textureHandles,
      samplerHandles,
    });
  });
});
