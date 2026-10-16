import assert from 'node:assert/strict';
import test from 'node:test';
import { assessRunnerPoolCapacity } from '../verify-runner-pool-capacity.mjs';

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
