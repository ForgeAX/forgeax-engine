import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCliGltf } from '../cli-gltf.js';
import { parseGlb, parseGltf } from '../index.js';
import { parseGlbFromFile, parseGltfFromFile } from '../node-file-entry.js';

const source = {
  asset: { version: '2.0' },
  buffers: [{ uri: 'data:application/octet-stream;base64,%%%%', byteLength: 4 }],
};

function glb(): ArrayBuffer {
  const json = JSON.stringify(source);
  const padded = json.padEnd(Math.ceil(json.length / 4) * 4, ' ');
  const bytes = new ArrayBuffer(20 + padded.length);
  const header = new DataView(bytes);
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, bytes.byteLength, true);
  header.setUint32(12, padded.length, true);
  header.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(bytes, 20).set(new TextEncoder().encode(padded));
  return bytes;
}

describe('glTF parser failure entrypoints', () => {
  it.each([
    'gltf',
    'glb',
  ] as const)('preserves %s source diagnostics through public, file and CLI entries', async (format) => {
    const root = await mkdtemp(join(tmpdir(), 'gltf-parse-entry-'));
    try {
      const path = join(root, `source.${format}`);
      const data = format === 'gltf' ? JSON.stringify(source) : new Uint8Array(glb());
      await writeFile(path, data);
      await writeFile(`${path}.meta.json`, '{}');
      const parsed =
        format === 'gltf'
          ? await parseGltf(source, async () => new ArrayBuffer(0), path)
          : await parseGlb(glb(), path);
      const file = format === 'gltf' ? await parseGltfFromFile(path) : await parseGlbFromFile(path);
      const stderr: string[] = [];
      const status = await runCliGltf(['import', path], {
        stdoutWrite: () => {},
        stderrWrite: (line) => stderr.push(line),
      });
      expect(status).toBe(1);
      for (const result of [parsed, file]) {
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: 'source-validation-failed',
            detail: {
              diagnostics: [
                expect.objectContaining({
                  code: 'gltf-buffer-data-uri-invalid',
                  sourcePath: path,
                }),
              ],
            },
          },
        });
      }
      expect(stderr).toHaveLength(1);
      if (parsed.ok) throw new Error('malformed source must fail');
      expect(JSON.parse(stderr[0] ?? '')).toEqual({
        code: parsed.error.code,
        expected: parsed.error.expected,
        hint: parsed.error.hint,
        detail: parsed.error.detail,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
