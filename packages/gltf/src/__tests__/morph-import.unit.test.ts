import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { parseGltf } from '../parse-gltf.js';
import { unwrapMeshAsset as meshIrToMeshAsset } from './bridge-test-helpers.js';

function documentWithMorph(targetAccessor: number | object = 1) {
  const values = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1.25, 0, 0, 0, 1, 0]);
  const uri = `data:application/octet-stream;base64,${Buffer.from(values.buffer).toString('base64')}`;
  return {
    asset: { version: '2.0' },
    buffers: [{ uri, byteLength: values.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 36 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
    ],
    meshes: [
      {
        weights: [0.25],
        primitives: [{ attributes: { POSITION: 0 }, targets: [{ POSITION: targetAccessor }] }],
      },
    ],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
}

describe('glTF morph target import', () => {
  it('projects additive POSITION deltas and default weights into MeshAsset', async () => {
    const parsed = await parseGltf(
      documentWithMorph(),
      async () => new ArrayBuffer(0),
      'morph.gltf',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const first = parsed.value.meshes[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const mesh = meshIrToMeshAsset([first]);
    const morphMesh = mesh as typeof mesh & {
      readonly morphTargets?: readonly { readonly position?: Float32Array }[];
      readonly morphWeights?: Float32Array;
    };
    expect(morphMesh.morphTargets?.[0]?.position?.[3]).toBeCloseTo(1.25);
    expect(Array.from(morphMesh.morphWeights ?? [])).toEqual([0.25]);
  });

  it('returns a structured morph error for a missing target accessor', async () => {
    const parsed = await parseGltf(
      documentWithMorph(99),
      async () => new ArrayBuffer(0),
      'morph.gltf',
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe('gltf-morph-invalid');
  });
});
