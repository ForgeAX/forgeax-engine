import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  reusableSharedShader,
  sharedShaderInputFingerprint,
  sharedShaderReceipt,
} from '../lib/shared-build-cache.mjs';

test('transferred shaders bind source, compiler, WASM, lockfile, profile and exact output bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-shared-shader-'));
  const copy = mkdtempSync(join(tmpdir(), 'forgeax-shared-shader-copy-'));
  const alias = `${root}-alias`;
  const inputs = [
    'package.json',
    'packages/vite-plugin-shader/package.json',
    'packages/compiler/package.json',
    'packages/compiler/dist/index.js',
    'packages/vfx-render/package.json',
    'packages/wgpu-wasm/pkg/compiler.wasm',
    'packages/shader/src/main.wgsl',
    'packages/vfx-render/src/shaders/main.wgsl',
    'pnpm-lock.yaml',
    'scripts/build-shared-inputs.mjs',
    'scripts/ci/build-shared-app-inputs.mjs',
    'scripts/lib/shared-build-cache.mjs',
    'scripts/build-task-cache.mjs',
  ];
  const write = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value);
  };
  try {
    const originals = new Map(
      inputs.map((input) => [input, input.endsWith('package.json') ? '{}' : 'original']),
    );
    originals.set(
      'packages/vite-plugin-shader/package.json',
      '{"name":"@forgeax/engine-vite-plugin-shader","dependencies":{"@fixture/compiler":"workspace:*","@forgeax/engine-vfx-render":"workspace:*"}}',
    );
    originals.set('packages/compiler/package.json', '{"name":"@fixture/compiler"}');
    originals.set(
      'packages/vfx-render/package.json',
      '{"name":"@forgeax/engine-vfx-render","dependencies":{"@fixture/render":"workspace:*"}}',
    );
    for (const [input, contents] of originals) write(input, contents);
    write('packages/render/package.json', '{"name":"@fixture/render"}');
    write('packages/render/dist/index.js', 'runtime render implementation');
    write('packages/vfx-render/dist/index.js', 'runtime VFX implementation');
    const profile = { pointShadows: true, hdrpSsao: true };
    const fingerprint = () => sharedShaderInputFingerprint(root, profile);
    const expected = fingerprint();
    write('packages/render/dist/index.js', 'changed runtime render implementation');
    write('packages/vfx-render/dist/index.js', 'changed runtime VFX implementation');
    assert.equal(
      fingerprint(),
      expected,
      'the package shader-source reader never executes VFX or its Render dependency',
    );
    write(
      'packages/compiler/package.json',
      '{"name":"@fixture/compiler","dependencies":{"@fixture/render":"workspace:*"}}',
    );
    const compilerWithRender = fingerprint();
    write('packages/render/dist/index.js', 'changed compiler dependency implementation');
    assert.notEqual(
      fingerprint(),
      compilerWithRender,
      'a real compiler dependency remains authoritative even when also used by VFX',
    );
    write('packages/compiler/package.json', originals.get('packages/compiler/package.json'));
    assert.equal(fingerprint(), expected);
    write(
      'packages/compiler/package.json',
      '{"name":"@fixture/compiler","dependencies":{"@forgeax/engine-vfx-render":"workspace:*"}}',
    );
    const compilerWithVfx = fingerprint();
    write('packages/vfx-render/dist/index.js', 'changed executable VFX compiler dependency');
    assert.notEqual(fingerprint(), compilerWithVfx, 'only the source-reader edge is excluded');
    const compilerWithChangedVfx = fingerprint();
    write('packages/render/dist/index.js', 'changed transitive VFX compiler dependency');
    assert.notEqual(
      fingerprint(),
      compilerWithChangedVfx,
      'executable VFX dependencies are retained',
    );
    write('packages/compiler/package.json', originals.get('packages/compiler/package.json'));
    assert.equal(fingerprint(), expected);
    const shader = 'shared-app-inputs/shaders/manifest.json';
    write(shader, '{"entries":["original"]}');
    const manifestPath = join(root, 'shared-app-inputs/manifest.json');
    const manifest = {
      schemaVersion: 1,
      producer: 'shared-app-inputs',
      payload: { engineShaderManifest: shader },
      shaderBuild: sharedShaderReceipt(root, join(root, shader), expected),
    };
    const publish = (value) => writeFileSync(manifestPath, JSON.stringify(value));
    publish(manifest);
    for (const producer of ['repo-build-inputs', 'shared-app-inputs']) {
      publish({ ...manifest, producer });
      assert.equal(reusableSharedShader(root, manifestPath, expected), join(root, shader));
    }
    write('shared-app-inputs/production-facts.json', '{"engineShaderCompileCount":0}');
    assert.equal(reusableSharedShader(root, manifestPath, expected), join(root, shader));
    symlinkSync(root, alias, 'dir');
    assert.equal(
      reusableSharedShader(root, join(alias, 'shared-app-inputs/manifest.json'), expected),
      join(root, shader),
      'a directory alias names the same shader payload',
    );
    cpSync(root, copy, { recursive: true });
    assert.equal(sharedShaderInputFingerprint(copy, profile), expected);
    assert.equal(
      reusableSharedShader(copy, join(copy, 'shared-app-inputs/manifest.json'), expected),
      join(copy, shader),
    );
    for (const input of inputs) {
      write(input, input.endsWith('package.json') ? `${originals.get(input)} ` : 'modified');
      assert.notEqual(fingerprint(), expected, input);
      assert.equal(reusableSharedShader(root, manifestPath, fingerprint()), null, input);
      write(input, originals.get(input));
    }
    assert.equal(
      reusableSharedShader(
        root,
        manifestPath,
        sharedShaderInputFingerprint(root, { ...profile, pointShadows: false }),
      ),
      null,
    );
    write('packages/unrelated/package.json', '{"name":"@fixture/unrelated"}');
    write('packages/unrelated/dist/index.js', 'unrelated output');
    assert.equal(fingerprint(), expected, 'other package builds do not invalidate compiler inputs');
    for (const file of ['.gitignore', 'README.md', 'wgpu_wasm.d.ts', 'provenance.json']) {
      write(`packages/wgpu-wasm/pkg/${file}`, '*');
      assert.equal(
        fingerprint(),
        expected,
        `${file} is packaging metadata, not executable compiler input`,
      );
      rmSync(join(root, 'packages/wgpu-wasm/pkg', file));
      assert.equal(fingerprint(), expected, 'artifact omission preserves executable identity');
    }
    write('packages/compiler/pkg/runtime-only.wasm', 'not a shader compiler input');
    assert.equal(fingerprint(), expected);
    write('packages/vite-plugin-shader/dist/engine-inputs/point-ssao/manifest.json', 'generated');
    assert.equal(fingerprint(), expected, 'publishing output does not invalidate compiler inputs');
    write(shader, '{"entries":["modified"]}');
    assert.equal(reusableSharedShader(root, manifestPath, expected), null);
    rmSync(join(root, shader));
    assert.equal(reusableSharedShader(root, manifestPath, expected), null);
    publish({ ...manifest, shaderBuild: undefined });
    const misses = [];
    assert.equal(
      reusableSharedShader(root, manifestPath, expected, (reason) => misses.push(reason)),
      null,
    );
    assert.match(misses[0], /missing shaderBuild receipt/);
    publish({ ...manifest, payload: { engineShaderManifest: 'pnpm-lock.yaml' } });
    assert.equal(reusableSharedShader(root, manifestPath, expected), null);
    writeFileSync(manifestPath, '{');
    assert.equal(reusableSharedShader(root, manifestPath, expected), null);
    rmSync(manifestPath);
    assert.equal(reusableSharedShader(root, manifestPath, expected), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(copy, { recursive: true, force: true });
    rmSync(alias, { force: true });
  }
});
