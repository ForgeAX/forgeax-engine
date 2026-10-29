import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readBrowserCosts, summarizeBrowserCosts } from '../browser-cost-report.mjs';

const receipt = (file, duration = 1000) => ({
  file,
  state: 'passed',
  diagnostic: { duration },
  cases: [{ name: 'actual case', state: 'passed', durationMs: duration }],
  work: null,
});
const output = (rows) => rows.map((row) => `[browser-cost] ${JSON.stringify(row)}`).join('\n');

test('cost receipts cover the exact selected files and fail closed on incomplete data', () => {
  assert.equal(readBrowserCosts(output([receipt('a'), receipt('b')]), ['a', 'b']).length, 2);
  assert.throws(() => readBrowserCosts('', ['a']), /Missing/);
  assert.throws(() => readBrowserCosts(output([receipt('a'), receipt('a')]), ['a']), /duplicate/);
  assert.throws(() => readBrowserCosts(output([receipt('other')]), ['a']), /Unexpected/);
  assert.throws(
    () => readBrowserCosts(output([{ ...receipt('a'), diagnostic: {} }]), ['a']),
    /Incomplete/,
  );
  assert.throws(() => readBrowserCosts('[browser-cost] broken', ['a']), /JSON/);
  assert.throws(
    () => readBrowserCosts(output([{ ...receipt('a'), state: 'pending' }]), ['a']),
    /Incomplete/,
  );
  assert.throws(
    () => readBrowserCosts(output([{ ...receipt('a'), work: { available: true } }]), ['a']),
    /Incomplete/,
  );
});

test('all owners remain visible while queue time and unobserved Worker work are explicit', () => {
  const slow = receipt('slow', 4000);
  slow.diagnostic = {
    duration: 4000,
    collectDuration: 2000,
    setupDuration: 100,
    prepareDuration: 10000,
  };
  const summary = summarizeBrowserCosts(
    [{ elapsedMs: 6000, files: [receipt('fast', 1000), slow] }],
    { shard: 2, complete: true, summary: '' },
  );
  assert.ok(summary.indexOf('| slow |') < summary.indexOf('| fast |'));
  assert.match(summary, /Child execution: 6.0s/);
  assert.match(summary, /remainder: 1.0s/);
  assert.match(summary, /Worker and external Playwright devices are not included/);
  assert.match(summary, /unobserved/);
  assert.match(summary, /\| slow \| 4\.00 \| 2\.10 \|/);
});

test('the pinned real Vitest reporter receives module timings and root-hook metadata', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'forgeax-browser-cost-reporter-')));
  const fixture = join(directory, 'actual.test.mjs');
  const config = join(directory, 'vitest.config.mjs');
  const vitest = import.meta.resolve('vitest');
  const cli = fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url));
  const reporter = fileURLToPath(new URL('../browser-cost-reporter.mjs', import.meta.url));
  writeFileSync(
    fixture,
    `import { it, expect, afterAll } from ${JSON.stringify(vitest)};
    afterAll(({}, suite) => { const file = 'filepath' in suite ? suite : suite.file; file.meta.browserWork = { realm: 'browser-main', available: true, deviceRequests: 0, shaderModules: 0, pipelines: 0, readbackMaps: 0, submissions: 0 }; });
    it('retains the real reporter API', () => expect(3).toBe(3));`,
  );
  writeFileSync(
    config,
    `export default { root: ${JSON.stringify(directory)}, test: { include: ['actual.test.mjs'], environment: 'node', maxWorkers: 1, fileParallelism: false } };`,
  );
  try {
    const child = spawnSync(
      process.execPath,
      [cli, 'run', '--config', config, '--reporter=default', `--reporter=${reporter}`],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, GITHUB_STEP_SUMMARY: '' },
      },
    );
    assert.equal(child.status, 0, child.stdout + child.stderr);
    const file = relative(process.cwd(), fixture).replaceAll('\\', '/');
    const rows = readBrowserCosts(child.stdout, [file]);
    assert.equal(rows[0].cases[0].state, 'passed');
    assert.equal(rows[0].work.deviceRequests, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
