import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const execute = promisify(execFile);

test('Basis native projection retains the original source and WASM identity', async () => {
  const owner = resolve(root, 'packages/codec');
  const provenance = JSON.parse(
    await readFile(resolve(owner, 'dist/basis-native-factory.provenance.json'), 'utf8'),
  );
  for (const [path, expected] of [
    ['pkg/basis_transcoder.mjs', provenance.source],
    ['pkg/basis_transcoder.wasm', provenance.wasm],
    ['dist/basis-native-factory.mjs', provenance.javascript],
    [provenance.producer.path, provenance.producer],
  ]) {
    const bytes = await readFile(resolve(owner, path));
    assert.equal(expected.bytes, bytes.length);
    assert.equal(expected.sha256, createHash('sha256').update(bytes).digest('hex'));
  }
});

test('Basis preserves the Emscripten factory through native failure, retry and actual mip transcode', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/basis-native-host.mjs', import.meta.url));
  const results = [];
  for (const mode of ['browser', 'native']) {
    const { stdout } = await execute(
      process.execPath,
      [...(mode === 'native' ? ['--conditions=forgeax-native'] : []), fixture, mode],
      { cwd: root, timeout: 30_000 },
    );
    results.push(JSON.parse(stdout.trim()));
  }
  assert.equal(results[0].levels, 5);
  assert.deepEqual(
    results[1],
    results[0],
    'native and default factory paths must produce identical pixels/blocks',
  );
});

test('Basis native bundle selects the full published factory and excludes the browser URL loader', async () => {
  const require = createRequire(resolve(root, 'package.json'));
  const { build } = createRequire(require.resolve('tsup'))('esbuild');
  const options = {
    entryPoints: [resolve(root, 'packages/codec/dist/index.mjs')],
    bundle: true,
    platform: 'neutral',
    mainFields: ['module', 'main'],
    format: 'esm',
    write: false,
    metafile: true,
  };
  const native = await build({ ...options, conditions: ['forgeax-native'] });
  const inputs = Object.keys(native.metafile.inputs);
  assert.ok(inputs.some((path) => path.endsWith('/dist/basis-native-factory.mjs')));
  assert.ok(!inputs.some((path) => path.endsWith('/basis-browser.mjs')));
  assert.doesNotMatch(
    native.outputFiles[0].text,
    /node:module|node:fs|node:path|__vite-browser-external/,
  );
  const browser = await build(options);
  assert.ok(
    Object.keys(browser.metafile.inputs).some((path) => path.endsWith('/basis-browser.mjs')),
  );
});
