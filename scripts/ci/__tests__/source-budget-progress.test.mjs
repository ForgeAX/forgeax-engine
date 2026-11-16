import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { buildGroupArgs, runChild } from '../run-split-vitest-coverage.mjs';
import Reporter, { sourceCompilationPhasePrefix } from '../source-compilation-phase-reporter.mjs';
import { runViewSourceCommand } from '../view-source-command.mjs';

test('cold source command output arrives before exit and retains original nonzero result', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'view-source-progress-'));
  const acknowledgement = resolve(root, 'observed');
  const lines = [];
  let write;
  t.mock.method(process.stderr, 'write', (chunk) => {
    lines.push(String(chunk));
    if (!write && String(chunk).includes('original child output'))
      write = writeFile(acknowledgement, 'observed');
    return true;
  });
  try {
    const result = await runViewSourceCommand(
      process.execPath,
      [
        '-e',
        "const fs=require('node:fs');process.stdout.write('original child output');const poll=setInterval(()=>{if(fs.existsSync(process.argv[1])){clearInterval(poll);clearTimeout(limit);process.stderr.write('original failure');process.exitCode=7;}},10);const limit=setTimeout(()=>{clearInterval(poll);process.exitCode=19;},2000);",
        acknowledgement,
      ],
      { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 },
    );
    assert.equal(result.status, 7);
    assert.equal(result.stdout, 'original child output');
    assert.equal(result.stderr, 'original failure');
    assert.equal(result.signal, null);
    const phases = lines.filter((line) => line.startsWith('{')).map(JSON.parse);
    assert.deepEqual(
      phases.map((row) => row.phase),
      ['start', 'end'],
    );
    assert.equal(phases[0].pid, phases[1].pid);
  } finally {
    await write;
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('view-source-progress-'));
    await rm(root, { recursive: true, force: true });
  }
});

test('source coverage observes exact module/case identity and streams before failing child close', async (t) => {
  const lines = [];
  let ready;
  const observed = new Promise((resolve) => {
    ready = resolve;
  });
  t.mock.method(process.stderr, 'write', (chunk) => {
    lines.push(String(chunk));
    if (String(chunk).startsWith('[vitest-source-compilation-phase-live] ')) ready();
    return true;
  });
  const reporter = new Reporter();
  const module = { relativeModuleId: 'src/__tests__/forced-source.test.ts' };
  const caseIdentity = {
    module,
    fullName: 'source > exact manifest',
    result: () => ({ state: 'failed' }),
  };
  reporter.onTestModuleQueued(module);
  reporter.onTestCaseReady(caseIdentity);
  reporter.onTestCaseResult(caseIdentity);
  reporter.onTestRunEnd();
  const records = lines.map((line) => JSON.parse(line.slice(sourceCompilationPhasePrefix.length)));
  assert.deepEqual(
    records.map((row) => row.phase),
    ['queued', 'case-start', 'case-end', 'run-end'],
  );
  assert.equal(records[2].test, caseIdentity.fullName);
  assert.equal(records[2].state, 'failed');
  let closed = false;
  const record = `${sourceCompilationPhasePrefix}${JSON.stringify(records[1])}\n`;
  const child = runChild(
    [
      '-e',
      `process.stderr.write(${JSON.stringify(record)});setTimeout(()=>{process.stdout.write('unchanged');process.exitCode=7;},100);`,
    ],
    { sourcePhases: true, progress: { groupIndex: 13, total: 14, label: 'forced-source' } },
  ).then((result) => {
    closed = true;
    return result;
  });
  await observed;
  assert.equal(closed, false);
  const result = await child;
  assert.equal(result.status, 7);
  assert.equal(Buffer.concat(result.stderr).toString(), record);
  assert.equal(Buffer.concat(result.stdout).toString(), 'unchanged');
  const group = {
    projects: ['@forgeax/engine-vite-plugin-shader'],
    sourceCompilation: true,
    files: [],
    excludes: [],
  };
  const args = buildGroupArgs({
    cliPath: 'vitest',
    group,
    maxWorkers: 1,
    coverage: true,
    coverageDir: 'coverage',
    reportPath: 'result.json',
  });
  assert.ok(args.includes('--reporter=default'));
  assert.ok(args.includes('--reporter=json'));
  assert.equal(
    args.filter((arg) => arg.includes('source-compilation-phase-reporter.mjs')).length,
    1,
  );
});

test('SDK source preparation streams original build output through the supported verifier process', async () => {
  const verifier = await readFile(new URL('../../forgeax/verify-sdk.mjs', import.meta.url), 'utf8');
  const start = verifier.indexOf('const sourceBuildPnpm =');
  const end = verifier.indexOf("if (selected('source'))", start);
  const invoke = new Function(
    'sourcePnpm',
    'sourceRoot',
    'sourceEnv',
    `${verifier.slice(start, end)}return sourceBuildPnpm;`,
  );
  const env = { CI: 'true', NODE_OPTIONS: '--max-old-space-size=8192' };
  let actual;
  await invoke(
    (args, options) => {
      actual = { args, options };
    },
    '/source',
    env,
  )(['build:engine']);
  assert.deepEqual(actual.args, ['build:engine']);
  assert.equal(actual.options.streamOutput, true);
  assert.equal(actual.options.env, env);
  assert.equal(actual.options.maxBuffer, 128 * 1024 * 1024);
});

test('public Vitest reporter preserves a real failed assertion while recording case lifecycle', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'source-phase-vitest-'));
  try {
    await writeFile(
      resolve(root, 'vitest.config.mjs'),
      'export default {test:{include:["phase.test.mjs"],maxWorkers:1}};',
    );
    await writeFile(
      resolve(root, 'phase.test.mjs'),
      `import {test} from ${JSON.stringify(import.meta.resolve('vitest'))};test('original source assertion',()=>{throw Error('original source failure');});`,
    );
    let result;
    try {
      result = await promisify(execFile)(
        process.execPath,
        [
          resolve('node_modules/vitest/vitest.mjs'),
          'run',
          '--root',
          root,
          '--config',
          resolve(root, 'vitest.config.mjs'),
          '--reporter=default',
          `--reporter=${resolve('scripts/ci/source-compilation-phase-reporter.mjs')}`,
        ],
        { encoding: 'utf8' },
      );
      assert.fail('original failed assertion must retain nonzero exit');
    } catch (error) {
      result = error;
    }
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /original source failure/);
    const records = result.stderr
      .split('\n')
      .filter((line) => line.startsWith(sourceCompilationPhasePrefix))
      .map((line) => JSON.parse(line.slice(sourceCompilationPhasePrefix.length)));
    assert.deepEqual(
      records.map((record) => record.phase),
      ['queued', 'collected', 'module-start', 'case-start', 'case-end', 'module-end', 'run-end'],
    );
    assert.equal(records[4].state, 'failed');
    assert.equal(records[4].test, 'original source assertion');
  } finally {
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('source-phase-vitest-'));
    await rm(root, { recursive: true, force: true });
  }
});
