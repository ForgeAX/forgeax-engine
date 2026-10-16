import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCliGltf } from '../cli-gltf.js';
import { parseGlb, toAssetPack } from '../parse-gltf.js';

const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;

function meshGlb(names: readonly (string | null)[]): Uint8Array {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ name: 'Scene', nodes: names.map((_, index) => index) }],
    nodes: names.map((_, index) => ({ name: `Node${index}`, mesh: index })),
    meshes: names.map((name) => ({
      ...(name === null ? {} : { name }),
      primitives: [{ attributes: { POSITION: 0 } }],
    })),
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }],
    buffers: [{ byteLength: positions.byteLength }],
  };
  const encodedJson = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = Math.ceil(encodedJson.byteLength / 4) * 4;
  const binLength = Math.ceil(positions.byteLength / 4) * 4;
  const bytes = new Uint8Array(12 + 8 + jsonLength + 8 + binLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.byteLength, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, GLB_JSON_CHUNK, true);
  bytes.fill(0x20, 20, 20 + jsonLength);
  bytes.set(encodedJson, 20);
  const binHeader = 20 + jsonLength;
  view.setUint32(binHeader, binLength, true);
  view.setUint32(binHeader + 4, 0x004e4942, true);
  bytes.set(new Uint8Array(positions.buffer), binHeader + 8);
  return bytes;
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function directError(bytes: Uint8Array, source: string): Promise<unknown> {
  const parsed = await parseGlb(bytes.buffer as ArrayBuffer, source);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return undefined;
  const packed = toAssetPack(parsed.value, undefined, source);
  expect(packed.ok).toBe(false);
  return packed.ok ? undefined : packed.error;
}

describe('glTF source-key diagnostics', () => {
  it.each([
    {
      label: 'named duplicate',
      names: ['Hero', 'Hero'],
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
      label: 'anonymous ambiguity',
      names: [null, null],
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
  ])('keeps direct and CLI $label errors identical without mutating the GLB', async (fixture) => {
    const tempDir = await mkdtemp(join(tmpdir(), 'gltf-source-key-detail-'));
    try {
      const sourcePath = join(tempDir, `${fixture.label.replaceAll(' ', '-')}.glb`);
      const bytes = meshGlb(fixture.names);
      const before = digest(bytes);
      await writeFile(sourcePath, bytes);

      const direct = await directError(bytes, sourcePath);
      expect(direct).toMatchObject(fixture.expected);

      const stderr: string[] = [];
      const exitCode = await runCliGltf(['import', sourcePath], {
        stdoutWrite: () => {},
        stderrWrite: (line) => stderr.push(line),
      });
      expect(exitCode).toBe(1);
      const cli = JSON.parse(stderr[0] as string) as unknown;
      expect(cli).toEqual(direct);
      await expect(access(`${sourcePath}.meta.json`)).rejects.toThrow();
      expect(digest(await readFile(sourcePath))).toBe(before);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('continues to write a sibling meta for a valid GLB without mutating its source', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'gltf-source-key-success-'));
    try {
      const sourcePath = join(tempDir, 'unique.glb');
      const bytes = meshGlb(['HeroA', 'HeroB']);
      const before = digest(bytes);
      await writeFile(sourcePath, bytes);

      const exitCode = await runCliGltf(['import', sourcePath], {
        stdoutWrite: () => {},
        stderrWrite: () => {},
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(await readFile(`${sourcePath}.meta.json`, 'utf-8'))).toMatchObject({
        importer: 'gltf',
        source: 'unique.glb',
      });
      expect(digest(await readFile(sourcePath))).toBe(before);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
