// Run app typecheck with machine-adaptive concurrency.
// Each app's `typecheck` is a cold `tsc --noEmit` (~1.5GB peak, no incremental
// reuse), so `pnpm --parallel` (unbounded) thrashes swap on low-RAM machines.
// Pick a concurrency that fits both core count and a conservative RAM budget.

import { spawnSync } from 'node:child_process';
import { pnpmCommand } from './lib/pnpm-command.mjs';
import { runnerResources, workspaceConcurrency } from './lib/runner-resources.mjs';

const { cpus, memoryBytes, containerized } = runnerResources();
const totalGB = Math.ceil(memoryBytes / 1024 ** 3);

// Use cgroup quota for CPU containers; direct CVM runners retain their host
// resource values.
const auto = workspaceConcurrency({ cpus, memoryBytes, reserveGB: 2, workerGB: 2 });

// Explicit override wins, e.g. FORGEAX_TYPECHECK_CONCURRENCY=1 on a busy laptop.
const n = process.env.FORGEAX_TYPECHECK_CONCURRENCY ?? String(auto);

console.error(
  `[typecheck] ${totalGB.toFixed(0)}GB / ${cpus} cpu (${containerized ? 'cgroup' : 'host'}) -> --workspace-concurrency=${n}`,
);

const [manager, ...managerArgs] = pnpmCommand();
const r = spawnSync(
  manager,
  [
    ...managerArgs,
    '-r',
    '--filter',
    './apps/**',
    `--workspace-concurrency=${n}`,
    '--no-sort',
    'run',
    'typecheck',
  ],
  { stdio: 'inherit', shell: false },
);

process.exit(r.status ?? 1);
