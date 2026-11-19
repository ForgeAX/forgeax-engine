import { spawnSync } from 'node:child_process';
import { getHeapStatistics } from 'node:v8';
import {
  runnerResources,
  shaderProducerHeapSize,
  shaderSourceCompileWorkers,
} from './runner-resources.mjs';

/** Admit a cold source producer before loading the compiler or its worker pool. */
export function admitShaderSourceBudget({ workerBudget = shaderSourceCompileWorkers } = {}) {
  const resources = runnerResources();
  const policyHeapMiB = shaderProducerHeapSize(resources);
  // A parent's explicit Node argument is an intentional producer budget.
  // Ambient NODE_OPTIONS often belongs to the lighter orchestration process.
  const explicitHeap = process.execArgv
    .join(' ')
    .match(/--max[-_]old[-_]space[-_]size(?:=|\s+)(\d+)/g)
    ?.at(-1)
    ?.match(/(\d+)$/)?.[1];
  const heapMiB = Math.min(policyHeapMiB, Number(explicitHeap ?? policyHeapMiB));
  const currentHeapMiB = getHeapStatistics().heap_size_limit / 1024 ** 2;
  if (
    Number(explicitHeap) === heapMiB ||
    (explicitHeap === undefined && currentHeapMiB >= heapMiB && currentHeapMiB < heapMiB + 512)
  ) {
    if (workerBudget !== null) {
      const workers = workerBudget(resources, process.env.FORGEAX_SHADER_COMPILE_WORKERS, heapMiB);
      process.env.FORGEAX_SHADER_COMPILE_WORKERS = String(workers);
      console.log(`[shared-build] source budget: heap=${heapMiB} MiB workers=${workers}`);
    }
    return;
  }
  const result = spawnSync(
    process.execPath,
    [
      ...process.execArgv.filter(
        (argument) => !/^--max[-_]old[-_]space[-_]size(?:=|$)/.test(argument),
      ),
      `--max-old-space-size=${heapMiB}`,
      ...process.argv.slice(1),
    ],
    { cwd: process.cwd(), env: process.env, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Source shader compiler exited by ${result.signal}`);
  process.exit(result.status ?? 1);
}
