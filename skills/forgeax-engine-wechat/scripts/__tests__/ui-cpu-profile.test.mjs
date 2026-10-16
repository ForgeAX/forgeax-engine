import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const execute = promisify(execFile);
const runner = fileURLToPath(new URL('../run_ui_gpu_benchmark.mjs', import.meta.url));
const analyzer = fileURLToPath(new URL('../analyze_ui_cpu_profile.py', import.meta.url));
const chrome = process.env.FORGEAX_TEST_CHROME ?? chromium.executablePath();
const playwright = fileURLToPath(import.meta.resolve('playwright'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'ui-cpu-profile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function collect(t, flags, fail = false) {
  const root = await directory(t);
  // This page exercises real CDP collection/cleanup, not Engine rendering or FPS.
  const html = `<script>
    window.nativeUiProbe = {
      initialize: () => ({}), active: () => ({}), form: () => ({}),
      performance: () => {
        const end = performance.now() + 50;
        while (performance.now() < end) Math.sqrt(performance.now());
        if (${fail}) throw Error('controlled collector failure');
        return {frames:60, movementIntentCount:60, rasterPasses:60, pass:false};
      }, dispose: () => ({fixture:'collector control flow only'})
    };
  </script>`;
  await writeFile(join(root, 'index.html'), html);
  await writeFile(join(root, 'inputs.json'), JSON.stringify({
    backend: 'wgpu-webgl2',
    files: { 'index.html': { bytes: Buffer.byteLength(html), sha256: sha256(html) } },
  }));
  const out = join(root, 'result');
  let code = 0;
  try {
    await execute(process.execPath, [runner, '--root', root, '--out', out,
      '--playwright', playwright, '--chrome', chrome, '--backend', 'wgpu-webgl2', ...flags]);
  } catch (error) {
    code = error.code;
  }
  return { code, out, result: JSON.parse(await readFile(join(out, 'result.json'))) };
}

test('CPU profiling cannot be combined with the performance acceptance mode', async (t) => {
  const root = await directory(t);
  await assert.rejects(execute(process.execPath, [runner, '--root', root,
    '--out', join(root, 'result'), '--playwright', playwright, '--chrome', chrome,
    '--backend', 'wgpu-webgl2', '--performance', '--cpu-profile']),
  (error) => /separate uninstrumented --performance/.test(error.stderr));
  assert.equal(existsSync(join(root, 'result')), false);
});

test('real CDP diagnostic collects a profile while low FPS still fails formal acceptance',
  { skip: !existsSync(chrome), timeout: 30_000 }, async (t) => {
    const diagnostic = await collect(t, ['--cpu-profile']);
    assert.equal(diagnostic.code, 0);
    assert.equal(diagnostic.result.mode, 'cpu-profile');
    assert.equal(diagnostic.result.ok, true);
    assert.equal(diagnostic.result.steps.at(-1).value.pass, false);
    assert.equal(diagnostic.result.runnerSha256, sha256(await readFile(runner)));
    assert.match(diagnostic.result.cpuProfile.scope, /do not qualify GPU time/);
    const profile = JSON.parse(await readFile(join(diagnostic.out, 'profile.cpuprofile')));
    assert.ok(profile.samples.length > 0);
    assert.equal(profile.samples.length, profile.timeDeltas.length);
    const acceptance = await collect(t, ['--performance']);
    assert.equal(acceptance.code, 1);
    assert.equal(acceptance.result.mode, 'performance');
    assert.equal(acceptance.result.ok, false);
    assert.equal(existsSync(join(acceptance.out, 'profile.cpuprofile')), false);
  });

test('real CDP failure retains its partial profile and closes the owned browser',
  { skip: !existsSync(chrome), timeout: 30_000 }, async (t) => {
    const failure = await collect(t, ['--cpu-profile'], true);
    assert.equal(failure.code, 1);
    assert.equal(failure.result.ok, false);
    assert.match(failure.result.failure, /controlled collector failure/);
    assert.equal(failure.result.profileCleanupFailure, undefined);
    assert.ok(existsSync(join(failure.out, 'failed-profile.cpuprofile')));
    assert.deepEqual(failure.result.facts, { fixture: 'collector control flow only' });
  });

test('attribution keeps unconfirmed WASM outside paint and rejects truncated samples', async (t) => {
  const root = await directory(t);
  const wasmUrl = 'wasm://wasm/forgeax_ui_blitz';
  const node = (id, name, children = []) => ({ id, children,
    callFrame: { functionName: name, url: wasmUrl } });
  const profile = {
    startTime: 0, endTime: 6000, samples: [3, 4, 5], timeDeltas: [1000, 2000, 3000],
    nodes: [node(1, '(root)', [2, 5]), node(2, 'uidocument_paint_gpu', [3, 4]),
      node(3, 'vello_common::strip::render'),
      node(4, 'blitz_paint::paint_scene<LayoutType>'), node(5, 'vello_common::strip::render')],
  };
  const result = {
    backend: 'wgpu-webgl2', inputs: { workloadIdentity: { uiWasm: { sha256: 'fixture' } },
      kernel: { sourceDigest: 'fixture' } },
    facts: { performance: { frames: 60, movementIntentCount: 60,
      ...Object.fromEntries(['inputMs', 'paintGpuMs', 'prepareMs', 'encodeMs', 'submitCpuMs'].map(k => [k, {}])) }, phases: [] },
  };
  await writeFile(join(root, 'profile.cpuprofile'), JSON.stringify(profile));
  await writeFile(join(root, 'result.json'), JSON.stringify(result));
  await execute('python3', [analyzer, root]);
  const analysis = JSON.parse(await readFile(join(root, 'cpu-attribution.json')));
  assert.equal(analysis.paintAttribution, 'available');
  assert.equal(analysis.scopeTotalsMs.confirmedPaintWithJsSerializationMs, 3);
  assert.equal(analysis.scopeTotalsMs.uiWasmOutsideConfirmedPaintMs, 3);
  assert.equal(analysis.paintCategories.strip_generation.ms, 1);
  assert.equal(analysis.paintCategories.scene_conversion_excluding_above.ms, 2);
  profile.timeDeltas.pop();
  await writeFile(join(root, 'profile.cpuprofile'), JSON.stringify(profile));
  await assert.rejects(execute('python3', [analyzer, root]),
    error => /samples and time deltas differ/.test(error.stderr));
});
