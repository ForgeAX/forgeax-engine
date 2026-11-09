import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBrowserCommand } from './run-browser-gate-with-retry.mjs';
import { compatibilityPhases } from './webgpu-compatibility-plan.mjs';

const carrier = process.env.FORGEAX_COMPAT_BROWSER ?? 'stable';
const phases = compatibilityPhases(carrier);
const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourceDirty =
  execFileSync(
    'git',
    ['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=all'],
    { encoding: 'utf8' },
  ).trim().length > 0;
const budgetMs = 600_000;
let executionMs = 0;
for (const phase of phases) {
  const config =
    phase === 'scene'
      ? 'config/vitest.webgpu-scene.config.ts'
      : 'config/vitest.webgpu-compatibility.config.ts';
  const remaining = budgetMs - executionMs;
  if (remaining <= 0) throw new Error('Compatibility execution exceeded its ten-minute budget');
  const result = await runBrowserCommand(
    [
      process.execPath,
      'scripts/ci/run-with-runner-cpu-affinity.mjs',
      '--',
      process.execPath,
      'node_modules/vitest/vitest.mjs',
      'run',
      '--config',
      config,
    ],
    {
      env: { ...process.env, FORGEAX_COMPAT_PHASE: phase },
      label: `compatibility-${carrier}-${phase}`,
      timeoutMs: Math.min(240_000, remaining),
      gpuLease: true,
      excludeGpuLeaseQueue: true,
    },
  );
  const queueMs = result.gpuQueueMs ?? result.excludedGpuQueueMs ?? 0;
  executionMs += result.gpuExecutionMs ?? result.elapsedMs - (result.excludedGpuQueueMs ?? 0);
  const receipt = {
    kind: 'compatibility-phase',
    source,
    sourceDirty,
    carrier,
    phase,
    status: result.status,
    elapsedMs: result.elapsedMs,
    queueMs,
    executionMs,
  };
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `\nCompatibility phase: \`${JSON.stringify(receipt)}\`\n`,
    );
  if (result.status !== 0) {
    const evidence = join('artifacts/webgpu-compatibility', carrier);
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, `${phase}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
    writeFileSync(join(evidence, `${phase}.log`), result.output.slice(-1_000_000));
    process.exitCode = result.status;
    break;
  }
}
