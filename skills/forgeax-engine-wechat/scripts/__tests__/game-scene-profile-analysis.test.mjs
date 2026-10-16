import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const analyzer = fileURLToPath(new URL('../analyze_game_scene_profile.mjs', import.meta.url));
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'game-scene-profile-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const phase = { mode: 'ordinary-app-loop', startedAtMs: 0, drained: [], frames: Array.from({ length: 60 }, (_, index) => ({ frameId: index + 1, deviceGeneration: 0, presentation: 'ready', atMs: (index + 1) * 20 })) };
  await writeFile(join(directory, 'result.json'), JSON.stringify({ success: true, scope: 'tool test only', phases: { 'cpu-profile': { result: phase }, 'gpu-query': { result: { status: 'unavailable', reason: 'timer-extension-unavailable' } } } }));
  const profile = { startTime: 0, endTime: 4000, nodes: [{ id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1, columnNumber: -1 }, children: [2, 3] }, { id: 2, callFrame: { functionName: 'render', url: 'http://localhost/entry.js', lineNumber: 0, columnNumber: 0 } }, { id: 3, callFrame: { functionName: '(program)', url: '', lineNumber: -1, columnNumber: -1 } }], samples: [2, 2, 3, 3], timeDeltas: [1000, 1000, 1000, 1000] };
  await writeFile(join(directory, 'profile.cpuprofile'), JSON.stringify(profile));
  return { directory, profile };
}

test('completion timing and sample owners retain independent meanings', async t => {
  const { directory } = await fixture(t);
  execFileSync(process.execPath, [analyzer, '--run', directory]);
  const report = JSON.parse(await readFile(join(directory, 'analysis.json')));
  assert.equal(report.phases['cpu-profile'].completedFps, 50);
  assert.equal(report.phases['cpu-profile'].interCompletionMs.count, 59);
  assert.equal(report.cpu.ownerSelfMs['(program)'], 2);
  assert.equal(report.cpu.ownerSelfMs.unmapped, 2);
  assert.equal(report.gpu.status, 'unavailable');
  assert.equal(report.gpu.gpuIntervalMs, undefined);
});

test('inconsistent sample cardinality is rejected', async t => {
  const { directory, profile } = await fixture(t); profile.timeDeltas.pop();
  await writeFile(join(directory, 'profile.cpuprofile'), JSON.stringify(profile));
  assert.throws(() => execFileSync(process.execPath, [analyzer, '--run', directory], { stdio: 'pipe' }));
});

test('an unrelated source map cannot relabel measured CPU owners', async t => {
  const { directory } = await fixture(t), map = join(directory, 'unrelated.map');
  await writeFile(map, '{}');
  assert.throws(() => execFileSync(process.execPath, [analyzer, '--run', directory, '--source-map', map, '--trace-mapping', '/not-loaded.mjs'], { stdio: 'pipe' }), /Source map identity/);
});

test('five-frame tool verification never publishes FPS', async t => {
  const { directory } = await fixture(t), path = join(directory, 'result.json');
  const result = JSON.parse(await readFile(path)); result.toolVerification = true;
  result.phases['cpu-profile'].result.frames.length = 5;
  await writeFile(path, JSON.stringify(result));
  execFileSync(process.execPath, [analyzer, '--run', directory]);
  const report = JSON.parse(await readFile(join(directory, 'analysis.json')));
  assert.equal(report.phases['cpu-profile'].completedFrames, 5);
  assert.equal(report.phases['cpu-profile'].completedFps, undefined);
  assert.equal(report.phases['cpu-profile'].timingAcceptance, 'not-measured-tool-verification');
});

test('receipt mode preserves disabled controls and verifies paired callback identities', async t => {
  const { directory } = await fixture(t), path = join(directory, 'result.json');
  const result = JSON.parse(await readFile(path)), original = result.phases['cpu-profile'].result;
  result.mode = 'receipts'; result.phases = {};
  for (const [name, enabled] of [['control-before', false], ['receipt-trace', true], ['control-after', false]]) {
    const phase = structuredClone(original);
    phase.observedAtMs = 1200;
    phase.receiptObservation = {
      enabled, clock: 'performance.now', endedAtMs: 1201,
      before: { submitted: 0, completed: 0, inFlight: 0, highWater: 0, throttledTicks: 0 },
      atStop: { submitted: 60, completed: 60, inFlight: 0, highWater: 2, throttledTicks: 7 },
      after: { submitted: 60, completed: 60, inFlight: 0, highWater: 2, throttledTicks: 7 },
      submitted: enabled ? phase.frames.map(row => ({ ...row, atMs: row.atMs - 10 })) : [],
    };
    result.phases[name] = { result: phase };
  }
  await writeFile(path, JSON.stringify(result));
  execFileSync(process.execPath, [analyzer, '--run', directory]);
  const report = JSON.parse(await readFile(join(directory, 'analysis.json')));
  assert.deepEqual(report.receiptComparison.completedFps, { 'control-before': 50, 'receipt-trace': 50, 'control-after': 50 });
  assert.equal(report.phases['receipt-trace'].receipts.matchedIdentities, 60);
  assert.equal(report.phases['receipt-trace'].receipts.submissionToCompletionCallbackMs.median, 10);
  result.phases['control-after'].result.receiptObservation.enabled = true;
  await writeFile(path, JSON.stringify(result));
  assert.throws(() => execFileSync(process.execPath, [analyzer, '--run', directory], { stdio: 'pipe' }));
});
