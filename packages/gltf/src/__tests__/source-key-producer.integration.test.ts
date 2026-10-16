import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateProducerOutputs } from '@forgeax/engine-pack';
import { scan } from '@forgeax/engine-pack/scanner';
import { describe, expect, it } from 'vitest';
import { runCliGltf } from '../cli-gltf.js';
import { createGltfImporter } from '../gltf-importer.js';
import type { GltfDoc } from '../parse-gltf.js';
import { toAssetPack } from '../parse-gltf.js';
import { serializeMetaJson } from '../serialize-meta.js';

function duplicateNamedMeshDoc(): GltfDoc {
  return {
    meshes: [
      { name: 'Hero', positions: new Float32Array(), materialIndex: null, meshIndex: 0 },
      { name: 'Hero', positions: new Float32Array(), materialIndex: null, meshIndex: 1 },
    ],
    materials: [],
    nodes: [],
    scenes: [],
    textures: undefined,
    images: undefined,
    samplers: undefined,
    skeletons: [],
    animationClips: [],
    defaultSceneIndex: 0,
    diagnostics: { nodeNames: [], unsupportedExtensions: [], matrixTrsCoexistNodes: [] },
  };
}

function uniqueNamedMeshDoc(): GltfDoc {
  const doc = duplicateNamedMeshDoc();
  return {
    ...doc,
    meshes: doc.meshes.map((mesh, index) => ({ ...mesh, name: `Hero${index}` })),
  };
}

function duplicateNamedMaterialDoc(): GltfDoc {
  const material = {
    name: 'Window',
    baseColorFactor: [1, 1, 1, 1] as const,
    metallicFactor: 0,
    roughnessFactor: 1,
  };
  return {
    ...duplicateNamedMeshDoc(),
    meshes: [],
    materials: [material, material],
  };
}

function duplicateNamedMeshGltfJson(): Record<string, unknown> {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const bufferUri = `data:application/octet-stream;base64,${Buffer.from(positions.buffer).toString('base64')}`;
  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ name: 'Scene', nodes: [0, 1] }],
    nodes: [
      { name: 'A', mesh: 0 },
      { name: 'B', mesh: 1 },
    ],
    meshes: [
      { name: 'Hero', primitives: [{ attributes: { POSITION: 0 } }] },
      { name: 'Hero', primitives: [{ attributes: { POSITION: 0 } }] },
    ],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }],
    buffers: [{ byteLength: positions.byteLength, uri: bufferUri }],
  };
}

describe('glTF producer source-key boundary', () => {
  it('keeps procedural runtime stubs out of the Catalog projection', () => {
    const publish = createGltfImporter().capabilities?.catalog?.publish;
    expect(publish).toBeTypeOf('function');
    expect(publish?.({ importSettings: { geometry: 'procedural' }, subAssets: [] })).toBe(false);
    expect(publish?.({ importSettings: {}, subAssets: [] })).toBe(true);
  });

  it('returns a structured conflict before publishing duplicate semantic names', () => {
    const result = toAssetPack(duplicateNamedMeshDoc(), undefined, 'duplicate.gltf');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('duplicate-source-key');
    expect((result.error.detail as { sourceIndices: readonly number[] }).sourceIndices).toEqual([
      0, 1,
    ]);
  });

  it('applies the same preflight to duplicate material names', () => {
    const result = toAssetPack(duplicateNamedMaterialDoc(), undefined, 'duplicate.gltf');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('duplicate-source-key');
    expect((result.error.detail as { sourceIndices: readonly number[] }).sourceIndices).toEqual([
      0, 1,
    ]);
  });

  it('publishes producer-valid output when semantic identity is unique', () => {
    const result = toAssetPack(uniqueNamedMeshDoc(), undefined, 'unique.gltf');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validateProducerOutputs(result.value.subAssets).ok).toBe(true);
  });

  it('serializes a valid output that the pack scanner accepts immediately', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'gltf-source-key-'));
    try {
      const result = toAssetPack(uniqueNamedMeshDoc(), undefined, 'unique.gltf');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      await writeFile(join(tempDir, 'unique.gltf'), '{}', 'utf-8');
      await writeFile(
        join(tempDir, 'unique.gltf.meta.json'),
        serializeMetaJson(result.value.meta),
        'utf-8',
      );

      const scanResult = await scan([tempDir]);
      expect(scanResult.ok).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('fails before writing and preserves the previous sidecar', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'gltf-cli-source-key-'));
    try {
      const sourcePath = join(tempDir, 'duplicate.gltf');
      const metaPath = `${sourcePath}.meta.json`;
      const previous = serializeMetaJson({
        schemaVersion: 1,
        kind: 'external-asset-package',
        importer: 'gltf',
        source: 'duplicate.gltf',
        subAssets: [
          {
            guid: '01928000-7c00-7000-8000-000000000001',
            sourceIndex: 0,
            kind: 'mesh',
            sourceKey: 'mesh:previous',
          },
        ],
        importSettings: {
          defaultSceneIndex: 0,
          diagnostics: { nodeNames: [], unsupportedExtensions: [], matrixTrsCoexistNodes: [] },
        },
      });
      await writeFile(sourcePath, JSON.stringify(duplicateNamedMeshGltfJson()), 'utf-8');
      await writeFile(metaPath, previous, 'utf-8');
      const stderr: string[] = [];

      const code = await runCliGltf(['import', sourcePath], {
        stdoutWrite: () => {},
        stderrWrite: (line) => stderr.push(line),
      });

      expect(code).toBe(1);
      expect(JSON.parse(stderr[0] as string)).toMatchObject({
        code: 'duplicate-source-key',
        detail: { sourceIndices: [0, 1] },
      });
      expect(await readFile(metaPath, 'utf-8')).toBe(previous);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
