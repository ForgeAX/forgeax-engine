import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import '../../config/__tests__/tsup-base.test.mjs';

const script = resolve('scripts/build.mjs');

test('build fails fast with one actionable line when the modeling submodule is missing', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-build-source-modules-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [script, '--engine'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /build-source-module-missing: modeling submodule missing: run bun fx setup/,
  );
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|Cannot find/);
});

test('compiled shader publication has its own command outside the Engine build', () => {
  const result = spawnSync(process.execPath, [script, '--engine', '--compiled-shaders'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /prepare-shader-release-inputs\.mjs --build/);
  assert.doesNotMatch(result.stdout, /\[build\]|\[shared-build\]/);
  assert.doesNotMatch(readFileSync(script, 'utf8'), /FORGEAX_SDK_SHADER_INPUTS/);
});

test('the independent no-View build exercises native shaders from Engine packages alone', () => {
  const verifier = readFileSync(resolve('scripts/ci/verify-engine-without-view.mjs'), 'utf8');
  assert.match(verifier, /\['build:engine', \['build:engine'\]\]/);
  assert.doesNotMatch(verifier, /--compiled-shaders|sharedInputsRoot/);
  assert.match(verifier, /'packages\/engine\/dist\/bin\/forgeax\.mjs', '--help'/);
  assert.match(verifier, /'without-view-probe\.mjs'/);
  assert.match(verifier, /resolveProgramTemplate\(pbr\.program,pbr\.selection\)/);
});
