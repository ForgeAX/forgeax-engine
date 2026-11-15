import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { ensureBuild } from '../../bench/pixel-parity.mjs';
import { dispatchBench } from '../run-all.mjs';

test('default bench dispatch uses the owning lifecycle CLI with direct argv and retains failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax metric cli '));
  const entry = join(root, 'pnpm.cjs');
  const previous = process.env.npm_execpath;
  try {
    process.env.npm_execpath = entry;
    writeFileSync(
      entry,
      `const fs=require('node:fs');fs.writeFileSync('argv.json',JSON.stringify(process.argv.slice(2)));fs.writeFileSync('bench-result.json',JSON.stringify({files:[{groups:[{benchmarks:[{median:0.001}]}]}]}));`,
    );
    const result = dispatchBench('engine-water', root, { enabled: true });
    assert.equal(result.status, 'ok');
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'argv.json'))), [
      '-F',
      '@forgeax/engine-water',
      'bench:json',
    ]);
    rmSync(join(root, 'bench-result.json'));
    writeFileSync(entry, `process.stderr.write('owning producer failed');process.exitCode=7;`);
    const failed = dispatchBench('engine-water', root, { enabled: true });
    assert.equal(failed.status, 'unavailable');
    assert.equal(failed.details.spawnExit, 7);
    assert.equal(existsSync(join(root, 'bench-result.json')), false);
  } finally {
    if (previous === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('parity builds both fixture targets through Vite JavaScript when POSIX shims are present', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax parity cli '));
  try {
    for (const name of ['forgeax', 'urp-vs-hdrp']) {
      const appRoot = join(root, 'apps', 'parity', name);
      mkdirSync(join(appRoot, 'node_modules/.bin'), { recursive: true });
      mkdirSync(join(appRoot, 'node_modules/vite/bin'), { recursive: true });
      writeFileSync(join(appRoot, 'node_modules/.bin/vite'), '#!/bin/sh\nexit 91\n');
      writeFileSync(
        join(appRoot, 'node_modules/vite/bin/vite.js'),
        `require('node:fs').writeFileSync('argv.json',JSON.stringify(process.argv.slice(2)));`,
      );
      await ensureBuild({ root: `apps/parity/${name}`, filter: `@forgeax/parity-${name}` }, root);
      assert.deepEqual(JSON.parse(readFileSync(join(appRoot, 'argv.json'))), ['build']);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parity retains the pinned lifecycle fallback and producer or native startup failures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax parity fallback '));
  const previous = process.env.npm_execpath;
  try {
    const entry = join(root, 'pnpm.cjs');
    process.env.npm_execpath = entry;
    writeFileSync(
      entry,
      `require('node:fs').writeFileSync('argv.json',JSON.stringify(process.argv.slice(2)));`,
    );
    const target = { root: 'apps/parity/absent', filter: '@forgeax/parity-urp-vs-hdrp' };
    await ensureBuild(target, root);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'argv.json'))), [
      '--filter',
      '@forgeax/parity-urp-vs-hdrp',
      'build',
    ]);
    writeFileSync(entry, 'process.exitCode=7;');
    await assert.rejects(ensureBuild(target, root), /build @forgeax\/parity-urp-vs-hdrp exit 7/);
    process.env.npm_execpath = join(root, 'missing', 'pnpm.exe');
    await assert.rejects(ensureBuild(target, root), (error) => error.cause?.code === 'ENOENT');
  } finally {
    if (previous === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('the original VFX CLI enters its producer and propagates a failed child without GPU work', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax vfx cli '));
  try {
    const entry = join(root, 'pnpm.cjs');
    writeFileSync(
      entry,
      `require('node:fs').writeFileSync('argv.json',JSON.stringify(process.argv.slice(2)));process.stderr.write('controlled producer failure');process.exitCode=7;`,
    );
    const result = spawnSync(process.execPath, [resolve('scripts/bench/vfx-batch-b.mjs')], {
      cwd: root,
      env: { ...process.env, npm_execpath: entry },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /controlled producer failure/);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'argv.json'))), [
      '--filter',
      '@forgeax/hello-boss-lightning',
      'smoke',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
