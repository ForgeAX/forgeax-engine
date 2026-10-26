import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { createSdkVerifierProcess, readSdkProjectDocument } from '../verify-sdk-process.mjs';

const packageManager = 'pnpm@11.7.0';
const literalArgs = ['quote"literal', 'back\\slash', 'ampersand&', 'percent%'];

test('verifier process preserves Windows argv, output, and pinned long children', async (t) => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'sdk verifier ')));
  const cwd = resolve(root, '\u7279\u6b8a \u4e2d\u6587 \u7a7a\u683c 50%');
  await mkdir(cwd);
  const script = resolve(cwd, 'child.mjs');
  await writeFile(
    script,
    `process.stdout.write('stdout-progress\\n');
process.stderr.write('stderr-progress\\n');
await new Promise((done) => setTimeout(done, 250));
process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env: process.env.VERIFIER_FIXTURE }) + '\\n');\n`,
  );
  t.after(() => rm(root, { force: true, recursive: true }));
  const runner = createSdkVerifierProcess(packageManager);
  const writes = [];
  let child;
  let progressBeforeExit = false;
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    const text = String(chunk);
    writes.push(text);
    if (text.includes('stderr-progress') && child?.exitCode === null) progressBeforeExit = true;
    return true;
  };
  try {
    const pending = runner.execFileAsync(process.execPath, [script, ...literalArgs], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, VERIFIER_FIXTURE: 'env value & 50%' },
      streamOutput: true,
    });
    child = pending.child;
    const result = await pending;
    const value = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assert.deepEqual(value, { args: literalArgs, cwd, env: 'env value & 50%' });
    assert.match(result.stderr, /stderr-progress/);
    assert.ok(writes.some((text) => text.includes('stdout-progress')));
    assert.ok(writes.some((text) => text.includes('stderr-progress')));
    assert.equal(progressBeforeExit, true);
  } finally {
    process.stderr.write = originalWrite;
  }
  await assert.rejects(
    runner.execFileAsync(
      process.execPath,
      ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(23)'],
      { encoding: 'utf8' },
    ),
    (error) => error.code === 23 && error.stdout === 'out' && error.stderr === 'err',
  );
  const missing = runner.spawn('sdk-verifier-missing-command', [], { stdio: 'ignore' });
  const [spawnError] = await once(missing, 'error');
  assert.equal(spawnError.code, 'ENOENT');
  if (process.platform !== 'win32') return;
  await writeFile(
    resolve(cwd, 'package.json'),
    JSON.stringify({ name: 'fixture', packageManager }),
  );
  const options = { cwd, env: { ...process.env, VERIFIER_FIXTURE: 'pinned' }, encoding: 'utf8' };
  const direct = await runner.execFileAsync('corepack', [packageManager, '--version'], options);
  const pnpm = await runner.execFileAsync('pnpm', ['--version'], options);
  assert.equal(direct.stdout.trim(), '11.7.0');
  assert.equal(pnpm.stdout.trim(), '11.7.0');
  const longChild = runner.spawn('pnpm', ['exec', 'node', script, ...literalArgs], {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  longChild.stdout.on('data', (chunk) => (stdout += chunk));
  longChild.stderr.on('data', (chunk) => (stderr += chunk));
  const [code, signal] = await once(longChild, 'close');
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.match(stdout, /stdout-progress/);
  assert.match(stderr, /stderr-progress/);
  const value = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  assert.deepEqual(value.args, literalArgs);
  assert.equal(value.cwd, cwd);
  assert.equal(value.env, 'pinned');
});

test('candidate document reads share the public Codec for plain and compressed builds', async (t) => {
  const { compressZstd } = await import('../../../packages/codec/dist/encode/index.mjs');
  const project = await realpath(await mkdtemp(resolve(tmpdir(), 'sdk catalog ')));
  t.after(() => rm(project, { force: true, recursive: true }));
  const installed = resolve(project, 'node_modules/@forgeax');
  await mkdir(installed, { recursive: true });
  await symlink(
    resolve(import.meta.dirname, '../../../packages/engine'),
    resolve(installed, 'engine'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const rows = [{ guid: '11111111-1111-4111-8111-111111111111', kind: 'mesh' }];
  const scene = {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    assets: [{ guid: rows[0].guid, kind: 'scene', payload: { entities: [] } }],
  };
  const runner = createSdkVerifierProcess(packageManager);
  for (const [kind, value] of [
    ['catalog', rows],
    ['json', scene],
  ]) {
    const plain = Buffer.from(JSON.stringify(value));
    const compressed = await compressZstd(plain);
    assert.equal(compressed.ok, true);
    if (!compressed.ok) throw compressed.error;
    for (const bytes of [plain, compressed.value]) {
      const file = resolve(project, kind === 'catalog' ? 'pack-index.json' : 'scene.pack.json');
      await writeFile(file, bytes);
      assert.deepEqual(
        await readSdkProjectDocument(runner.execFileAsync, project, file, kind),
        value,
      );
    }
  }
});
