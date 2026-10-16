#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runnerResources, shaderCompileWorkers } from '../lib/runner-resources.mjs';

const capacityPools = {
  standard: { vcpus: 4, memoryGiB: 8 },
  heavy: { vcpus: 8, memoryGiB: 16 },
};

export function assessRunnerPoolCapacity(pool, resources) {
  const expected = capacityPools[pool];
  if (expected === undefined) {
    return {
      ok: false,
      code: 'ci-runner-pool-unknown',
      expected: Object.keys(capacityPools),
      actual: pool,
      hint: 'Use the standard or heavy runner pool.',
    };
  }
  const actual = {
    vcpus: resources.cpus,
    memoryBytes: resources.memoryBytes,
    source: resources.containerized ? 'cgroup' : 'host',
  };
  const minimum = {
    vcpus: expected.vcpus,
    memoryBytes: expected.memoryGiB * 1_000_000_000,
  };
  if (actual.vcpus < minimum.vcpus || actual.memoryBytes < minimum.memoryBytes) {
    return {
      ok: false,
      code: 'ci-runner-pool-capacity-mismatch',
      pool,
      expected: minimum,
      actual,
      hint: `Remove the ${pool} label from this runner or repair its container quota before retrying.`,
    };
  }
  return { ok: true, pool, expected: minimum, actual };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function main() {
  const pool = argument('--pool');
  const resources = runnerResources();
  const result = assessRunnerPoolCapacity(pool, resources);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
  else if (process.env.GITHUB_ENV) {
    // All later Vite/SDK/Browser children share the admitted container budget.
    const workers = shaderCompileWorkers(resources, process.env.FORGEAX_SHADER_COMPILE_WORKERS);
    appendFileSync(process.env.GITHUB_ENV, `FORGEAX_SHADER_COMPILE_WORKERS=${workers}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
