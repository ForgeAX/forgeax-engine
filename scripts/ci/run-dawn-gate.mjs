#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dawnOrdinaryWorkers } from '../lib/runner-resources.mjs';
import { coreValidationFiles } from './core-validation.mjs';
import { reportDawnEnvironment } from './dawn-environment-diagnostics.mjs';
import { DAWN_GATE_GROUPS, DAWN_GATE_SHARDS, DAWN_VITEST_CONFIG } from './dawn-gate-roster.mjs';
import { isRetryableOutput, runBrowserCommand } from './run-browser-gate-with-retry.mjs';
import { DAWN_TEST_PARTITIONS, runDawnPartitions } from './run-dawn-partitions.mjs';
import { runDirectLightDawn } from './run-direct-light-dawn.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const VITEST = resolve(ROOT, 'node_modules/vitest/vitest.mjs');

export function validateDawnGateRoster(root = ROOT) {
  const ids = DAWN_GATE_SHARDS.flat();
  if (
    ids.length !== DAWN_GATE_GROUPS.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !DAWN_GATE_GROUPS.some((group) => group.id === id))
  )
    throw new Error('each Dawn group must belong to exactly one configured lane');
  const owners = new Map();
  for (const group of DAWN_GATE_GROUPS) {
    if (group.vitestShard === undefined && group.files.length === 0) {
      throw new Error(`Dawn group ${group.id} is empty`);
    }
    for (const file of group.files) {
      if (!existsSync(resolve(root, file))) throw new Error(`missing Dawn file: ${file}`);
      if (owners.has(file)) {
        throw new Error(`Dawn file ${file} belongs to both ${owners.get(file)} and ${group.id}`);
      }
      owners.set(file, group.id);
    }
  }
  return owners;
}

export function dawnVitestArgs(group, { ordinaryWorkers = 1 } = {}) {
  if (ordinaryWorkers !== 1 && ordinaryWorkers !== 2) {
    throw new Error('Dawn ordinary workers must be exactly 1 or 2');
  }
  const parallel = group.vitestShard !== undefined && ordinaryWorkers === 2;
  return [
    VITEST,
    'run',
    '--config',
    DAWN_VITEST_CONFIG,
    '--project=dawn',
    group.vitestShard === undefined ? '--passWithNoTests=false' : '--passWithNoTests=true',
    `--maxWorkers=${parallel ? 2 : 1}`,
    ...(parallel ? ['--pool=forks', '--fileParallelism=true'] : ['--no-file-parallelism']),
    group.isolate === false ? '--no-isolate' : '--isolate',
    ...(group.isolate === false ? ['--retry=0', '--bail=1'] : []),
    ...(group.vitestShard === undefined ? [] : [`--shard=${group.vitestShard}`]),
    ...group.files,
  ];
}

export function dawnNativeConcurrency(environment, ordinaryWorkers) {
  return ordinaryWorkers === 2 &&
    environment.FORGEAX_CI_CORE_VALIDATION === '1' &&
    environment.FORGEAX_DAWN_LIGHTWEIGHT === '1'
    ? 2
    : 1;
}

export function dawnNativeExecutionOrder(groups, forecasts) {
  const native = groups.filter((group) => group.vitestShard === undefined);
  const priority = (group) =>
    Math.max(forecasts.get(group.id) ?? 0, group.placementReserveSeconds ?? 0);
  return [
    ...native.slice(0, 2),
    ...native.slice(2).sort((left, right) => priority(right) - priority(left)),
    ...groups.filter((group) => group.vitestShard !== undefined),
  ];
}

async function dawnCapacityGroups(groups, nativeConcurrency, environment) {
  if (nativeConcurrency === 1) return groups;
  const { dawnPlanningOwnerCosts } = await import('../../config/dawn-timings.ts');
  return dawnNativeExecutionOrder(groups, dawnPlanningOwnerCosts(environment));
}

// Unmeasured native owners keep both slots. The ordinary invocation already
// owns two workers, so it starts only after every native process has drained.
export async function executeDawnGroups(
  groups,
  runGroup,
  { nativeConcurrency = 1, continueOnFailure = false } = {},
) {
  if (nativeConcurrency !== 1 && nativeConcurrency !== 2)
    throw new Error('Dawn native concurrency must be exactly 1 or 2');
  if (
    groups.some(
      (group) =>
        group.nativeProcessSlots !== undefined &&
        group.nativeProcessSlots !== 1 &&
        group.nativeProcessSlots !== 2,
    )
  )
    throw new Error('Dawn native slots must be exactly 1 or 2');
  const failures = [];
  const run = async (group) => {
    try {
      await runGroup(group);
    } catch (error) {
      failures.push({ group: group.id, error });
    }
  };
  const stopped = () => failures.length > 0 && !continueOnFailure;
  if (nativeConcurrency === 1) {
    for (const group of groups) {
      if (stopped()) break;
      await run(group);
    }
    return failures;
  }
  const active = new Set();
  for (const group of groups.filter((entry) => entry.vitestShard === undefined)) {
    const slots = group.nativeProcessSlots ?? 2;
    if (slots === 2) {
      await Promise.all(active);
      if (stopped()) break;
      await run(group);
    } else {
      if (active.size === 2) await Promise.race(active);
      if (stopped()) break;
      const task = run(group).finally(() => active.delete(task));
      active.add(task);
    }
  }
  await Promise.all(active);
  for (const group of groups.filter((entry) => entry.vitestShard !== undefined)) {
    if (stopped()) break;
    await run(group);
  }
  return failures;
}

export function dawnGroupEnvironment(group, environment, ordinaryWorkers, nativeConcurrency = 1) {
  const rasterThreads = Number(environment.LP_NUM_THREADS);
  return {
    ...environment,
    ...group.env,
    ...(group.vitestShard !== undefined && ordinaryWorkers === 2
      ? { LP_NUM_THREADS: '4', FORGEAX_SHADER_COMPILE_WORKERS: '1' }
      : {}),
    ...(nativeConcurrency === 2 && group.nativeProcessSlots === 1
      ? {
          LP_NUM_THREADS: String(
            Number.isInteger(rasterThreads) && rasterThreads > 0 ? Math.min(4, rasterThreads) : 4,
          ),
          FORGEAX_SHADER_COMPILE_WORKERS: '1',
        }
      : {}),
  };
}

export function selectDawnGroups(id, shard) {
  if (id !== undefined && shard !== undefined) {
    throw new Error('Dawn group and shard selectors are mutually exclusive');
  }
  if (shard !== undefined) return selectDawnShard(shard);
  if (id === undefined) return DAWN_GATE_GROUPS;
  const group = DAWN_GATE_GROUPS.find((candidate) => candidate.id === id);
  if (!group) throw new Error(`unknown Dawn group: ${id}`);
  return [group];
}

export function selectDawnShard(value) {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? '');
  if (match === null) throw new Error('Dawn shard must use INDEX/TOTAL');
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (total !== DAWN_GATE_SHARDS.length || index < 1 || index > total) {
    throw new Error(
      `Dawn shard ${value} is outside the configured ${DAWN_GATE_SHARDS.length} lanes`,
    );
  }
  const ids = new Set(DAWN_GATE_SHARDS[index - 1]);
  return DAWN_GATE_GROUPS.filter((group) => ids.has(group.id)).sort(
    // Long Modeling captures retain first start when a larger reserved native
    // owner shares their lane; every other reservation still precedes backfill.
    (left, right) =>
      Number(right.id.startsWith('modeling-')) - Number(left.id.startsWith('modeling-')) ||
      (right.placementReserveSeconds ?? 0) - (left.placementReserveSeconds ?? 0),
  );
}

function dawnExecutionEnvironment(id, environment) {
  return id === undefined ? environment : { ...environment, FORGEAX_CI_CORE_VALIDATION: '0' };
}

export function dawnExecutionGroups(id, shard, environment = process.env) {
  const selectionEnvironment = dawnExecutionEnvironment(id, environment);
  return selectDawnGroups(id, shard)
    .map((group) => ({ ...group, files: coreValidationFiles(group.files, selectionEnvironment) }))
    .filter((group) => group.vitestShard !== undefined || group.files.length > 0);
}

export async function runDawnGate({ group: selectedGroup, shard, continueOnFailure = false } = {}) {
  validateDawnGateRoster();
  const environmentDiagnostics = shard === '3/4';
  if (environmentDiagnostics) reportDawnEnvironment(ROOT, 'start', true);
  // A full gate must not inherit a selector from a preceding single-owner probe.
  const prepareDawnGateEnvironment = () => {
    const environment = { ...process.env };
    for (const name of [
      'FORGEAX_DAWN_ISOLATED',
      'FORGEAX_DAWN_COMPACT',
      'FORGEAX_DAWN_PARTITION',
      'FORGEAX_DAWN_PARTITION_SCOPE',
    ])
      delete environment[name];
    return environment;
  };
  const environment = dawnExecutionEnvironment(selectedGroup, prepareDawnGateEnvironment());
  const groups = dawnExecutionGroups(selectedGroup, shard, environment);
  const ordinaryWorkers = groups.some((group) => group.vitestShard !== undefined)
    ? dawnOrdinaryWorkers(environment)
    : 1;
  const nativeConcurrency = dawnNativeConcurrency(environment, ordinaryWorkers);
  if (!environmentDiagnostics && nativeConcurrency === 2)
    reportDawnEnvironment(ROOT, 'start', true);
  if (environment.FORGEAX_SHARED_APP_INPUTS_MANIFEST) {
    const prepared = await runBrowserCommand(
      [
        process.execPath,
        'scripts/forgeax/prepare-shader-release-inputs.mjs',
        '--build',
        // Only the renderer's disabled-shadow control needs a separate base
        // fleet. Other lanes consume the shared point projection unchanged.
        ...(groups.some(({ id }) => id === 'renderer') ? [] : ['--profile', 'point-ssao']),
        '--input',
        'node_modules/.cache/forgeax-build/dawn-shaders',
        '--shared-input-manifest',
        environment.FORGEAX_SHARED_APP_INPUTS_MANIFEST,
      ],
      { cwd: ROOT, env: environment, label: 'Dawn shader profile producer' },
    );
    if (prepared.status !== 0)
      throw new Error(`Dawn shader preparation failed; ${prepared.failure}`);
  }
  const failures = await executeDawnGroups(
    await dawnCapacityGroups(groups, nativeConcurrency, environment),
    async (group) => {
      const started = performance.now();
      let status = 0;
      const env = dawnGroupEnvironment(group, environment, ordinaryWorkers, nativeConcurrency);
      if (nativeConcurrency === 1) console.log(`::group::Dawn ${group.id}`);
      else
        console.log(
          `[dawn-group-start] ${JSON.stringify({ id: group.id, nativeConcurrency, slots: group.vitestShard === undefined ? (group.nativeProcessSlots ?? 2) : 2, rasterThreads: env.LP_NUM_THREADS ?? null, shaderCompileWorkers: env.FORGEAX_SHADER_COMPILE_WORKERS ?? null })}`,
        );
      try {
        if (Object.hasOwn(DAWN_TEST_PARTITIONS, group.id)) {
          const status = await runDawnPartitions(group.id, { env });
          if (status !== 0) {
            throw Object.assign(new Error(`Dawn ${group.id} exited ${status}`), {
              exitCode: status,
            });
          }
        } else if (group.id === 'direct-light') {
          await runDirectLightDawn({ env });
        } else {
          const run = () =>
            runBrowserCommand([process.execPath, ...dawnVitestArgs(group, { ordinaryWorkers })], {
              cwd: ROOT,
              env,
              label: `Dawn ${group.id}`,
              gpuLease: true,
              ...(group.isolate === false ? { timeoutMs: 6 * 60_000 } : {}),
            });
          let result = await run();
          if (
            result.status !== 0 &&
            !result.cancelled &&
            group.retryMode &&
            isRetryableOutput(group.retryMode, result.output)
          ) {
            console.warn(
              `::warning::Dawn ${group.id} matched a retry signature; retrying once in a fresh process`,
            );
            result = await run();
          }
          if (result.status !== 0) {
            throw Object.assign(
              new Error(`Dawn ${group.id} exited ${result.status}; ${result.failure}`),
              { exitCode: result.status ?? 1 },
            );
          }
        }
      } catch (error) {
        status = 1;
        throw error;
      } finally {
        if (environmentDiagnostics) reportDawnEnvironment(ROOT, `after:${group.id}`);
        console.log(
          `[dawn-group-result] ${JSON.stringify({ id: group.id, status, elapsedMs: performance.now() - started, nativeConcurrency, files: group.files })}`,
        );
        if (nativeConcurrency === 1) console.log('::endgroup::');
      }
    },
    { nativeConcurrency, continueOnFailure },
  );
  for (const failure of failures)
    console.error(
      `[dawn-failure-batch] ${JSON.stringify({ group: failure.group, error: String(failure.error) })}`,
    );
  const completeDawnGateResult = () => {
    if (failures.length) return continueOnFailure ? 1 : (failures[0].error.exitCode ?? 1);
    console.log(
      `[dawn-gate] ${selectedGroup ? 'DIAGNOSTIC PASS' : 'PASS'} groups=${groups.length}${shard ? ` shard=${shard}` : ''}`,
    );
    return 0;
  };
  return completeDawnGateResult();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let group;
  let shard;
  let dryRun = false;
  let continueOnFailure = false;
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--dry-run') dryRun = true;
    else if (process.argv[i] === '--continue-on-failure') continueOnFailure = true;
    else if (process.argv[i] === '--group' && process.argv[i + 1]) group = process.argv[++i];
    else if (process.argv[i] === '--shard' && process.argv[i + 1]) shard = process.argv[++i];
    else throw new Error('usage: run-dawn-gate.mjs [--dry-run] [--group ID | --shard INDEX/TOTAL]');
  }
  const groups = dawnExecutionGroups(group, shard);
  if (dryRun) {
    validateDawnGateRoster();
    console.log(JSON.stringify(groups));
  } else process.exitCode = await runDawnGate({ group, shard, continueOnFailure });
}
