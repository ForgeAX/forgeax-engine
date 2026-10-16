#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAWN_GATE_GROUPS, DAWN_GATE_SHARDS } from './dawn-gate-roster.mjs';
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

export function dawnVitestArgs(group) {
  return [
    VITEST,
    'run',
    '--project=dawn',
    group.vitestShard === undefined ? '--passWithNoTests=false' : '--passWithNoTests=true',
    '--maxWorkers=1',
    '--no-file-parallelism',
    group.isolate === false ? '--no-isolate' : '--isolate',
    ...(group.isolate === false ? ['--retry=0', '--bail=1'] : []),
    ...(group.vitestShard === undefined ? [] : [`--shard=${group.vitestShard}`]),
    ...group.files,
  ];
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
  return DAWN_GATE_GROUPS.filter((group) => ids.has(group.id));
}

export async function runDawnGate({ group: selectedGroup, shard } = {}) {
  validateDawnGateRoster();
  // A full gate must not inherit a selector from a preceding single-owner probe.
  const environment = { ...process.env };
  for (const name of [
    'FORGEAX_DAWN_ISOLATED',
    'FORGEAX_DAWN_COMPACT',
    'FORGEAX_DAWN_PARTITION',
    'FORGEAX_DAWN_PARTITION_SCOPE',
  ])
    delete environment[name];
  const groups = selectDawnGroups(selectedGroup, shard);
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
  for (const group of groups) {
    console.log(`::group::Dawn ${group.id}`);
    try {
      const env = { ...environment, ...group.env };
      if (Object.hasOwn(DAWN_TEST_PARTITIONS, group.id)) {
        const status = await runDawnPartitions(group.id, { env });
        if (status !== 0) return status;
      } else if (group.id === 'direct-light') {
        await runDirectLightDawn({ env });
      } else {
        const run = () =>
          runBrowserCommand([process.execPath, ...dawnVitestArgs(group)], {
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
        if (result.status !== 0) return result.status;
      }
    } finally {
      console.log('::endgroup::');
    }
  }
  console.log(
    `[dawn-gate] ${selectedGroup ? 'DIAGNOSTIC PASS' : 'PASS'} groups=${groups.length}${shard ? ` shard=${shard}` : ''}`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let group;
  let shard;
  let dryRun = false;
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--dry-run') dryRun = true;
    else if (process.argv[i] === '--group' && process.argv[i + 1]) group = process.argv[++i];
    else if (process.argv[i] === '--shard' && process.argv[i + 1]) shard = process.argv[++i];
    else throw new Error('usage: run-dawn-gate.mjs [--dry-run] [--group ID | --shard INDEX/TOTAL]');
  }
  const groups = selectDawnGroups(group, shard);
  if (dryRun) {
    validateDawnGateRoster();
    console.log(JSON.stringify(groups));
  } else process.exitCode = await runDawnGate({ group, shard });
}
