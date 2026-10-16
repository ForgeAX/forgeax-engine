import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { assertPortableRustArtifact } from '../../lib/rust-build-paths.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const execute = promisify(execFile);
const require = createRequire(resolve(root, 'package.json'));
const { build } = createRequire(require.resolve('tsup'))('esbuild');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

for (const dimension of ['2d', '3d']) {
  test(`native Rapier ${dimension}: actual Host retry, singleton and 60-step collision`, async () => {
    const { stdout } = await execute(
      process.execPath,
      [
        '--conditions=forgeax-native',
        fileURLToPath(new URL('./fixtures/rapier-native-host.mjs', import.meta.url)),
        dimension,
      ],
      { cwd: root, timeout: 30_000 },
    );
    const evidence = JSON.parse(stdout.trim());
    assert.equal(evidence.frames, 60);
    assert.equal(evidence.instantiations, 1);
  });

  test(`native Rapier ${dimension}: published identity closes over binary, glue and producer`, async () => {
    const owner = resolve(root, `packages/physics-rapier${dimension}`);
    const provenance = JSON.parse(await readFile(resolve(owner, 'pkg/provenance.json'), 'utf8'));
    assert.deepEqual(
      provenance.source,
      JSON.parse(
        await readFile(resolve(root, 'packages/physics-rapier3d/scripts/source.json'), 'utf8'),
      ),
    );
    assert.equal(provenance.toolchain.wasmBindgen, '0.2.121');
    assert.equal(provenance.toolchain.rustVersion.split(' ')[1], provenance.source.rust);
    assert.equal(provenance.toolchain.wasmPackVersion, `wasm-pack ${provenance.source.wasmPack}`);
    assert.equal(
      provenance.toolchain.esbuildVersion,
      createRequire(resolve(root, 'packages/physics-rapier3d/package.json'))('esbuild').version,
    );
    assert.equal(provenance.contentKey, sha256(JSON.stringify(provenance.inputHashes)));
    assert.equal(
      Object.keys(provenance.inputHashes).some((path) => path.startsWith('patches/')),
      dimension === '3d',
    );
    for (const [path, hash] of Object.entries(provenance.inputHashes))
      assert.equal(
        sha256(await readFile(resolve(root, 'packages/physics-rapier3d', path))),
        hash,
        path,
      );
    assert.deepEqual(Object.keys(provenance.artifacts).sort(), [
      'LICENSE',
      'rapier-native.d.mts',
      'rapier-native.mjs',
      'rapier.d.mts',
      'rapier.mjs',
      'rapier.wasm',
    ]);
    for (const [path, hash] of Object.entries(provenance.artifacts))
      assert.equal(sha256(await readFile(resolve(owner, 'pkg', path))), hash, path);
    const { artifact } = await import(pathToFileURL(resolve(owner, 'pkg/rapier-native.mjs')).href);
    const bytes = await readFile(resolve(owner, 'pkg/rapier.wasm'));
    assertPortableRustArtifact(bytes);
    assert.deepEqual(artifact, { bytes: bytes.length, sha256: sha256(bytes) });
  });

  test(`native Rapier ${dimension}: bundler selects native glue without compat or base64`, async () => {
    const owner = resolve(root, `packages/physics-rapier${dimension}`);
    const packageName = `@forgeax/engine-physics-rapier${dimension}`;
    const upper = dimension.toUpperCase();
    const options = {
      stdin: {
        contents: `export { loadRapier${upper} } from '${packageName}';\nexport { initializeNativeRapier${upper} } from '${packageName}/native';`,
        resolveDir: owner,
        loader: 'js',
      },
      bundle: true,
      platform: 'browser',
      format: 'esm',
      target: 'es2022',
      write: false,
      metafile: true,
      mainFields: ['browser', 'module', 'main'],
      logLevel: 'silent',
    };
    const result = await build({ ...options, conditions: ['forgeax-native'] });
    const inputs = Object.keys(result.metafile.inputs);
    assert.ok(inputs.some((path) => path.endsWith('/dist/native.mjs')));
    assert.ok(inputs.some((path) => path.endsWith('/pkg/rapier-native.mjs')));
    assert.ok(
      !inputs.some((path) => path.includes('-compat') || path.endsWith('/wasm-browser.mjs')),
    );
    assert.doesNotMatch(result.outputFiles[0].text, /\bWebAssembly\b|\batob\b|AGFzbQ/);
    const browser = await build({ ...options, conditions: [] });
    assert.ok(
      Object.keys(browser.metafile.inputs).some((path) =>
        path.endsWith(`/physics-rapier${dimension}/pkg/rapier.mjs`),
      ),
      'default browser entry must retain self-contained loading of the same backend',
    );
  });
}
