import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = dirname(dirname(fileURLToPath(import.meta.url)));
const observation = { mode: 'completion', gpuPassTiming: false, gpuCounters: false, completion: 'FrameReceipt.completed' };
const identity = artifactSha256 => ({ artifactSha256, carrierSha256: 'fixture-carrier', observation });

test('series retains stderr after stdout closes and flushes failed-window logs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'managed-series-logs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const probe = join(root, 'probe'), artifact = join(root, 'artifact'), output = join(root, 'report');
  await cp(source, probe, { recursive: true });
  await mkdir(artifact);
  await writeFile(join(artifact, 'build-identity.json'), JSON.stringify(identity('log-fixture')));
  await writeFile(join(probe, 'cases.mjs'), 'export const cases=[{id:"static-10000"},{id:"shared-10000"},{id:"mesh-1000000-changed-64"}]; export const dimensions={groups:1,measuredFrames:300};');
  // A real child closes stdout while stderr still has pending diagnostics.
  // The old two auto-ending pipes terminate their shared file prematurely.
  await writeFile(join(probe, 'run-case.mjs'), `
    process.stdout.write('completed-frame-window\\n');
    process.stdout.end();
    setTimeout(() => {
      process.stderr.write('post-window-diagnostic-failure\\n');
      process.stderr.end();
      process.exitCode = 1;
    }, 30);
  `);
  let stderr = '';
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(probe, 'run-series.mjs'), 'calibration', artifact, artifact, output, '^static-10000$']);
    child.stdout.resume();
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.on('error', reject);
    child.on('close', resolve);
  });
  assert.equal(code, 1);
  assert.doesNotMatch(stderr, /ERR_STREAM_WRITE_AFTER_END|Unhandled 'error'/);
  const index = JSON.parse(await readFile(join(output, 'calibration-index.json'), 'utf8'));
  assert.equal(index.cases.length, 6);
  assert.equal(index.cases.filter(item => item.status === 'failed').length, 2);
  assert.equal(index.cases.filter(item => item.status === 'pending').length, 4);
  for (const mode of ['default', 'worker']) {
    const log = await readFile(join(output, `calibration.static-10000.${mode}.g0.0-A.json.log`), 'utf8');
    assert.equal(log, 'completed-frame-window\npost-window-diagnostic-failure\n');
  }
  assert.equal(JSON.parse(await readFile(join(output, 'noise.json'), 'utf8')).frozenAt, null);
});

test('core profile completes only its 72 lean windows and rejects incomplete calibration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'managed-series-core-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const probe = join(root, 'probe'), baseline = join(root, 'baseline'), current = join(root, 'current'), output = join(root, 'report');
  await cp(source, probe, { recursive: true });
  for (const artifact of [baseline, current]) {
    await mkdir(artifact);
    await writeFile(join(artifact, 'build-identity.json'), JSON.stringify(identity(artifact)));
  }
  // Exercise real series children and persisted receipts without launching a GPU.
  await writeFile(join(probe, 'run-case.mjs'), `
    import { appendFile, readFile, writeFile } from 'node:fs/promises';
    import { basename, dirname, join } from 'node:path';
    import { cases, dimensions } from './cases.mjs';
    const [artifact, caseId, mode, output, phase] = process.argv.slice(2);
    for (const key of ['CI','FORGEAX_BROWSER_HEADLESS','HEADLESS']) if (process.env[key] !== '1') throw new Error('Child headless environment missing: ' + key);
    if (basename(output).startsWith('compare.')) {
      const noise = JSON.parse(await readFile(join(dirname(output), 'noise.json'), 'utf8'));
      if (!noise.cases[caseId + '/' + mode]?.frozenAt) throw new Error('Case A/A must be frozen before the comparison child starts');
    }
    await appendFile(join(dirname(output), 'calls.ndjson'), JSON.stringify({ artifact: basename(artifact), caseId, mode, phase }) + '\\n');
    const config = cases.find(value => value.id === caseId);
    const identity = JSON.parse(await readFile(join(artifact, 'build-identity.json'), 'utf8'));
    const samples = Array.from({ length: dimensions.measuredFrames }, () => ({ assetCpuMs: 1, commitToAckMs: 2 }));
    const result = {
      config, mode, phase, measurementRunner: { browserMode: 'headless', gpuPassTiming: false, diagnosticOnly: false }, failures: [], samples, source: {},
      identity, observation: identity.observation, preflight: { status: 'unavailable', code: 'gpu-timing-not-enabled' },
      artifactVerification: { before: 'complete', after: 'complete', digest: identity.artifactSha256 },
      frameTimes: samples.map((_, index) => ({ hostMs: index * 16, wholeFrameMs: 8 })),
      quiescence: { completed: true }, teardown: 'complete', pixelChecks: [{ max: 0, mean: 0 }],
    };
    await writeFile(output, JSON.stringify(result));
  `);
  const run = async (phase, args = [], directory = output) => {
    let stderr = '';
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(probe, 'run-series.mjs'), phase, baseline, current, directory, ...args]);
      child.stdout.resume();
      child.stderr.on('data', bytes => { stderr += bytes; });
      child.on('error', reject);
      child.on('close', resolve);
    });
    return { code, stderr };
  };
  const read = async name => JSON.parse(await readFile(join(output, name), 'utf8'));
  const coreIds = ['static-10000', 'shared-10000', 'mesh-1000000-changed-64'];
  const calibration = await run('calibration', ['--profile=core']);
  assert.equal(calibration.code, 0, calibration.stderr);
  const contract = (await read('contract.json')).contract;
  assert.equal(contract.profile, 'core');
  assert.equal(contract.browserMode, 'headless');
  assert.equal(contract.sampling, 'measure-lean');
  assert.deepEqual(contract.cases.map(config => config.id), coreIds);
  assert.equal(contract.dimensions.measuredFrames, 300);
  assert.equal(contract.dimensions.groups, 3);
  const noise = await read('noise.json');
  assert(noise.frozenAt);
  assert.equal(Object.keys(noise.cases).length, 6);
  assert.equal((await read('calibration-index.json')).cases.length, 6);
  const comparison = await run('compare', ['--profile', 'core']);
  assert.equal(comparison.code, 0, comparison.stderr);
  const calls = (await readFile(join(output, 'calls.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 72);
  assert(calls.every(call => coreIds.includes(call.caseId) && call.phase === 'measure-lean'));
  for (let offset = 0; offset < 36; offset += 6) {
    assert.deepEqual(calls.slice(offset, offset + 6).map(call => call.artifact), Array(6).fill('baseline'));
    assert.deepEqual(calls.slice(36 + offset, 42 + offset).map(call => call.artifact), ['baseline', 'current', 'current', 'baseline', 'baseline', 'current']);
  }
  const index = await read('compare-index.json');
  assert.equal(index.profile, 'core');
  assert.equal(index.sampling, 'measure-lean');
  assert.equal(index.heapEvidence, 'not-collected');
  assert.equal(index.cases.length, 6);
  assert(index.cases.every(entry => entry.status === 'complete'));
  for (const entry of index.cases) for (const pair of entry.pairs) for (const window of pair) {
    const summary = JSON.parse(await readFile(window.file + '.summary.json', 'utf8'));
    assert.equal(summary.heapEvidence, 'not-collected');
    assert.equal(summary.measurement.diagnosticOnly, false);
    assert.equal(summary.observation.gpuPassTiming, false);
    assert.equal(summary.preflight.code, 'gpu-timing-not-enabled');
    assert.equal(summary.artifactVerification.digest, summary.artifact.artifactSha256);
    for (const field of ['allocationBytes', 'heapPeakBytes', 'gc', 'realmMemory']) assert.equal(Object.hasOwn(summary, field), false);
    assert(Object.keys(window.metrics).every(field => !/allocation|heap|gc\./.test(field)));
  }

  const wrongProfile = await run('compare', ['--profile=full']);
  assert.equal(wrongProfile.code, 1);
  assert.match(wrongProfile.stderr, /Unsupported series profile/);
  const incompletePath = join(output, 'calibration.static-10000.default.g0.0-A.json');
  const incomplete = JSON.parse(await readFile(incompletePath, 'utf8'));
  incomplete.measurementRunner.diagnosticOnly = true;
  await writeFile(incompletePath, JSON.stringify(incomplete));
  const diagnostic = await run('calibration', ['--profile=core', '^static-10000$']);
  assert.equal(diagnostic.code, 1);
  assert.match(diagnostic.stderr, /Window observation differs/);
  incomplete.measurementRunner.diagnosticOnly = false;
  const originalMode = incomplete.measurementRunner.browserMode;
  incomplete.measurementRunner.browserMode = 'headed';
  await writeFile(incompletePath, JSON.stringify(incomplete));
  const mixedMode = await run('calibration', ['--profile=core', '^static-10000$']);
  assert.equal(mixedMode.code, 1);
  assert.match(mixedMode.stderr, /Window browser mode differs/);
  incomplete.measurementRunner.browserMode = originalMode;
  incomplete.samples.pop();
  await writeFile(incompletePath, JSON.stringify(incomplete));
  const resumed = await run('calibration', ['--profile=core', '^static-10000$']);
  assert.equal(resumed.code, 1);
  assert.match(resumed.stderr, /Incomplete window/);
  assert.equal((await read('noise.json')).frozenAt, null);
  const rejected = await run('compare', ['--profile=core']);
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /noise must be frozen/);

  const pairedOutput = join(root, 'paired-report');
  const paired = await run('paired', ['--profile=core', '^static-10000$'], pairedOutput);
  assert.equal(paired.code, 0, paired.stderr);
  const pairedCalls = (await readFile(join(pairedOutput, 'calls.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(pairedCalls.length, 24);
  for (let offset = 0; offset < 24; offset += 12) {
    assert.deepEqual(pairedCalls.slice(offset, offset + 6).map(call => call.artifact), Array(6).fill('baseline'));
    assert.deepEqual(pairedCalls.slice(offset + 6, offset + 12).map(call => call.artifact), ['baseline', 'current', 'current', 'baseline', 'baseline', 'current']);
  }
  const pairedIndex = JSON.parse(await readFile(join(pairedOutput, 'paired-index.json'), 'utf8'));
  assert.equal(pairedIndex.cases.length, 6);
  assert.equal(pairedIndex.cases.filter(entry => entry.status === 'complete').length, 2);
  assert.equal(pairedIndex.cases.filter(entry => entry.status === 'pending').length, 4);
  assert.equal(pairedIndex.profileComplete, false);
  const pairedNoise = JSON.parse(await readFile(join(pairedOutput, 'noise.json'), 'utf8'));
  assert.equal(pairedNoise.frozenAt, null);
  assert(pairedNoise.cases['static-10000/default'].frozenAt);
  assert(pairedNoise.cases['static-10000/worker'].frozenAt);
});
