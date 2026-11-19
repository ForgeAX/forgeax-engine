import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pnpmCommand } from '../../lib/pnpm-command.mjs';
import { runBrowserCommand } from '../run-browser-gate-with-retry.mjs';

const ENGINE_ROOT = resolve(import.meta.dirname, '../..', '..');

async function runPackageBuild(stage) {
  // Every build mode executes the same canonical-kit staging recovery. The
  // prepared workspace already has full build evidence; one real leaf exercises
  // that path without repeating every package compilation.
  const [manager, ...prefix] = pnpmCommand();
  return runBrowserCommand(
    [manager, ...prefix, 'build:packages', '--target=@forgeax/engine-types'],
    {
      cwd: ENGINE_ROOT,
      env: {
        ...process.env,
        FORGEAX_SKIP_HARNESS_SYNC: '1',
        FORGEAX_CANONICAL_KIT_OUTPUT: stage,
        FORGEAX_BUILD_NO_TASK_CACHE: '0',
      },
      label: 'canonical kit cache recovery',
      timeoutMs: 300000,
    },
  );
}

test('unknown package targets fail before a package runner can start', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/build.mjs', '--packages-only', '--target=unknown-cache-fixture'],
    {
      cwd: ENGINE_ROOT,
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, FORGEAX_PACKAGE_BUILD_RUNNER: 'must-not-start' },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown build target: unknown-cache-fixture/);
});

test('Engine builds reject partial package selection', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/build.mjs', '--engine', '--target=@forgeax/engine-types'],
    {
      cwd: ENGINE_ROOT,
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, FORGEAX_PACKAGE_BUILD_RUNNER: 'must-not-start' },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /package targets require --packages-only/);
});

function packageFacts() {
  const facts = JSON.parse(
    readFileSync(join(ENGINE_ROOT, 'node_modules/.cache/forgeax-build/package-facts.json'), 'utf8'),
  ).packages;
  assert.deepEqual(
    facts.results.map((item) => item.name),
    ['@forgeax/engine-types'],
  );
  return facts;
}

test('engine build recovers canonical-kit staging after package cache hits', async () => {
  const stage = mkdtempSync(join(tmpdir(), 'forgeax-canonical-kit-stage-'));
  try {
    const first = await runPackageBuild(stage);
    assert.equal(first.status, 0, `first build failed\n${first.output}`);
    packageFacts();
    const source = readFileSync(join(stage, 'sky.hdr'));
    const meta = readFileSync(join(stage, 'sky.hdr.meta.json'));
    assert.ok(source.byteLength > 0);
    assert.ok(meta.byteLength > 0);

    // Exercise missing and stale staged inputs in the same cached build.
    unlinkSync(join(stage, 'sky.hdr'));
    writeFileSync(join(stage, 'sky.hdr.meta.json'), Buffer.from('{}'));
    const second = await runPackageBuild(stage);
    assert.equal(second.status, 0, `recovery build failed\n${second.output}`);
    assert.equal(packageFacts().skipped, 1);
    assert.deepEqual(readFileSync(join(stage, 'sky.hdr')), source);
    assert.deepEqual(readFileSync(join(stage, 'sky.hdr.meta.json')), meta);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});
