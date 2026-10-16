import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';

function cgroupCpuLimit(read) {
  const v2 = read('/sys/fs/cgroup/cpu.max');
  if (v2) {
    const [quota, period] = v2.split(/\s+/);
    if (quota !== 'max' && Number(quota) > 0 && Number(period) > 0)
      return Number(quota) / Number(period);
  }
  const quota = Number(read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'));
  const period = Number(read('/sys/fs/cgroup/cpu/cpu.cfs_period_us'));
  return quota > 0 && period > 0 ? quota / period : null;
}

function cgroupMemoryLimit(read, hostMemoryBytes) {
  const raw =
    read('/sys/fs/cgroup/memory.max') ?? read('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  const bytes = raw === 'max' || raw === null ? null : Number(raw);
  return Number.isFinite(bytes) && bytes > 0 && bytes < hostMemoryBytes ? bytes : null;
}

/**
 * Uses cgroup quota and memory when a runner is containerized. Node otherwise
 * reports the CVM host resources, which is correct for direct CVM runners but
 * can grossly overstate a CPU container's usable capacity.
 */
export function runnerResources({
  availableParallelism = os.availableParallelism?.() ?? os.cpus().length,
  hostMemoryBytes = os.totalmem(),
  exists = existsSync,
  readFile = readFileSync,
} = {}) {
  const read = (path) => (exists(path) ? readFile(path, 'utf8').trim() : null);
  const cpuQuota = cgroupCpuLimit(read);
  const memoryLimit = cgroupMemoryLimit(read, hostMemoryBytes);
  return {
    cpus: Math.max(1, Math.floor(Math.min(availableParallelism, cpuQuota ?? availableParallelism))),
    memoryBytes: memoryLimit ?? hostMemoryBytes,
    containerized: cpuQuota !== null || memoryLimit !== null,
  };
}

export function workspaceConcurrency({ cpus, memoryBytes, reserveGB, workerGB }) {
  const memoryGB = memoryBytes / 1024 ** 3;
  const memoryBudget = Math.max(1, Math.floor((memoryGB - reserveGB) / workerGB));
  return Math.max(1, Math.min(cpus - 1, memoryBudget));
}

/** Share container capacity across concurrent owners, leaving headroom in each. */
export function shaderCompileWorkers(resources, requested, concurrentOwners = 1) {
  const budget = Math.min(
    16,
    workspaceConcurrency({
      cpus: Math.max(1, Math.floor(resources.cpus / concurrentOwners)),
      memoryBytes: resources.memoryBytes / concurrentOwners,
      reserveGB: 2,
      workerGB: 1,
    }),
  );
  const count = Number.parseInt(requested ?? '', 10);
  return Number.isFinite(count) && count > 0 ? Math.min(budget, count) : budget;
}

/**
 * Coverage and typecheck run together in a single Vitest process, so each
 * worker carries more memory than an ordinary test worker. Self-hosted heavy
 * labels also do not promise an exclusive machine; keep the derived budget
 * conservative.
 */
export function coverageVitestWorkers({ cpus, memoryBytes }) {
  return Math.min(6, workspaceConcurrency({ cpus, memoryBytes, reserveGB: 2, workerGB: 2 }));
}

/**
 * Split coverage keeps Vitest itself at one worker and parallelizes isolated
 * child processes instead. Each child has a 4 GiB V8 heap cap; leave three GiB
 * for native coverage state and the runner. Source shader compilation and
 * repository scans become timeout-bound when three instrumented children share
 * one host, so keep the automatic ceiling at two even on larger runners.
 */
export function coverageGroupConcurrency({ cpus, memoryBytes }) {
  return Math.min(2, workspaceConcurrency({ cpus, memoryBytes, reserveGB: 3, workerGB: 4 }));
}

/** Vite app builds include native bundling allocations beyond the JS heap.
 * Keep headroom for the runner and concurrent artifact compression.
 */
export function appBuildConcurrency({ cpus, memoryBytes }) {
  const memoryBudget = Math.max(1, Math.floor((memoryBytes / 1024 ** 3 - 3) / 4));
  return Math.max(1, Math.min(cpus - 1, memoryBudget, 4));
}

/**
 * Evidence for a child that died by SIGKILL: the cgroup memory counters show
 * whether the OOM killer fired, and the largest resident processes show which
 * owners (including leftovers from earlier jobs) held the memory.
 */
export function readMemoryPressureDiagnostics() {
  const candidates = {
    current: ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory/memory.usage_in_bytes'],
    peak: ['/sys/fs/cgroup/memory.peak', '/sys/fs/cgroup/memory/memory.max_usage_in_bytes'],
    events: ['/sys/fs/cgroup/memory.events', '/sys/fs/cgroup/memory/memory.oom_control'],
  };
  const diagnostics = {};
  for (const [key, paths] of Object.entries(candidates)) {
    for (const path of paths) {
      try {
        diagnostics[key] = readFileSync(path, 'utf8').trim();
        break;
      } catch {
        // The runner may expose only one cgroup generation or no memory files.
      }
    }
  }
  if (process.platform === 'linux') {
    const ps = spawnSync('ps', ['-eo', 'rss,pid,etimes,args', '--sort=-rss'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    if (ps.status === 0)
      diagnostics.topRss = ps.stdout
        .trim()
        .split('\n')
        .slice(0, 11)
        .map((line) => line.slice(0, 200));
  }
  return Object.keys(diagnostics).length > 0 ? diagnostics : undefined;
}
