#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runnerResources } from '../lib/runner-resources.mjs';

const PROC_STATUS = '/proc/self/status';

/**
 * Expand Linux's Cpus_allowed_list representation without trusting the
 * machine label. The benchmark only binds to CPUs that the runner process is
 * already allowed to use.
 */
export function parseCpuList(value) {
  if (typeof value !== 'string' || value.trim() === '') return [];
  const cpus = [];
  for (const token of value.trim().split(',')) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(token.trim());
    if (!match) return [];
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return [];
    for (let cpu = start; cpu <= end; cpu += 1) cpus.push(cpu);
  }
  return [...new Set(cpus)].sort((left, right) => left - right);
}

export function formatCpuList(cpus) {
  if (!Array.isArray(cpus) || cpus.length === 0) return '';
  const sorted = [...new Set(cpus)]
    .filter((cpu) => Number.isSafeInteger(cpu) && cpu >= 0)
    .sort((left, right) => left - right);
  if (sorted.length === 0) return '';
  const ranges = [];
  let start = sorted[0];
  let previous = sorted[0];
  for (const cpu of sorted.slice(1)) {
    if (cpu === previous + 1) {
      previous = cpu;
      continue;
    }
    ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = previous = cpu;
  }
  ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
  return ranges.join(',');
}

export function readAllowedCpuList({ read = (path) => readFileSync(path, 'utf8') } = {}) {
  let status;
  try {
    status = read(PROC_STATUS);
  } catch {
    return [];
  }
  const match = /^Cpus_allowed_list:\s*(\S+)\s*$/m.exec(status);
  return parseCpuList(match?.[1] ?? '');
}

export function resolveRunnerCpuAffinity({
  platform = process.platform,
  resources = runnerResources(),
  allowedCpus = readAllowedCpuList(),
  runnerName = process.env.RUNNER_NAME ?? '',
  read = (path) => readFileSync(path, 'utf8'),
} = {}) {
  const common = {
    runnerCpus: resources.cpus,
    containerized: resources.containerized,
    allowedCpuCount: allowedCpus.length,
    allowedCpuList: formatCpuList(allowedCpus),
  };
  if (platform !== 'linux') {
    return { ok: true, mode: 'none', reason: 'non-linux-runner', ...common };
  }
  if (!resources.containerized) {
    return { ok: true, mode: 'none', reason: 'host-runner-no-cgroup', ...common };
  }
  if (!Number.isInteger(resources.cpus) || resources.cpus < 1) {
    return { ok: false, mode: 'fail-closed', reason: 'runner-cpu-capacity-unavailable', ...common };
  }
  if (allowedCpus.length < resources.cpus) {
    return {
      ok: false,
      mode: 'fail-closed',
      reason: 'cpuset-smaller-than-cgroup-quota',
      ...common,
    };
  }
  // Shared containers can expose the entire host mask with a smaller quota.
  // Always taking its first CPUs crowds unrelated runners onto one window.
  // Existing runner identity spreads stable, quota-sized windows; it is not
  // an exclusive CPU lease, and never changes the allowed set or CPU budget.
  // Containers can see every logical CPU on a host while cgroups cap the
  // process to a much smaller CPU budget. A logical window of eight adjacent
  // IDs can be only four physical cores when SMT siblings are adjacent. Dawn
  // and SwiftShader are CPU-heavy, so prefer one allowed thread per physical
  // core when topology is available and enough distinct cores fit the quota.
  // If topology is missing or the cpuset exposes fewer physical cores than
  // the cgroup budget, retain the bounded logical-CPU selection below.
  const topology = runnerCpuSiblings({
    platform,
    selectedCpuList: formatCpuList(allowedCpus),
    read,
  });
  const physicalCoreCpus = [];
  const seenPhysicalCores = new Set();
  for (const item of topology ?? []) {
    if (seenPhysicalCores.has(item.siblings)) continue;
    seenPhysicalCores.add(item.siblings);
    physicalCoreCpus.push(item.cpu);
  }
  const usePhysicalCores = physicalCoreCpus.length >= resources.cpus;
  const cpuPool = usePhysicalCores ? physicalCoreCpus : allowedCpus;
  const windows = Math.floor(cpuPool.length / resources.cpus);
  const identity = typeof runnerName === 'string' ? runnerName.trim() : '';
  const window =
    identity !== '' && windows > 1
      ? createHash('sha256').update(identity).digest().readUInt32BE(0) % windows
      : 0;
  const offset = window * resources.cpus;
  const selectedCpus = cpuPool.slice(offset, offset + resources.cpus);
  return {
    ok: true,
    mode: 'taskset',
    reason: 'bind-to-cgroup-cpu-budget',
    selectedCpuCount: selectedCpus.length,
    selectedCpuList: formatCpuList(selectedCpus),
    selectedCpuTopology: usePhysicalCores ? 'distinct-physical-cores' : 'logical-cpu-window',
    ...common,
  };
}

// Equal CPU masks do not prove a shared scheduler. Record only an opaque
// kernel identity so coincident CI jobs can establish that relationship.
export function runnerKernelFingerprint({
  platform = process.platform,
  read = (path) => readFileSync(path, 'utf8'),
} = {}) {
  if (platform !== 'linux') return null;
  try {
    const boot = read('/proc/sys/kernel/random/boot_id').trim();
    return boot === '' ? null : createHash('sha256').update(boot).digest('hex');
  } catch {
    return null;
  }
}

// Disjoint logical masks can still select the same physical cores. Read the
// kernel's actual sibling lists; missing topology must stay unknown.
export function runnerCpuSiblings({
  platform = process.platform,
  selectedCpuList = '',
  read = (path) => readFileSync(path, 'utf8'),
} = {}) {
  if (platform !== 'linux') return null;
  const selected = parseCpuList(selectedCpuList);
  if (selected.length === 0) return null;
  try {
    return selected.map((cpu) => {
      const siblings = parseCpuList(
        read(`/sys/devices/system/cpu/cpu${cpu}/topology/thread_siblings_list`),
      );
      if (!siblings.includes(cpu)) throw new Error('incomplete CPU topology');
      return { cpu, siblings: formatCpuList(siblings) };
    });
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const separator = argv.indexOf('--');
  if (separator !== 0 || separator === argv.length - 1)
    throw new Error('usage: run-with-runner-cpu-affinity.mjs -- <command> [args...]');
  return argv.slice(separator + 1);
}

// Observe only this command's GPU descendants. A driver's worker threads can
// change their own affinity after taskset; the parent receipt cannot prove
// their isolation. This reads masks and never changes process scheduling.
export function runnerGpuThreadAffinity(
  rootPid,
  {
    platform = process.platform,
    selectedCpuList = '',
    read = (path) => readFileSync(path, 'utf8'),
    list = (path) => readdirSync(path),
  } = {},
) {
  if (platform !== 'linux' || !Number.isSafeInteger(rootPid) || rootPid <= 1) return null;
  try {
    const owned = new Set([rootPid]);
    // The kernel exposes children per thread, including subprocesses created
    // by Node Workers. Walk only this command's scope; lean runner containers
    // need no optional ps binary or host-wide process table.
    for (const pid of owned) {
      try {
        for (const tid of list(`/proc/${pid}/task`).filter((id) => /^\d+$/.test(id))) {
          try {
            for (const child of read(`/proc/${pid}/task/${tid}/children`).trim().split(/\s+/)) {
              if (/^\d+$/.test(child) && Number(child) > 1) owned.add(Number(child));
            }
          } catch {
            /* A thread can exit between the task list and its children read. */
          }
        }
      } catch (error) {
        if (pid === rootPid) throw error;
        /* An owned child can exit while its descendants are being discovered. */
      }
    }
    const selected = new Set(parseCpuList(selectedCpuList));
    const observations = [];
    for (const pid of owned) {
      try {
        const argv = read(`/proc/${pid}/cmdline`).split('\0').filter(Boolean);
        // A rewritten title occupies one argv record; preserve genuine argument boundaries.
        const tokens = argv.length === 1 ? argv[0].split(/\s+/) : argv;
        const roles = tokens.filter((token) => token.startsWith('--type='));
        if (roles.length !== 1 || roles[0] !== '--type=gpu-process') continue;
        const masks = new Map();
        for (const tid of list(`/proc/${pid}/task`).filter((id) => /^\d+$/.test(id))) {
          let cpus = [];
          let name = null;
          try {
            const status = read(`/proc/${pid}/task/${tid}/status`);
            cpus = parseCpuList(/^Cpus_allowed_list:\s*(\S+)\s*$/m.exec(status)?.[1] ?? '');
            name = /^Name:\s*(\S.*)$/m.exec(status)?.[1]?.trim() ?? null;
          } catch {
            /* Exited or unreadable threads remain unknown. */
          }
          const cpuList = cpus.length ? formatCpuList(cpus) : null;
          let mask = masks.get(cpuList);
          if (!mask) {
            mask = {
              cpuList,
              threads: 0,
              names: [],
              outsideSelected:
                cpus.length && selected.size ? cpus.some((cpu) => !selected.has(cpu)) : null,
            };
            masks.set(cpuList, mask);
          }
          mask.threads++;
          if (name && !mask.names.includes(name)) mask.names.push(name);
        }
        observations.push({ pid, threadMasks: [...masks.values()] });
      } catch {
        /* Descendants can exit between the process and thread snapshots. */
      }
    }
    return observations;
  } catch {
    return null;
  }
}

// SwiftShader can replace inherited taskset masks with zero-based CPU indices.
// Correct only escaped threads of this command's live GPU descendants; leave
// narrower masks, worker counts and foreign processes alone.
export function constrainRunnerGpuThreads(
  rootPid,
  {
    platform = process.platform,
    selectedCpuList = '',
    read = (path) => readFileSync(path, 'utf8'),
    list = (path) => readdirSync(path),
    bind = (tid, cpus) => {
      try {
        execFileSync('taskset', ['--pid', '--cpu-list', cpus, String(tid)], {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 1000,
        });
      } catch (error) {
        try {
          read(`/proc/${tid}/status`);
        } catch (missing) {
          if (missing.code === 'ENOENT') error.code = 'ESRCH';
        }
        throw error;
      }
    },
  } = {},
) {
  const result = { corrected: 0, errors: [] };
  const selected = new Set(parseCpuList(selectedCpuList));
  if (platform !== 'linux' || !selected.size) return result;
  const options = { platform, selectedCpuList, read, list };
  const identity = (pid, tid) => {
    const stat = read(tid === undefined ? `/proc/${pid}/stat` : `/proc/${pid}/task/${tid}/stat`);
    return stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/)[19];
  };
  for (const gpu of runnerGpuThreadAffinity(rootPid, options) ?? []) {
    if (!gpu.threadMasks.some((mask) => mask.outsideSelected === true)) continue;
    try {
      const generation = identity(gpu.pid);
      if (!/^\d+$/.test(generation ?? '')) continue;
      for (const tid of list(`/proc/${gpu.pid}/task`).filter((id) => /^\d+$/.test(id))) {
        try {
          const status = read(`/proc/${gpu.pid}/task/${tid}/status`);
          const cpus = parseCpuList(/^Cpus_allowed_list:\s*(\S+)\s*$/m.exec(status)?.[1] ?? '');
          if (!cpus.some((cpu) => !selected.has(cpu))) continue;
          if (Number(/^Tgid:\s*(\d+)\s*$/m.exec(status)?.[1]) !== gpu.pid) continue;
          const threadGeneration = identity(gpu.pid, tid);
          if (!/^\d+$/.test(threadGeneration ?? '')) continue;
          // Revalidate ancestry and process generation immediately before mutation.
          if (
            !(runnerGpuThreadAffinity(rootPid, options) ?? []).some((item) => item.pid === gpu.pid)
          )
            break;
          if (identity(gpu.pid) !== generation) break;
          // The worker can retire during process validation. Check its own
          // generation and membership last; snapshots cannot make the later
          // numeric-TID syscall atomic with kernel retirement.
          if (identity(gpu.pid, tid) !== threadGeneration) continue;
          const current = read(`/proc/${gpu.pid}/task/${tid}/status`);
          if (Number(/^Tgid:\s*(\d+)\s*$/m.exec(current)?.[1]) !== gpu.pid) continue;
          const currentCpus = parseCpuList(
            /^Cpus_allowed_list:\s*(\S+)\s*$/m.exec(current)?.[1] ?? '',
          );
          if (!currentCpus.some((cpu) => !selected.has(cpu))) continue;
          bind(Number(tid), selectedCpuList);
          result.corrected++;
        } catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'ESRCH') {
            result.errors.push({
              pid: gpu.pid,
              tid: Number(tid),
              code: error.code ?? 'affinity-failed',
            });
          }
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') {
        result.errors.push({ pid: gpu.pid, code: error.code ?? 'affinity-failed' });
      }
    }
  }
  return result;
}

function run(command, affinity) {
  const env = {
    ...process.env,
    FORGEAX_RUNNER_CPU_AFFINITY: JSON.stringify(affinity),
  };
  const childCommand = affinity.mode === 'taskset' ? 'taskset' : command[0];
  const childArgs =
    affinity.mode === 'taskset'
      ? ['--cpu-list', affinity.selectedCpuList, ...command]
      : command.slice(1);
  const child = spawn(childCommand, childArgs, { env, stdio: 'inherit' });
  const recorded = new Map();
  let scopeStatus;
  let affinityFailed = false;
  const observer =
    process.platform === 'linux'
      ? setInterval(
          () => {
            const snapshots = runnerGpuThreadAffinity(child.pid, {
              selectedCpuList: affinity.selectedCpuList,
            });
            const status =
              snapshots === null ? 'unavailable' : snapshots.length ? 'observed' : 'not-observed';
            if (status !== scopeStatus) {
              scopeStatus = status;
              process.stdout.write(`[runner-gpu-affinity-scope] ${JSON.stringify({ status })}\n`);
            }
            for (const snapshot of snapshots ?? []) {
              const value = JSON.stringify(snapshot);
              if (recorded.get(snapshot.pid) === value) continue;
              recorded.set(snapshot.pid, value);
              process.stdout.write(
                `[runner-gpu-affinity] ${JSON.stringify({
                  kernelFingerprint: affinity.kernelFingerprint,
                  selectedCpuList: affinity.selectedCpuList ?? null,
                  ...snapshot,
                })}\n`,
              );
            }
            if (affinity.mode === 'taskset') {
              const correction = constrainRunnerGpuThreads(child.pid, {
                selectedCpuList: affinity.selectedCpuList,
              });
              if (correction.corrected || correction.errors.length) {
                process.stdout.write(
                  `[runner-gpu-affinity-correction] ${JSON.stringify(correction)}\n`,
                );
              }
              affinityFailed ||= correction.errors.length > 0;
            }
          },
          affinity.mode === 'taskset' ? 1000 : 30_000,
        )
      : null;
  observer?.unref();
  child.once('error', (error) => {
    clearInterval(observer);
    process.stderr.write(`[runner-affinity] failed to start ${childCommand}: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once('close', (status, signal) => {
    clearInterval(observer);
    if (status !== null) process.exitCode = status === 0 && affinityFailed ? 1 : status;
    else process.exitCode = 1;
    if (signal) process.stderr.write(`[runner-affinity] child terminated by ${signal}\n`);
  });
}

function main(argv) {
  const command = parseArgs(argv);
  const selected = resolveRunnerCpuAffinity();
  const affinity = {
    ...selected,
    kernelFingerprint: runnerKernelFingerprint(),
    selectedCpuSiblings: runnerCpuSiblings({ selectedCpuList: selected.selectedCpuList }),
  };
  process.stdout.write(`[runner-affinity] ${JSON.stringify(affinity)}\n`);
  if (!affinity.ok) {
    process.stderr.write(`[runner-affinity] refusing an unqualified runner\n`);
    process.exitCode = 1;
    return;
  }
  run(command, affinity);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[runner-affinity] ${error.message}\n`);
    process.exitCode = 1;
  }
}
