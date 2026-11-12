import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Reporter, {
  createModelingFilePhaseStream,
  modelingFilePhasePrefix,
} from '../modeling-file-phase-reporter.mjs';
import { buildGroupArgs, runChild } from '../run-split-vitest-coverage.mjs';

const progress = { groupIndex: 6, total: 9, label: 'modeling' };
const parse = (line, prefix) => JSON.parse(line.slice(prefix.length));

test('public file lifecycle records are bounded and own no waiting handles', (t) => {
  const lines = [];
  t.mock.method(process.stderr, 'write', (line) => {
    lines.push(String(line));
    return true;
  });
  const reporter = new Reporter();
  const module = { relativeModuleId: 'examples/joint-boot/boot.unit.test.ts' };
  reporter.onTestModuleQueued(module);
  reporter.onTestModuleCollected(module);
  reporter.onTestModuleStart(module);
  reporter.onTestModuleEnd(module);
  reporter.onTestRunEnd();
  assert.deepEqual(
    lines.map((s) => parse(s, modelingFilePhasePrefix).phase),
    ['queued', 'collected', 'start', 'end', 'run-end'],
  );
  assert.equal(parse(lines[0], modelingFilePhasePrefix).file, module.relativeModuleId);
  assert.ok(lines.every((s) => s.length < 1024));
  assert.ok(lines.every((s) => parse(s, modelingFilePhasePrefix).pid === process.pid));
  reporter.onTestModuleQueued({ relativeModuleId: '../escape.test.ts' });
  assert.equal(lines.length, 5);
  for (let i = 0; i < 4100; i++) reporter.onTestModuleQueued(module);
  assert.equal(lines.length, 4096);
});

test('fragmented prefixes stream before child close while complete buffers and exit remain unchanged', {
  timeout: 5000,
}, async (t) => {
  const live = '[vitest-modeling-file-phase-live] ';
  const lines = [];
  let childClosed = false;
  let sawLive;
  const ready = new Promise((resolve) => {
    sawLive = resolve;
  });
  t.mock.method(process.stderr, 'write', (line) => {
    if (String(line).startsWith(live)) {
      lines.push(parse(String(line), live));
      sawLive();
    }
    return true;
  });
  const record = `${modelingFilePhasePrefix}{"phase":"queued","file":"a.test.ts"}\n`;
  const resultPromise = runChild(
    [
      '-e',
      `process.stderr.write(${JSON.stringify(record.slice(0, 13))}); setTimeout(()=>{process.stderr.write(${JSON.stringify(record.slice(13))});setTimeout(()=>{process.stdout.write('original stdout');process.exitCode=7;},50);},10);`,
    ],
    { progress, filePhases: true },
  ).then((r) => {
    childClosed = true;
    return r;
  });
  await ready;
  assert.equal(childClosed, false);
  const result = await resultPromise;
  assert.equal(result.status, 7);
  assert.equal(result.signal, null);
  assert.equal(result.error, null);
  assert.equal(Buffer.concat(result.stderr).toString(), record);
  assert.equal(Buffer.concat(result.stdout).toString(), 'original stdout');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0].record).phase, 'queued');
  assert.equal(lines[0].groupIndex, 6);
  const stream = createModelingFilePhaseStream(progress);
  stream.collect(Buffer.from('x'.repeat(2000)));
  stream.collect(Buffer.from(`${record}\n`));
  assert.equal(lines.length, 1, 'an oversized preceding line cannot forge a new prefix');
  stream.stop();
  stream.collect(Buffer.from(record));
  assert.equal(lines.length, 1);
});

test('Modeling coverage adds the reporter without changing assertion reporters or other owners', () => {
  const group = { projects: ['@forgeax/engine-modeling'], files: [], excludes: [], shard: '16/16' };
  const args = buildGroupArgs({
    cliPath: 'vitest',
    group,
    maxWorkers: 1,
    coverage: true,
    coverageDir: 'coverage',
    reportPath: 'report.json',
  });
  assert.ok(args.includes('--reporter=default'));
  assert.ok(args.includes('--reporter=json'));
  assert.equal(args.filter((s) => s.includes('modeling-file-phase-reporter.mjs')).length, 1);
  const other = buildGroupArgs({
    cliPath: 'vitest',
    group: { ...group, projects: ['@forgeax/engine-render'] },
    maxWorkers: 1,
    coverage: true,
  });
  assert.equal(
    other.some((s) => s.includes('modeling-file-phase-reporter.mjs')),
    false,
  );
});

test('installed public Vitest invokes the reporter while preserving a real failing assertion', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'forgeax-phase-reporter-'));
  try {
    writeFileSync(
      path.join(dir, 'vitest.config.mjs'),
      'export default {test:{include:["phase.test.mjs"],maxWorkers:1}};',
    );
    writeFileSync(
      path.join(dir, 'phase.test.mjs'),
      `import {test} from ${JSON.stringify(import.meta.resolve('vitest'))};test('original assertion',()=>{throw Error('original failure');});`,
    );
    const reporter = fileURLToPath(new URL('../modeling-file-phase-reporter.mjs', import.meta.url));
    const cli = fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url));
    const result = spawnSync(
      process.execPath,
      [
        cli,
        'run',
        '--root',
        dir,
        '--config',
        path.join(dir, 'vitest.config.mjs'),
        '--reporter=default',
        `--reporter=${reporter}`,
      ],
      { encoding: 'utf8', timeout: 20_000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /original failure/);
    const records = result.stderr
      .split('\n')
      .filter((s) => s.startsWith(modelingFilePhasePrefix))
      .map((s) => parse(s, modelingFilePhasePrefix));
    assert.deepEqual(
      records.map((s) => s.phase),
      ['queued', 'collected', 'start', 'end', 'run-end'],
    );
    assert.equal(records[0].file, 'phase.test.mjs');
  } finally {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('forgeax-phase-reporter-'));
    rmSync(dir, { recursive: true, force: true });
  }
});
