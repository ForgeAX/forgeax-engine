import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hashWgpuSource } from '../content-key.mjs';

function git(root, ...args) {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
}

test('source fingerprint is stable across autocrlf checkouts and SDK expansion', async t => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-wgpu-source-git-key-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const expanded = await mkdtemp(join(tmpdir(), 'forgeax-wgpu-source-expanded-key-'));
  t.after(() => rm(expanded, { recursive: true, force: true }));
  git(root, 'init', '--quiet');
  git(root, 'config', 'user.name', 'ForgeaX test');
  git(root, 'config', 'user.email', 'forgeax-test@example.invalid');
  git(root, 'config', 'core.autocrlf', 'false');
  await writeFile(join(root, '.gitattributes'), '* text=auto\n');
  await writeFile(join(root, 'source.rs'), 'first line\nsecond line\n');
  await writeFile(join(expanded, '.gitattributes'), '* text=auto\n');
  await writeFile(join(expanded, 'source.rs'), 'first line\nsecond line\n');
  git(root, 'add', '.gitattributes', 'source.rs');
  git(root, 'commit', '--quiet', '-m', 'source fixture');

  const fingerprint = await hashWgpuSource(root);
  assert.equal(await hashWgpuSource(expanded), fingerprint);
  git(root, 'config', 'core.autocrlf', 'true');
  await writeFile(join(root, 'source.rs'), 'first line\r\nsecond line\r\n');
  await writeFile(join(expanded, 'source.rs'), await readFile(join(root, 'source.rs')));

  assert.equal((await readFile(join(root, 'source.rs'), 'utf8')).includes('\r\n'), true);
  assert.equal(await hashWgpuSource(root), fingerprint);
  assert.equal(await hashWgpuSource(expanded), fingerprint);
  await writeFile(join(root, 'source.rs'), 'first line\r\nchanged line\r\n');
  await writeFile(join(expanded, 'source.rs'), await readFile(join(root, 'source.rs')));
  assert.notEqual(await hashWgpuSource(root), fingerprint);
  assert.notEqual(await hashWgpuSource(expanded), fingerprint);
});

test('source fingerprint survives SDK expansion and changes with maintained code', async t => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-wgpu-source-key-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'source.rs'), 'original');
  const original = await hashWgpuSource(root);
  await writeFile(join(root, '.git'), 'gitdir: private contributor metadata');
  await mkdir(join(root, 'target'));
  await writeFile(join(root, 'target/build-output'), 'disposable');
  assert.equal(await hashWgpuSource(root), original);
  await writeFile(join(root, 'source.rs'), 'repaired');
  assert.notEqual(await hashWgpuSource(root), original);
});
