import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeDocumentText } from '@forgeax/engine-codec';
import { normalizePath } from 'vite';
import { describe, expect, it } from 'vitest';
import { forgeaxShader } from '../index.js';

interface EmittedAsset {
  readonly type: 'asset';
  readonly fileName: string;
  readonly source: string | Uint8Array;
}

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const sourcePath = normalizePath(
  resolve(repoRoot, 'apps/hello/custom-shader/src/pulse-material.wgsl'),
);
const packagePath = resolve(
  repoRoot,
  'apps/hello/custom-shader/src/pulse-material.shader.pack.json',
);

async function emitManifest(
  command: 'build' | 'serve',
  compressManifest = true,
): Promise<EmittedAsset> {
  const source = await readFile(sourcePath, 'utf8');
  const plugin = forgeaxShader({
    engineEntries: false,
    materialPackages: [packagePath],
    compressManifest,
  });
  const emitted: EmittedAsset[] = [];
  const context = {
    emitFile(asset: EmittedAsset) {
      emitted.push(asset);
      return asset.fileName;
    },
    error(log: { message: string }): never {
      throw new Error(log.message);
    },
  };
  plugin.config({}, { command });
  await plugin.transform.call(context as never, source, sourcePath);
  await plugin.generateBundle.call(context as never);
  const manifest = emitted.find((asset) => asset.fileName === 'shaders/manifest.json');
  if (manifest === undefined) throw new Error('manifest was not emitted');
  return manifest;
}

describe('shader manifest delivery encoding', () => {
  it('ships a production manifest as one zstd frame that decodes to the plain document', async () => {
    const plain = await emitManifest('serve');
    const packed = await emitManifest('build');
    expect(typeof plain.source).toBe('string');
    expect(packed.source).toBeInstanceOf(Uint8Array);
    const bytes = packed.source as Uint8Array;
    expect([...bytes.subarray(0, 4)]).toEqual([0x28, 0xb5, 0x2f, 0xfd]);
    expect(bytes.byteLength).toBeLessThan((plain.source as string).length);
    const decoded = await decodeDocumentText(bytes);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value).toBe(plain.source);
  });

  it('keeps a default production build manifest as plain JSON for tools that read dist', async () => {
    const plain = await emitManifest('build', false);
    expect(typeof plain.source).toBe('string');
    expect(() => JSON.parse(plain.source as string)).not.toThrow();
  });

  it('keeps the producer manifest as plain JSON for release scripts', async () => {
    const previous = process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD;
    process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD = '1';
    try {
      const producer = await emitManifest('build');
      expect(typeof producer.source).toBe('string');
      expect(() => JSON.parse(producer.source as string)).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD;
      else process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD = previous;
    }
  });
});
