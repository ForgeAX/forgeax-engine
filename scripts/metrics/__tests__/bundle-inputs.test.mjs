import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { declaredBundleApps, prepareBundleInputs } from '../bundle-inputs.mjs';
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

test('preparation selects only enabled app bundles and retains explicit shared producer inputs', () =>
  fixture((root) => {
    for (const [name, enabled] of [
      ['water', true],
      ['unmeasured', false],
    ]) {
      mkdirSync(resolve(root, `apps/${name}`), { recursive: true });
      writeFileSync(
        resolve(root, `apps/${name}/package.json`),
        JSON.stringify({
          name,
          scripts: { build: 'vite build' },
          forgeax: { metrics: { 'bundle-size': { enabled, path: 'dist' } } },
        }),
      );
    }
    mkdirSync(resolve(root, 'shared/shaders'), { recursive: true });
    writeFileSync(resolve(root, 'shared/shaders/manifest.json'), '{}');
    const producer = {
      inventory: ['shared/shaders/manifest.json'],
      payload: { engineShaderManifest: 'shared/shaders/manifest.json' },
    };
    writeFileSync(resolve(root, 'shared/manifest.json'), JSON.stringify(producer));
    assert.equal(declaredBundleApps(root).length, 1);
    let calls = 0;
    prepareBundleInputs({
      root,
      manifestPath: 'shared/manifest.json',
      run(command, args, options) {
        calls++;
        assert.equal(command, process.execPath);
        assert.deepEqual(args, [
          resolve(root, 'scripts/build-apps.mjs'),
          '--shared-input-manifest',
          resolve(root, 'shared/manifest.json'),
          'water',
        ]);
        assert.equal(options.shell, false);
        mkdirSync(resolve(root, 'apps/water/dist'));
        return { status: 0 };
      },
    });
    assert.equal(calls, 1);
    assert.throws(
      () =>
        prepareBundleInputs({
          root,
          manifestPath: 'shared/manifest.json',
          run: () => ({ status: 1 }),
        }),
      /producer failed/,
    );
    assert.throws(() => prepareBundleInputs({ root }), /selected shared input/);
  }));

test('runtime workflow prepares declared bundles before measurement without another engine build', () => {
  const source = readFileSync(
    new URL('../../../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  const runtime = source.slice(
    source.indexOf('  metrics-validate-runtime:'),
    source.indexOf('\n  metrics-validate:', source.indexOf('  metrics-validate-runtime:')),
  );
  const prepare = runtime.indexOf('node scripts/metrics/bundle-inputs.mjs');
  assert.ok(prepare >= 0 && prepare < runtime.indexOf('run: pnpm metrics:run\n'));
  assert.match(
    runtime.slice(runtime.lastIndexOf('- name:', prepare), prepare),
    /if: steps\.ci-repair\.outputs\.reused != 'true'/,
  );
});
