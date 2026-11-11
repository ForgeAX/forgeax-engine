import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { runnerResources } from '../lib/runner-resources.mjs';

function observed(read) {
  try {
    return { status: 'observed', value: read() };
  } catch (error) {
    return { status: 'unavailable', code: error.code ?? error.name };
  }
}

function fileIdentity(file) {
  return {
    file,
    bytes: statSync(file).size,
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
  };
}

function query(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 2_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw (
      result.error ?? Object.assign(new Error('diagnostic-command-failed'), { code: result.status })
    );
  return result.stdout.trim();
}

/** Bounded observations only; no GPU/device creation, scheduling change, or test policy. */
export function reportDawnEnvironment(root, phase, identity = false) {
  const record = {
    phase,
    scope: 'parent-ambient-not-child-effective',
    at: new Date().toISOString(),
    pid: process.pid,
    runnerName: process.env.RUNNER_NAME ?? null,
    node: process.version,
    resources: observed(() => runnerResources()),
    availableParallelism: os.availableParallelism?.() ?? null,
    quota: Object.fromEntries(
      [
        '/sys/fs/cgroup/cpu.max',
        '/sys/fs/cgroup/cpu/cpu.cfs_quota_us',
        '/sys/fs/cgroup/cpu/cpu.cfs_period_us',
        '/proc/self/cgroup',
      ].map((file) => [file, observed(() => readFileSync(file, 'utf8').trim())]),
    ),
    pidNamespace: observed(() => readlinkSync('/proc/self/ns/pid')),
    visibleProcesses: observed(() => {
      const rows = query('ps', ['-eo', 'pid,ppid,pcpu,time,comm', '--sort=-pcpu']).split('\n');
      return {
        scope: 'current PID namespace; pcpu is lifetime average, not an instantaneous CPU sample',
        count: rows.length - 1,
        top: rows.slice(0, 13),
      };
    }),
  };
  if (identity) {
    record.cpuModel = os.cpus()[0]?.model ?? null;
    record.ambientEnvironment = Object.fromEntries(
      ['LP_NUM_THREADS', 'FORGEAX_DAWN_LIGHTWEIGHT', 'FORGEAX_WEBGPU_NODE'].map((key) => [
        key,
        process.env[key] ?? null,
      ]),
    );
    record.dawn = observed(() => {
      // Match packages/dawn-node/src/index.mjs Linux provider resolution without importing/creating it.
      const entry = join(root, 'packages/dawn-node/src/index.mjs');
      const require = createRequire(entry);
      const provider = require.resolve('upstream-webgpu');
      const manifest = require.resolve('upstream-webgpu/package.json');
      return {
        route: 'packages/dawn-node/src/index.mjs -> upstream-webgpu (Linux)',
        entry: fileIdentity(entry),
        provider: fileIdentity(provider),
        package: {
          ...fileIdentity(manifest),
          version: JSON.parse(readFileSync(manifest, 'utf8')).version,
        },
        binary: fileIdentity(
          join(dirname(provider), 'dist', `${process.platform}-${process.arch}.dawn.node`),
        ),
      };
    });
    record.mesaPackages = observed(() =>
      query('dpkg-query', [
        '-W',
        '-f',
        `\${Package}=\${Version}\\n`,
        'mesa-vulkan-drivers',
        'libgl1-mesa-dri',
        'libvulkan1',
      ]).split('\n'),
    );
    record.lavapipeIcd = observed(() =>
      readdirSync('/usr/share/vulkan/icd.d')
        .filter((name) => /^lvp_icd.*\.json$/.test(name))
        .map((name) => {
          const file = join('/usr/share/vulkan/icd.d', name);
          const descriptor = JSON.parse(readFileSync(file, 'utf8'));
          return {
            ...fileIdentity(file),
            apiVersion: descriptor.ICD?.api_version ?? null,
            libraryPath: descriptor.ICD?.library_path ?? null,
          };
        }),
    );
  }
  process.stdout.write(`[dawn-environment] ${JSON.stringify(record)}\n`);
}
