import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assetAddCommand } from '../assets.js';

async function projectFixture(meshes: readonly Record<string, unknown>[]): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-source-key-'));
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const bufferUri = `data:application/octet-stream;base64,${Buffer.from(positions.buffer).toString('base64')}`;
  await writeFile(
    resolve(root, 'forge.json'),
    `${JSON.stringify({ id: 'game', name: 'Game', schemaVersion: '3.0.0', roots: {} })}\n`,
  );
  await writeFile(resolve(root, 'package.json'), '{"name":"game"}\n');
  await writeFile(resolve(root, 'main.ts'), 'export async function bootstrap() {}\n');
  await writeFile(
    resolve(root, 'source.gltf'),
    `${JSON.stringify({
      asset: { version: '2.0' },
      meshes,
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }],
      buffers: [{ byteLength: positions.byteLength, uri: bufferUri }],
    })}\n`,
  );
  return root;
}

describe('asset add glTF source-key diagnostics', () => {
  it.each([
    {
      meshes: [
        { name: 'Hero', primitives: [{ attributes: { POSITION: 0 } }] },
        { name: 'Hero', primitives: [{ attributes: { POSITION: 0 } }] },
      ],
      expected: {
        code: 'duplicate-source-key',
        detail: {
          key: 'mesh:Hero',
          sourceIndices: [0, 1],
          entries: [
            { kind: 'mesh', name: 'Hero', sourceIndex: 0 },
            { kind: 'mesh', name: 'Hero', sourceIndex: 1 },
          ],
        },
      },
    },
    {
      meshes: [
        { primitives: [{ attributes: { POSITION: 0 } }] },
        { primitives: [{ attributes: { POSITION: 0 } }] },
      ],
      expected: {
        code: 'ambiguous-source-key',
        detail: {
          key: 'mesh',
          sourceIndices: [0, 1],
          entries: [
            { kind: 'mesh', name: null, sourceIndex: 0 },
            { kind: 'mesh', name: null, sourceIndex: 1 },
          ],
        },
      },
    },
  ])('transmits the producer conflict unchanged', async ({ meshes, expected }) => {
    const root = await projectFixture(meshes);
    try {
      const result = await assetAddCommand({ root, path: 'source.gltf' });
      expect(result).toMatchObject({ ok: false, error: expected });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
