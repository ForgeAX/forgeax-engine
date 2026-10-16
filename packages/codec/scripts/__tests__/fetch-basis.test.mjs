import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
test('offline Basis acquisition uses only an explicitly supplied pinned clone', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-basis-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = resolve(root, 'source');
  const target = resolve(root, 'codec');
  await mkdir(source);
  await mkdir(resolve(target, 'scripts'), { recursive: true });
  for (const path of ['transcoder/basisu_transcoder.cpp', 'encoder/basisu_comp.cpp', 'zstd/source.c', 'webgl/transcoder/wrapper.cpp', 'LICENSE']) {
    await mkdir(resolve(source, path, '..'), { recursive: true });
    await writeFile(resolve(source, path), 'pinned upstream data\n');
  }
  await exec('git', ['init', '-q'], { cwd: source });
  await exec('git', ['add', '.'], { cwd: source });
  await exec('git', ['-c', 'user.name=Basis Test', '-c', 'user.email=basis@example.invalid', 'commit', '-qm', 'upstream'], { cwd: source });
  const pin = (await exec('git', ['rev-parse', 'HEAD'], { cwd: source })).stdout.trim();
  const original = await readFile(new URL('../fetch-basis.mjs', import.meta.url), 'utf8');
  await writeFile(resolve(target, 'scripts/fetch-basis.mjs'), original.replace(/commit: '[a-f0-9]{40}'/, `commit: '${pin}'`));
  const invoke = () => exec(process.execPath, ['--input-type=module', '-e', "globalThis.fetch = () => { throw new Error('unexpected network'); }; await import('./scripts/fetch-basis.mjs');"], { cwd: target, env: { ...process.env, FORGEAX_BASIS_SOURCE_DIR: source } });
  await invoke();
  assert.equal(await readFile(resolve(target, 'vendor/basis/.basis-pin'), 'utf8'), `${pin}\n`);
  assert.equal(await readFile(resolve(target, 'vendor/basis/LICENSE'), 'utf8'), 'pinned upstream data\n');
  await rm(resolve(target, 'vendor'), { recursive: true });
  await writeFile(resolve(source, 'transcoder/basisu_transcoder.cpp'), 'dirty source');
  await assert.rejects(invoke(), /Command failed/);
  await writeFile(resolve(source, 'other'), 'new revision');
  await exec('git', ['add', '.'], { cwd: source });
  await exec('git', ['-c', 'user.name=Basis Test', '-c', 'user.email=basis@example.invalid', 'commit', '-qm', 'wrong pin'], { cwd: source });
  await assert.rejects(invoke(), (error) => {
    assert.match(error.stderr, /Invalid pinned basis source/);
    assert.doesNotMatch(error.stderr, /unexpected network/);
    return true;
  });
});
