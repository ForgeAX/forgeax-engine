import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import { decodeShaderManifestText, readShaderManifestText } from '../shader-manifest.mjs';

function fixture(t, bytes) {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-shader-manifest-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'manifest.json');
  writeFileSync(path, bytes);
  return path;
}

const document = '{"schemaVersion":1,"materials":{"probe":"shader-λ"}}\n';

test('borrowed producer bytes decode without another file read or changing their identity', () => {
  for (const bytes of [
    new TextEncoder().encode(document),
    zstdCompressSync(Buffer.from(document)),
  ]) {
    const original = Uint8Array.from(bytes);
    assert.equal(decodeShaderManifestText(bytes), document);
    assert.deepEqual(Uint8Array.from(bytes), original);
  }
});

test('smoke readers retain plain producer JSON text without transformation', (t) => {
  assert.equal(readShaderManifestText(fixture(t, document)), document);
});

test('smoke readers decode the production zstd frame before parsing JSON', (t) => {
  const path = fixture(t, zstdCompressSync(Buffer.from(document)));
  assert.equal(readShaderManifestText(path), document);
  assert.deepEqual(JSON.parse(readShaderManifestText(path)), JSON.parse(document));
});

test('smoke JSON consumers reject truncated production frames rather than accepting missing data', (t) => {
  const path = fixture(t, Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
  assert.throws(() => JSON.parse(readShaderManifestText(path)), SyntaxError);
});

test('smoke readers propagate corrupt production frame errors', (t) => {
  const path = fixture(t, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0xff, 0xff, 0xff]));
  assert.throws(() => readShaderManifestText(path));
});
