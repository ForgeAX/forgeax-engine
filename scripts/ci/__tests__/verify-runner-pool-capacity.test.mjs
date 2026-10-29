import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DAWN_GATE_GROUPS } from '../dawn-gate-roster.mjs';
import { dawnVitestArgs } from '../run-dawn-gate.mjs';
import { assessRunnerPoolCapacity } from '../verify-runner-pool-capacity.mjs';

test('serial Dawn uses the admitted heavy CPU budget for software rendering', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  const start = workflow.indexOf('\n  vitest-dawn:\n');
  const end = workflow.indexOf('\n  vitest-dawn-required:\n', start);
  assert.ok(start >= 0 && end > start);
  const job = workflow.slice(start, end);
  const threads = Number(/LP_NUM_THREADS: '(\d+)'/.exec(job)?.[1] ?? 0);
  const capacity = assessRunnerPoolCapacity('heavy', {
    cpus: threads,
    memoryBytes: 16_000_000_000,
    containerized: true,
  });
  assert.equal(threads, capacity.expected.vcpus, 'use the admitted CPU floor without exceeding it');
  assert.equal(capacity.ok, true);
  const admission = job.indexOf('verify-runner-pool-capacity.mjs --pool heavy');
  assert.ok(admission >= 0 && admission < job.indexOf('run-dawn-gate.mjs'));
  for (const group of DAWN_GATE_GROUPS) {
    assert.ok(dawnVitestArgs(group).includes('--maxWorkers=1'));
    assert.ok(dawnVitestArgs(group).includes('--no-file-parallelism'));
  }
  const focus = readFileSync('.github/workflows/ci-focus.yml', 'utf8');
  assert.ok(focus.includes(`LP_NUM_THREADS: \${{ inputs.kind == 'dawn' && '${threads}' || '4' }}`));
  assert.ok(focus.includes('node scripts/ci/verify-runner-pool-capacity.mjs --pool heavy'));
});

test('heavy accepts an 8C16G cgroup', () => {
  const result = assessRunnerPoolCapacity('heavy', {
    cpus: 8,
    memoryBytes: 16_000_000_000,
    containerized: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.actual.source, 'cgroup');
});

test('heavy rejects a mislabeled 4C8G cgroup', () => {
  const result = assessRunnerPoolCapacity('heavy', {
    cpus: 4,
    memoryBytes: 8_000_000_000,
    containerized: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ci-runner-pool-capacity-mismatch');
  assert.deepEqual(result.expected, { vcpus: 8, memoryBytes: 16_000_000_000 });
});

test('standard is a minimum and admits larger runners', () => {
  const result = assessRunnerPoolCapacity('standard', {
    cpus: 16,
    memoryBytes: 32_000_000_000,
    containerized: true,
  });
  assert.equal(result.ok, true);
});
