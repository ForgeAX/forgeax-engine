import type { MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { meshIrToMeshAsset as bridgeMeshIrToMeshAsset } from '../bridge.js';
import type { GltfMeshIr } from '../parse-gltf.js';
import { unwrapMeshAsset as meshIrToMeshAsset } from './bridge-test-helpers.js';

type ColorMeshIr = GltfMeshIr & { readonly colors0?: Float32Array };

function primitive(vertexCount: number, colors0?: Float32Array): ColorMeshIr {
  const positions = new Float32Array(vertexCount * 3);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    positions[vertex * 3 + 0] = vertex;
  }
  return {
    positions,
    indices: new Uint16Array(vertexCount === 3 ? [0, 1, 2] : [0, 1, 2, 0, 2, 3]),
    materialIndex: 0,
    meshIndex: 0,
    ...(colors0 === undefined ? {} : { colors0 }),
  };
}

function color(asset: MeshAsset): Float32Array | undefined {
  return asset.attributes.color as Float32Array | undefined;
}

describe('glTF bridge COLOR_0 mixed primitive contract', () => {
  it('takes the attributes union and fills absent primitive vertices with white', () => {
    const colored = primitive(3, new Float32Array([1, 0.5, 0, 1, 0, 1, 0.5, 1, 0.25, 0, 1, 1]));
    const plain = primitive(3);
    const asset = meshIrToMeshAsset([colored, plain]);
    expect(color(asset)).toEqual(
      new Float32Array([
        1, 0.5, 0, 1, 0, 1, 0.5, 1, 0.25, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
      ]),
    );
  });

  it.each([
    ['all colored', [primitive(3, new Float32Array(12)), primitive(4, new Float32Array(16))]],
    ['all plain', [primitive(3), primitive(4)]],
    [
      'skin and UV combination',
      [
        {
          ...primitive(3, new Float32Array(12)),
          joints0: new Uint16Array(12),
          weights0: new Float32Array(12),
          texcoord0: new Float32Array(6),
          texcoord1: new Float32Array(6),
        },
      ],
    ],
  ] as const)('uses one canonical packer for %s', (_name, prims) => {
    const asset = meshIrToMeshAsset(prims);
    const attributes = asset.attributes as Record<string, unknown>;
    expect(attributes.position).toBeInstanceOf(Float32Array);
    expect(attributes.color === undefined || attributes.color instanceof Float32Array).toBe(true);
  });

  it('keeps a missing color stream unallocated for a plain mesh', () => {
    const asset = meshIrToMeshAsset([primitive(3)]);
    expect(color(asset)).toBeUndefined();
  });

  it('returns closed, typed bridge failures before publishing malformed meshes', () => {
    const empty = bridgeMeshIrToMeshAsset([]);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.detail).toEqual({ reason: 'empty-input', primitiveCount: 0 });

    const morphMismatch = bridgeMeshIrToMeshAsset([
      { ...primitive(3), morphTargets: [] },
      { ...primitive(3), morphTargets: [{ position: new Float32Array(9) }] },
    ]);
    expect(morphMismatch.ok).toBe(false);
    if (!morphMismatch.ok)
      expect(morphMismatch.error.detail).toMatchObject({
        reason: 'morph-count-mismatch',
        expectedTargetCount: 0,
        actualTargetCount: 1,
      });

    const colorMismatch = bridgeMeshIrToMeshAsset([primitive(3, new Float32Array(4))]);
    expect(colorMismatch.ok).toBe(false);
    if (!colorMismatch.ok)
      expect(colorMismatch.error.detail).toMatchObject({
        reason: 'color-cardinality',
        semantic: 'COLOR_0',
        expectedLength: 12,
        actualLength: 4,
      });

    const layoutMismatch = bridgeMeshIrToMeshAsset([
      { ...primitive(3), positions: new Float32Array(4) },
    ]);
    expect(layoutMismatch.ok).toBe(false);
    if (!layoutMismatch.ok)
      expect(layoutMismatch.error.detail).toMatchObject({ reason: 'layout-invalid' });
  });
});
