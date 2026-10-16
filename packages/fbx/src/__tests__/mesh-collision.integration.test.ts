import { decodeMeshBinary } from '@forgeax/engine-geometry';
import type { MeshPod } from '@forgeax/engine-types';
import { expect, test } from 'vitest';
import { buildMeshAsset } from '../to-asset-pack';

test('G28 FBX canonical source bridge cooks portable collision without changing GUID', () => {
  const source: MeshPod = {
    name: 'Triangle',
    sourceIndex: 0,
    vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint16Array([0, 1, 2]),
    attributes: {},
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 3,
        vertexCount: 3,
        topology: 'triangle-list',
        materialIndex: 0,
      },
    ],
  };
  const guid = '019d0000-0000-7000-8000-000000000010';
  const output = buildMeshAsset(source, guid, undefined, { meshCollision: true });
  const body = output.artifacts.body;
  if (!body) throw new Error('missing mesh artifact');
  expect(output.guid).toBe(guid);
  expect(decodeMeshBinary(body.bytes, [])?.collision?.indices).toEqual(new Uint32Array([0, 1, 2]));
  expect(() => buildMeshAsset(source, guid, undefined, { meshCollision: 1 })).toThrow();
});
