import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { zstdCompressSync } from 'node:zlib';
import { readShaderManifestText } from '../../../../scripts/lib/shader-manifest.mjs';

test('Collectathon transports decoded shader publication bytes through its Blob URL', async (t) => {
  const source = readFileSync(fileURLToPath(new URL('../smoke-dawn.mjs', import.meta.url)), 'utf8');
  const expression = source.match(/const MANIFEST_URL = (.+);/)[1];
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-collectathon-manifest-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const document = '{"schemaVersion":"5.0.0","probe":"shader-λ"}\n';
  for (const bytes of [Buffer.from(document), zstdCompressSync(Buffer.from(document))]) {
    const path = join(directory, 'manifest.json');
    writeFileSync(path, bytes);
    const url = runInNewContext(expression, {
      MANIFEST_PATH: path,
      readFileSync,
      readShaderManifestText,
      Blob,
      URL,
    });
    try {
      const response = await fetch(url);
      assert.equal(response.headers.get('content-type'), 'application/json');
      assert.equal(await response.text(), document);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
});
