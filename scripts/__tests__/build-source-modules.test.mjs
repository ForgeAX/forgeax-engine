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

test('BASE source handoff rejects incomplete or incompatible build options before any producer starts', () => {
  for (const args of [
    ['--engine', '--base-shader-input-root'],
    ['--engine', '--base-shader-input-root', '.', '--source-revision', 'invalid'],
    ['--engine', '--source-revision', 'a'.repeat(40)],
    ['--packages-only', '--base-shader-input-root', '.', '--source-revision', 'a'.repeat(40)],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /BASE shader inputs require|--base-shader-input-root requires/);
    assert.doesNotMatch(result.stdout, /\[build\]|\[shared-build\]/);
  }
});

test('BASE source handoff restores after package rebuild and retains POINT source production and API probes', () => {
  const build = readFileSync(script, 'utf8');
  const restore = build.indexOf('restoreCoreBaseShader(root, resolve(baseShaderInputRoot)');
  assert.ok(restore > build.indexOf("await runStage(\n  'packages'"));
  assert.ok(restore < build.indexOf("await runStage('producer'"));
  assert.ok(restore < build.indexOf("await runStage('shader-profiles'"));
  const verifier = readFileSync(resolve('scripts/ci/verify-engine-without-view.mjs'), 'utf8');
  assert.match(verifier, /spawnSync\('git', \['rev-parse', 'HEAD'\]/);
  assert.match(verifier, /'--base-shader-input-root', root/);
  assert.match(verifier, /'--source-revision', sourceRevision/);
  assert.match(verifier, /'packages\/engine\/dist\/bin\/forgeax\.mjs', '--help'/);
  assert.match(verifier, /'without-view-probe\.mjs'/);
});
