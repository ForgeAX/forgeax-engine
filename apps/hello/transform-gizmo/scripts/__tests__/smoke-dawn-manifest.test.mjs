import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { zstdCompressSync } from 'node:zlib';
import { readShaderManifestText } from '../../../../../scripts/lib/shader-manifest.mjs';

test('Dawn gizmo transports the complete decoded publication in its manifest URL', async (t) => {
  const script = readFileSync(fileURLToPath(new URL('../smoke-dawn.mjs', import.meta.url)), 'utf8');
  const expression = script.match(/shaderManifestUrl: (.+) \},/)[1];
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-gizmo-manifest-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const document = '{"schemaVersion":"5.0.0","probe":"shader-λ","materials":{"probe":{"wgsl":"@vertex fn main() {}"}}}\n';
  for (const bytes of [Buffer.from(document), zstdCompressSync(Buffer.from(document))]) {
    const path = join(directory, 'manifest.json');
    writeFileSync(path, bytes);
    const manifest = readShaderManifestText(path);
    const url = runInNewContext(expression, { manifest, Buffer });
    const response = await fetch(url);
    assert.equal(await response.text(), document);
  }
});
