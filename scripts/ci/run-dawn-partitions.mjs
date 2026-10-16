#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAWN_ISOLATED_GROUPS } from './dawn-gate-roster.mjs';
import { runBrowserCommand } from './run-browser-gate-with-retry.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const VITEST = resolve(ROOT, 'node_modules/vitest/vitest.mjs');

// Lavapipe retained over 12 GiB while compiling all 19 feature combinations
// in one native instance, even after explicit device destruction. Bound that
// instance lifetime without removing any combination or changing its shader.
export const DAWN_TEST_PARTITIONS = {
  transmission: [
    {
      // Six renderers fit below the existing eight-renderer budget group;
      // share its manifest import without combining the heavy feature sweeps.
      pattern:
        'completes a 60-frame transmission stream|uses linear HDR observation|samples the backdrop where the refracted ray exits',
      count: 3,
    },
    { pattern: 'keeps IOR, thickness, and roughness', count: 1 },
    { pattern: 'exercises both Standard render paths', count: 1 },
    {
      // Each process pays the full shader-manifest import; the budget cases
      // are light enough to share one native instance.
      pattern:
        'submits a real clustered local-light frame|refracts through the shared-slot variant|reports and falls back when a split scalar map',
      count: 3,
    },
  ],
  'feature-depth': [
    { pattern: 'samples depth written by a vertex-only prepared graphics pass', count: 1 },
    ...['billboard-material', 'topology-segment-material', 'mesh-geometry-material'].map(
      (pattern) => ({ pattern, count: 6 }),
    ),
  ],
  'vfx-depth': [
    ...['billboard', 'ribbon', 'trail', 'beam'].map((pattern) => ({ pattern, count: 5 })),
    { pattern: 'mesh|Player MeshFilter', count: 6 },
  ],
  // Each falsifier owns four fresh renderers. The standalone A/B and equal
  // control assertions were removed because these falsifiers contain those
  // exact legs in the same test. Keep every distinct render configuration and
  // its destructive control without paying for the duplicate captures.
  'shadow-fields': [
    {
      pattern:
        'requires accepted production candidate|requires the same bounded Directional inspection|composed default-standard-pbr WGSL|View UBO slots|pcf5 maps|validate\\(\\) accepts|pixel A/B: castShadow|castShadow=false emits|pixel A/B: mapSize',
      count: 9,
    },
    { pattern: 'falsification: depthBias|falsification: normalBias', count: 2 },
    { pattern: 'falsification: directional filter', count: 1 },
  ],
};

// The reduced cases fit within the original full-suite process size. Share
// native startup instead of retaining one process for every former category.
export const LIGHTWEIGHT_DAWN_TEST_PARTITIONS = {
  ...DAWN_TEST_PARTITIONS,
  'feature-depth': [
    { pattern: 'samples depth written|billboard-material', count: 3 },
    { pattern: 'topology-segment-material|mesh-geometry-material', count: 4 },
  ],
  'vfx-depth': [
    { pattern: 'billboard|ribbon', count: 4 },
    { pattern: 'trail|beam', count: 4 },
    { pattern: 'mesh|Player MeshFilter', count: 3 },
  ],
};

export function selectDawnTestPartitions(kind, env = process.env) {
  return env.FORGEAX_DAWN_LIGHTWEIGHT === '1'
    ? LIGHTWEIGHT_DAWN_TEST_PARTITIONS[kind]
    : DAWN_TEST_PARTITIONS[kind];
}

export function validateDawnPartitionReport(report, partitions, partition, covered) {
  if (report?.success !== true) throw new Error('dawn-partitions report did not declare success');
  const assertions = report.testResults?.flatMap((suite) => suite.assertionResults ?? []) ?? [];
  const total = partitions.reduce((sum, entry) => sum + entry.count, 0);
  const names = assertions.map((assertion) => assertion.fullName);
  if (
    assertions.length !== total ||
    names.some((name) => typeof name !== 'string' || name.length === 0) ||
    new Set(names).size !== total
  )
    throw new Error(`dawn-partitions assertion roster changed; expected ${total} unique tests`);
  const pattern = new RegExp(partition.pattern);
  const selected = assertions.filter((assertion) => pattern.test(assertion.fullName));
  if (selected.length !== partition.count)
    throw new Error(
      `dawn-partitions partition ${partition.pattern} expected ${partition.count} tests`,
    );
  for (const assertion of assertions) {
    const matches = pattern.test(assertion.fullName);
    if (assertion.status !== (matches ? 'passed' : 'skipped'))
      throw new Error(
        `dawn-partitions unexpected result: ${assertion.fullName} ${assertion.status}`,
      );
    if (matches) {
      if (covered.has(assertion.fullName))
        throw new Error(`dawn-partitions duplicate execution: ${assertion.fullName}`);
      covered.add(assertion.fullName);
    }
  }
  return total;
}

// A Smoke owner selects whole existing native partitions, never individual tests.
export function selectTransmissionSmokeOwner(features, owner) {
  const canonical = { pattern: 'emits the canonical 60-frame Dawn roster receipt', count: 1 };
  const middle = Math.ceil(features.length / 2);
  switch (owner) {
    case undefined:
      return [...features, canonical];
    case 'features-a':
      return features.slice(0, middle);
    case 'features-b':
      return features.slice(middle);
    case 'frames':
      return [canonical];
    default:
      throw new Error(`unknown transmission Smoke owner: ${owner}`);
  }
}

export async function runDawnPartitions(kind, { env = process.env, smokeOwner } = {}) {
  const configuredPartitions = selectDawnTestPartitions(kind, env);
  const transmissionSmoke = kind === 'transmission' && env.FORGEAX_DAWN_ROSTER_SMOKE === '1';
  const roster = transmissionSmoke
    ? selectTransmissionSmokeOwner(configuredPartitions)
    : configuredPartitions;
  if (smokeOwner !== undefined && !transmissionSmoke)
    throw new Error('Smoke owner requires the complete transmission declaration');
  const partitions = transmissionSmoke
    ? selectTransmissionSmokeOwner(configuredPartitions, smokeOwner)
    : roster;
  const group = DAWN_ISOLATED_GROUPS.find((candidate) => candidate.id === kind);
  if (!partitions || !group || group.files.length !== 1)
    throw new Error(`unknown dawn-partitions group: ${kind}`);
  const temporary = mkdtempSync(join(tmpdir(), 'forgeax-dawn-partitions-'));
  const covered = new Set();
  const total = partitions.reduce((sum, partition) => sum + partition.count, 0);
  try {
    for (const [index, partition] of partitions.entries()) {
      const reportPath = join(temporary, `${index}.json`);
      const result = await runBrowserCommand(
        [
          process.execPath,
          VITEST,
          'run',
          '--project=dawn',
          '--passWithNoTests=false',
          '--maxWorkers=1',
          '--no-file-parallelism',
          // A timed-out async GPU test can still be submitting frames. An
          // in-process retry would overlap its device and global adapter hooks.
          '--retry=0',
          '--bail=1',
          '--reporter=default',
          '--reporter=json',
          '--outputFile',
          reportPath,
          '--testNamePattern',
          partition.pattern,
          ...group.files,
        ],
        {
          cwd: ROOT,
          env: { ...env, FORGEAX_DAWN_ISOLATED: '1' },
          // Shadow falsifiers retain their 300-second test budget; allow the
          // process enough additional time to import and close normally.
          timeoutMs: 6 * 60_000,
          label: `${kind} ${partition.pattern}`,
          gpuLease: true,
        },
      );
      if (result.status !== 0) return result.status;
      validateDawnPartitionReport(
        JSON.parse(readFileSync(reportPath, 'utf8')),
        roster,
        partition,
        covered,
      );
    }
    if (covered.size !== total)
      throw new Error(`dawn-partitions incomplete coverage ${covered.size}/${total}`);
    console.log(
      `[dawn-partitions] PASS kind=${kind} assertions=${covered.size} partitions=${partitions.length}`,
    );
    return 0;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runDawnPartitions(process.argv[2]);
}
