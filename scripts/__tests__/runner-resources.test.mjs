import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appBuildConcurrency,
  coverageGroupConcurrency,
  coverageVitestWorkers,
  readMemoryPressureDiagnostics,
  runnerResources,
  shaderCompileWorkers,
  workspaceConcurrency,
} from '../lib/runner-resources.mjs';

function probe(files, hostMemoryBytes = 64 * 1024 ** 3, availableParallelism = 32) {
  return runnerResources({
    hostMemoryBytes,
    availableParallelism,
    exists: (path) => path in files,
    readFile: (path) => files[path],
  });
}

test('uses cgroup v2 CPU and memory limits for CPU containers', () => {
  const result = probe({
    '/sys/fs/cgroup/cpu.max': '400000 100000',
    '/sys/fs/cgroup/memory.max': String(8 * 1024 ** 3),
  });
  assert.deepEqual(result, { cpus: 4, memoryBytes: 8 * 1024 ** 3, containerized: true });
});

test('uses cgroup v1 CPU and memory limits for CPU containers', () => {
  const result = probe({
    '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '200000',
    '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000',
    '/sys/fs/cgroup/memory/memory.limit_in_bytes': String(4 * 1024 ** 3),
  });
  assert.deepEqual(result, { cpus: 2, memoryBytes: 4 * 1024 ** 3, containerized: true });
});

test('container quota never exceeds affinity/cpuset and fractional CPUs round down', () => {
  const quota = { '/sys/fs/cgroup/cpu.max': '800000 100000' };
  assert.equal(probe(quota, 64 * 1024 ** 3, 2).cpus, 2);
  assert.equal(probe({ '/sys/fs/cgroup/cpu.max': '250000 100000' }).cpus, 2);
  assert.equal(probe({ '/sys/fs/cgroup/cpu.max': '50000 100000' }).cpus, 1);
  assert.equal(probe({ '/sys/fs/cgroup/cpu.max': 'max 100000' }, 64 * 1024 ** 3, 2).cpus, 2);
});

test('uses host resources on direct CVM runners', () => {
  const result = probe({
    '/sys/fs/cgroup/cpu.max': 'max 100000',
    '/sys/fs/cgroup/memory.max': 'max',
  });
  assert.deepEqual(result, { cpus: 32, memoryBytes: 64 * 1024 ** 3, containerized: false });
});

test('leaves one CPU free while fitting workers in the actual memory limit', () => {
  assert.equal(
    workspaceConcurrency({ cpus: 4, memoryBytes: 8_000_000_000, reserveGB: 2, workerGB: 2 }),
    2,
  );
});

test('derives a conservative coverage worker budget from CPU and memory', () => {
  assert.equal(coverageVitestWorkers({ cpus: 4, memoryBytes: 8 * 1024 ** 3 }), 3);
  assert.equal(coverageVitestWorkers({ cpus: 8, memoryBytes: 16 * 1024 ** 3 }), 6);
  assert.equal(coverageVitestWorkers({ cpus: 32, memoryBytes: 64 * 1024 ** 3 }), 6);
});

test('derives isolated coverage group concurrency from CPU and memory', () => {
  assert.equal(coverageGroupConcurrency({ cpus: 4, memoryBytes: 8_000_000_000 }), 1);
  assert.equal(coverageGroupConcurrency({ cpus: 8, memoryBytes: 16_000_000_000 }), 2);
  assert.equal(coverageGroupConcurrency({ cpus: 16, memoryBytes: 32_000_000_000 }), 2);
  assert.equal(coverageGroupConcurrency({ cpus: 64, memoryBytes: 256 * 1024 ** 3 }), 2);
});

test('bounds native Vite builds on constrained and large runners', () => {
  assert.equal(appBuildConcurrency({ cpus: 8, memoryBytes: 16_000_000_000 }), 2);
  assert.equal(appBuildConcurrency({ cpus: 4, memoryBytes: 8_000_000_000 }), 1);
  assert.equal(appBuildConcurrency({ cpus: 32, memoryBytes: 64 * 1024 ** 3 }), 4);
  assert.equal(appBuildConcurrency({ cpus: 1, memoryBytes: 2 * 1024 ** 3 }), 1);
});

test('memory-pressure diagnostics name the largest resident processes on Linux', (t) => {
  if (process.platform !== 'linux') return t.skip('ps --sort is Linux-only');
  const diagnostics = readMemoryPressureDiagnostics();
  assert.ok(diagnostics.topRss.length > 1);
  assert.match(diagnostics.topRss[0], /RSS/);
});

test('shader production respects CPU, memory and the same sixteen-worker ceiling', () => {
  assert.equal(shaderCompileWorkers({ cpus: 64, memoryBytes: 184 * 1024 ** 3 }), 16);
  assert.equal(shaderCompileWorkers({ cpus: 64, memoryBytes: 4 * 1024 ** 3 }), 2);
  assert.equal(shaderCompileWorkers({ cpus: 64, memoryBytes: 4_000_000_000 }), 1);
  assert.equal(shaderCompileWorkers({ cpus: 4, memoryBytes: 64 * 1024 ** 3 }), 3);
  assert.equal(shaderCompileWorkers({ cpus: 1, memoryBytes: 2 * 1024 ** 3 }), 1);
  const container = { cpus: 8, memoryBytes: 16_000_000_000 };
  assert.equal(shaderCompileWorkers(container, ''), 7);
  assert.equal(shaderCompileWorkers(container, '64'), 7);
  assert.equal(shaderCompileWorkers(container, '2'), 2);
  assert.equal(shaderCompileWorkers(container, 'invalid'), 7);
});

test('parallel compiler owners share container resources and retain smaller overrides', () => {
  const container = probe({
    '/sys/fs/cgroup/cpu.max': '800000 100000',
    '/sys/fs/cgroup/memory.max': String(16 * 1024 ** 3),
  });
  assert.equal(shaderCompileWorkers(container, '7', 2), 3);
  assert.equal(shaderCompileWorkers(container, '2', 2), 2);
  assert.equal(shaderCompileWorkers(container, '7', 1), 7);
  assert.equal(shaderCompileWorkers({ ...container, memoryBytes: 6 * 1024 ** 3 }, '7', 2), 1);
});
