import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { dispatchBundleSize } from '../run-all.mjs';

function fixture(run) {
  const root = mkdtempSync(resolve(tmpdir(), 'forgeax-bundle-inputs-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('directory measurement counts every emitted file with the declared compression', () =>
  fixture((root) => {
    mkdirSync(resolve(root, 'dist/assets'), { recursive: true });
    const html = Buffer.from('<script src="assets/index.js"></script>');
    const script = Buffer.from('export const frame = 60;');
    writeFileSync(resolve(root, 'dist/index.html'), html);
    writeFileSync(resolve(root, 'dist/assets/index.js'), script);
    for (const [compression, compress] of [
      ['gzip', gzipSync],
      ['brotli', brotliCompressSync],
    ]) {
      const size = compress(html).length + compress(script).length;
      const result = dispatchBundleSize('water', root, {
        path: 'dist',
        compression,
        baseline: { threshold: size - 1 },
      });
      assert.equal(result.status, 'over');
      assert.equal(result.value, size);
      assert.equal(result.details.raw, html.length + script.length);
      assert.equal(result.details.files, 2);
    }
  }));

test('missing and empty artifacts retain missing status without a measurement', () =>
  fixture((root) => {
    const decl = { path: 'dist', compression: 'gzip' };
    assert.equal(dispatchBundleSize('water', root, decl).status, 'missing');
    mkdirSync(resolve(root, 'dist'));
    const result = dispatchBundleSize('water', root, decl);
    assert.equal(result.status, 'missing');
    assert.equal(result.value, null);
  }));

test('single-file measurements preserve existing bytes and threshold behavior', () =>
  fixture((root) => {
    const bytes = Buffer.from('original library output');
    writeFileSync(resolve(root, 'index.mjs'), bytes);
    const result = dispatchBundleSize('library', root, { path: 'index.mjs', compression: 'gzip' });
    assert.equal(result.value, gzipSync(bytes).length);
    assert.equal(result.details.raw, bytes.length);
    assert.equal(result.status, 'ok');
  }));
