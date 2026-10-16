import {
  ImporterRegistry,
  type ImportRunnerFs,
  type RunImportMeta,
  runImport,
} from '@forgeax/engine-import';
import type { ImportContext } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { extractImageBytes } from '../extract-image-bytes.js';
import { gltfImporter } from '../gltf-importer.js';
import { parseGltfForImporter } from '../parse-gltf.js';

const SOURCE = 'malformed-buffer.gltf';
const MESH_GUID = '019f0000-0000-7000-8000-000000000088';

const meta: RunImportMeta = {
  importer: 'gltf',
  source: SOURCE,
  subAssets: [{ guid: MESH_GUID, sourceIndex: 0, sourceKey: 'mesh', kind: 'mesh' }],
};

function dataUri(bytes: Uint8Array): string {
  return `data:application/octet-stream;base64,${btoa(
    Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''),
  )}`;
}

function sourceBytes(bufferUri: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      asset: { version: '2.0' },
      buffers: [{ uri: bufferUri, byteLength: 36 }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      nodes: [],
      scenes: [],
    }),
  );
}

function sourceFs(initialSource: Uint8Array): {
  readonly fs: ImportRunnerFs;
  setSource(source: Uint8Array): void;
} {
  let source = initialSource;
  return {
    fs: {
      readSource: async (sourcePath) =>
        sourcePath === SOURCE
          ? { ok: true as const, value: source }
          : { ok: false as const, error: new Error(`unexpected source path ${sourcePath}`) },
    },
    setSource(nextSource) {
      source = nextSource;
    },
  };
}

describe('malformed glTF buffer data URI recovery', () => {
  it('returns structured refusal, then retries the same registry and GUIDs exactly', async () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const validSource = sourceBytes(dataUri(new Uint8Array(positions.buffer)));
    const malformedSource = sourceBytes('data:application/octet-stream;base64,%%%%');
    const source = sourceFs(malformedSource);
    const registry = new ImporterRegistry();
    registry.register(gltfImporter);

    const parsed = await parseGltfForImporter(
      JSON.parse(new TextDecoder().decode(malformedSource)) as object,
      async () => new ArrayBuffer(0),
      SOURCE,
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe('source-validation-failed');

    const failed = await runImport(meta, registry, source.fs);
    expect(failed.ok).toBe(false);
    expect(failed).not.toHaveProperty('value');
    if (!failed.ok) {
      expect(failed.error.code).toBe('source-validation-failed');
      expect(failed.error.detail).toMatchObject({
        diagnostics: [
          expect.objectContaining({
            code: 'gltf-buffer-data-uri-invalid',
            sourcePath: SOURCE,
          }),
        ],
      });
    }

    source.setSource(validSource);
    const repaired = await runImport(meta, registry, source.fs);
    expect(repaired.ok).toBe(true);
    if (!repaired.ok || 'skipped' in repaired.value)
      throw new Error('repaired import must publish a Pack');
    expect(repaired.value.pack.assets).toHaveLength(1);
    expect(repaired.value.cookProducts).toHaveLength(1);

    const retried = await runImport(meta, registry, source.fs);
    expect(retried.ok).toBe(true);
    if (!retried.ok || 'skipped' in retried.value)
      throw new Error('same-registry retry must publish a Pack');
    expect(retried.value.pack).toEqual(repaired.value.pack);
    expect(retried.value.cookProducts).toEqual(repaired.value.cookProducts);
    expect(registry.registeredImporters()).toEqual(['gltf']);
  });

  it('turns a malformed bufferView image data URI into an extraction failure', async () => {
    const source = new TextEncoder().encode(
      JSON.stringify({
        asset: { version: '2.0' },
        buffers: [{ uri: 'data:application/octet-stream;base64,%%%%', byteLength: 4 }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }],
        images: [{ bufferView: 0, mimeType: 'image/png' }],
      }),
    );
    const context: ImportContext = {
      source: 'image-buffer.gltf',
      readSource: async () => ({ ok: true as const, value: source }),
      readSibling: async () => ({ ok: true as const, value: new Uint8Array() }),
      decodeImage: async () => {
        throw new Error('decodeImage should not run for a failed extraction');
      },
      subAssets: [],
      importSettings: {},
    };

    const result = await extractImageBytes(source, context.source, context);

    expect(result.extracted.size).toBe(0);
    expect(result.failures).toEqual([
      {
        imageIndex: 0,
        source: 'bufferView',
        reason: expect.stringContaining('buffer 0 data URI base64 decode failed'),
      },
    ]);
  });
});
