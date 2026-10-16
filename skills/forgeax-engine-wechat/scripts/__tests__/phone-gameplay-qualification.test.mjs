import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectPhoneGameplayQualification,
  summarizePhoneGameplaySamples,
} from '../phone_gameplay_qualification.mjs';

const phases = ['walk', 'run', 'jump', 'run-jump'].map((name, i) => ({
  name,
  startMs: i * 1000,
  endMs: (i + 1) * 1000,
}));
function player(time) {
  const phase = Math.min(3, Math.floor(time / 1000)),
    local = time % 1000;
  return {
    position: [
      phase === 2 ? 0 : (local / 1000) * (phase === 0 ? 1 : 2),
      phase >= 2 && local >= 200 && local < 800 ? 1.5 : 1,
      0,
    ],
    grounded: phase < 2 || local < 200 || local >= 800,
    camera: { yaw: time / 1000 },
    controls: { horizontal: 0, vertical: phase === 2 ? 0 : 1, run: phase === 1 || phase === 3 },
    simulation: { fixedTick: Math.floor(time / 16) },
  };
}
function samples() {
  return Array.from({ length: 40 }, (_, index) => {
    const atMs = index * 100,
      p = player(atMs);
    return {
      atMs,
      readMs: 1,
      position: p.position,
      grounded: p.grounded,
      yaw: p.camera.yaw,
      controls: p.controls,
    };
  });
}

test('qualification requires observed speed increase, rising jumps and camera change in all phases', () => {
  const result = summarizePhoneGameplaySamples(samples(), phases, 0, 1);
  assert.equal(result.success, true);
  assert.ok(Math.abs(result.phases[0].medianSpeed - 1) < 1e-9);
  assert.ok(Math.abs(result.phases[1].medianSpeed - 2) < 1e-9);
  assert.equal(result.runToWalkMedianSpeed, 2);
  assert.ok(result.phases[2].airborneSamples > 0);
  for (const mode of ['run-speed', 'falling', 'camera', 'coverage']) {
    const rows = samples();
    if (mode === 'run-speed')
      for (const row of rows.filter((row) => row.atMs >= 1000 && row.atMs < 2000))
        row.position[0] /= 2;
    if (mode === 'falling') for (const row of rows) row.position[1] = 0.5;
    if (mode === 'camera') for (const row of rows) row.yaw = 0;
    if (mode === 'coverage') rows.splice(10, 9);
    assert.equal(summarizePhoneGameplaySamples(rows, phases, 0, 1).success, false, mode);
  }
});

test('sparse collector bounds its cadence and snapshots actual public player values', async () => {
  let time = 0;
  const shared = {};
  const result = await collectPhoneGameplayQualification({
    now: () => time,
    wait: async (ms) => {
      time += ms;
    },
    read: async () => Object.assign(shared, player(time)),
    startMs: 0,
    endMs: 4000,
    phases,
    baselineHeight: 1,
  });
  assert.equal(result.success, true);
  assert.equal(result.samples.length, 40);
  assert.equal(result.samples[0].position[0], 0);
  assert.equal(result.samples[0].controls.run, false);
  assert.equal(result.diagnosticOnly, true);
  assert.equal(result.cleanFpsEvidence, false);
});

test('unavailable public projection retains a failed diagnostic rather than socket-only success', async () => {
  let time = 0;
  const result = await collectPhoneGameplayQualification({
    now: () => time,
    wait: async (ms) => {
      time += ms;
    },
    read: async () => ({ grounded: false }),
    startMs: 0,
    endMs: 4000,
    phases,
    baselineHeight: 1,
  });
  assert.equal(result.success, false);
  assert.match(result.failure, /Public player projection/);
});
