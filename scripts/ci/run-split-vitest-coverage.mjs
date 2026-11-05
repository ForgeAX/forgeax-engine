#!/usr/bin/env node

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runGroups } from '../lib/run-bounded-groups.mjs';
import {
  coverageGroupConcurrency,
  runnerResources,
  shaderCompileWorkers,
} from '../lib/runner-resources.mjs';
import completedCoverage from './coverage-completed-child-seconds.json' with { type: 'json' };
import { withLocalGpuLease } from './local-gpu-lease.mjs';
import modelingTimings from './modeling-coverage-file-seconds.json' with { type: 'json' };

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '../..');
const defaultGroupSize = 4;
const defaultMaxWorkers = 1;
const maxGroupConcurrency = 3;
const maxChildOutputBytes = 64 * 1024 * 1024;
const completedCoverageAssignmentCache = new Map();
const completedCoverageSearchRestarts = 12;
const completedCoverageSearchIterations = 30_000;
// The required coverage-perf job owns these complete runtime CPU-budget cases.
const uninstrumentedPerformanceFiles = ['packages/modeling/src/__tests__/perf-tiers.unit.test.ts'];
const serialCoveragePreflights = [
  {
    project: '@forgeax/engine-render',
    file: 'packages/render/src/__tests__/docs-gate-green.unit.test.ts',
  },
  {
    project: '@forgeax/engine-runtime',
    file: 'packages/runtime/src/__tests__/surface-fixture-types.unit.test.ts',
  },
];
// Keep projects whose tests launch expensive filesystem, browser, or native
// carriers out of shared coverage children. The devkit authoring suite scans
// the canonical game template and can cross the ordinary 5 s Vitest budget
// when it shares a child with three other package projects. Render and Vite Pack
// also need independent placement: their broad groups took 820 s and 543 s in
// run 38313136540, stranding the other shards behind unrelated package imports.
const isolatedChildProjects = new Set([
  '@forgeax/engine-devkit',
  '@forgeax/engine-render',
  '@forgeax/engine-vite-plugin-pack',
  '@forgeax/engine-rhi-wgpu',
  '@forgeax/engine-runtime',
]);
// Run 41202344079 left two eight-partition lanes at the 45-minute job bound,
// while the other complete lanes finished in 19/32 minutes. Finer native
// partitions distribute the same file roster across four bounded jobs without
// adding workers. The new-child weight is a placement estimate, not a timing
// sample from a failed or interrupted child; complete CI owns runtime acceptance.
// The reservation now derives from the complete current file forecast (rounded
// to five seconds per balanced partition), replacing the original 1,000 s estimate.
// DevKit and Render reservations divide complete successful project receipts;
// these new half-project owners remain estimates until complete CI qualifies them.
// Run 41484231132 retains full Modeling file costs and completed DevKit/Render
// half-child costs. Run 41509066300 refreshes all sixteen complete Modeling
// children; interrupted Render/DevKit children supply no timing observation.
// Complete children from 41521687966, 41529906892 and 41541125949 raise only
// their own partition forecasts. Values round up to seconds, then five seconds
// at placement; every larger inherited reservation remains intact.
// Run 41587190083 completes all Modeling children and Render half two (1187.54 s).
// Keep the file partition unchanged; interrupted neighbors supply no new sample.
// Run 41691406870 completes all sixteen Modeling partitions but reaches the
// unchanged job bound before lane four drains its last groups. Refresh only
// completed group observations; Modeling shard 10 raises its retained bound.
const modelingPartitions = 16;
const projectPartitions = new Map([
  [
    '@forgeax/engine-modeling',
    {
      count: modelingPartitions,
      weight: 945,
    },
  ],
  ['@forgeax/engine-devkit', { count: 2, weight: 685, coverageOnly: true }],
  ['@forgeax/engine-render', { count: 2, weight: 755, coverageOnly: true }],
]);
const devkitNativeUnitFileSets = [
  {
    project: '@forgeax/engine-devkit',
    // CPU preparation precedes the fixture's native-unit-owner GPU admission.
    files: ['packages/devkit/src/__tests__/new-project-workers.e2e.test.ts'],
    weight: 135,
    gpuLease: false,
  },
  {
    project: '@forgeax/engine-devkit',
    // This fixture uses WebGPU directly, so its child owns GPU admission.
    files: ['packages/devkit/src/__tests__/scene-bootstrap.e2e.test.ts'],
    weight: 75,
    gpuLease: true,
  },
];
// Complete native child costs use the same two completed runs as ordinary projects.
const devkitNativeUnitFiles = devkitNativeUnitFileSets.flatMap(({ files }) => files);
// Test files whose single-file cost dominates their project's coverage child.
// Each set runs in its own child and every other child of the same project
// excludes it, so the file is instrumented exactly once while the rest of the
// project no longer queues behind it. Weights are median complete child seconds
// from CI runs 38313136540 and 38316658619, rounded to five seconds, except
// the explicitly estimated cold-scene additions documented below.
const isolatedCoverageFileSets = [
  {
    // Run 41345505497 crossed the unchanged 60 s mip/gutter oracle beside
    // another coverage child. Preserve all three 1024-square bakes exclusively.
    project: '@forgeax/engine-modeling',
    files: ['packages/modeling/src/__tests__/bake-cage.unit.test.ts'],
    weight: 115,
  },
  {
    // Run 41703381180 crossed the unchanged 30 s fractional-sharpness oracle
    // while ordinary coverage children shared its lane. Preserve the complete
    // six-level brute force and all sharpness samples in an exclusive child.
    project: '@forgeax/engine-modeling',
    files: ['packages/modeling/src/__tests__/subd-crease.unit.test.ts'],
    weight: 60,
  },
  {
    // The same run's three-build bootstrap cases reached 15.094/15.061 s.
    // Drain instrumented neighbors without changing the four bases or budgets.
    project: '@forgeax/engine-devkit',
    files: ['packages/devkit/src/__tests__/execution-bootstrap-cache.integration.test.ts'],
    weight: 75,
  },
  {
    // Run 41208138238 crossed the unchanged cockpit budget beside another
    // instrumented child. The full 21-case file passes alone with V8 coverage.
    // This is an exclusive placement estimate, not a failed-child timing sample.
    project: '@forgeax/engine-modeling',
    files: ['packages/modeling/examples/mech-gt/__tests__/s6c.unit.test.ts'],
    weight: 240,
  },
  {
    // The complete merged-source local command crossed the original 5 s / 30 s
    // bounds under neighboring Runtime work. Both full files pass serially;
    // preserve their workloads and budgets in one exclusive instrumented child.
    project: '@forgeax/engine-render',
    files: [
      'packages/render/src/__tests__/gpu-driven-batch-topology-pbr.unit.test.ts',
      'packages/render/src/__tests__/direct-shadow-preparation.integration.test.ts',
    ],
    weight: 90,
  },
  {
    // Run 40653718555 crossed the unchanged 5 s budget while hashing the
    // complete 30 + 3 MiB source-identity oracle beside platform coverage.
    // Preserve the whole file; this exclusive placement weight is an estimate.
    project: '@forgeax/engine-rhi-webgpu',
    files: ['packages/rhi-webgpu/src/__tests__/pipeline-library.unit.test.ts'],
    weight: 15,
  },
  {
    // Runs 40643748921 and 40646042246 contended cold production cooking and irradiance recovery
    // with instrumented Shader children on eight CPUs. Keep the full files and
    // their 30 s / 5 s deadlines; this is a placement estimate, not a new timing receipt.
    project: '@forgeax/engine-render',
    files: [
      'packages/render/src/__tests__/gpu-driven-production.integration.test.ts',
      'packages/render/src/__tests__/raytracing/probe-global.unit.test.ts',
    ],
    weight: 100,
  },
  {
    // The same run crossed both unchanged 60 s budgets while processing the
    // complete transmission permutation oracle and >256 MiB source identities.
    // Preserve their cardinality and assertions in one exclusive CPU child.
    project: '@forgeax/engine-shader',
    files: [
      'packages/shader/src/__tests__/default-standard-pbr-transmission.unit.test.ts',
      'packages/shader/src/__tests__/material-program.test.ts',
    ],
    weight: 180,
  },
  {
    // Run 39497388005 shared cold 100k World initialization with Render's
    // instrumented child: 5.702 s at the original 5 s deadline. Keep all rows
    // and the same deadline, without competing with another coverage child.
    project: '@forgeax/engine-scene',
    files: ['packages/scene/src/__tests__/flat-propagation.contract.test.ts'],
    weight: 10,
  },
  {
    // The same run's real 50k cold admission/prepare took 8.679 s while the
    // eight-project Scene/compiler child ran beside it (previous run 4.458 s).
    project: '@forgeax/engine-render',
    files: ['packages/render/src/__tests__/managed-production-batches.unit.test.ts'],
    weight: 25,
  },
  {
    // Cold Standard/ray compilation crossed30s in a shared child. Run
    // 40383076780 also exhausted worker parity's 45s subprocess budget beside
    // Render coverage. Keep both complete files and their original deadlines.
    project: '@forgeax/engine-shader-compiler',
    files: [
      'packages/shader-compiler/src/material/__tests__/pack-program-reuse.integration.test.ts',
      'packages/shader-compiler/src/material/__tests__/node-program-compiler.integration.test.ts',
    ],
    weight: 40,
  },
  {
    // Run 40650966486 spent 247.73 s in this file inside the shared Pack child;
    // cold clearcoat cases exceeded their unchanged 30 s deadlines. Drain the
    // neighboring instrumented child before admitting the complete file.
    project: '@forgeax/engine-vite-plugin-pack',
    files: [
      'packages/vite-plugin-pack/src/__tests__/declared-standard-material.integration.test.ts',
    ],
    weight: 250,
  },
  {
    project: '@forgeax/engine-vite-plugin-pack',
    // This consumer owns both the Render factory and the compiler. A fresh
    // observing realm preserves the portable matrix without an upward compiler
    // dependency or unrelated publication state. Placement weight is estimated.
    files: [
      'packages/vite-plugin-pack/src/__tests__/material-program-schema-reuse.integration.test.ts',
    ],
    weight: 40,
  },
  {
    // Repository scans keep their existing deadlines without competing with
    // instrumented imports. Run 37975821189 observed the live StringView scan
    // exceed its unchanged five-second deadline at 6.051 s.
    project: '@forgeax/engine-ecs',
    files: [
      'packages/ecs/src/__tests__/errors.unit.test.ts',
      'packages/ecs/src/__tests__/source-scan.unit.test.ts',
      'packages/ecs/scripts/__tests__/grep-no-string-view-import.test.mjs',
    ],
    weight: 10,
  },
  ...devkitNativeUnitFileSets,
  {
    project: '@forgeax/engine-devkit',
    // Keep the Vite process-owner fixture exclusive without GPU admission.
    files: ['packages/devkit/src/__tests__/live-dev-process.integration.test.ts'],
    weight: 20,
  },
  {
    project: '@forgeax/engine-devkit',
    // Run 41301727815 crossed the existing startup deadline beside instrumented
    // imports. Keep all real HTTP/daemon cases and their original budgets.
    files: ['packages/devkit/src/__tests__/live-dev-client.test.ts'],
    weight: 90,
  },
  {
    project: '@forgeax/engine-devkit',
    // The same run timed out the ordinary App Worker build at 60 s. Its complete
    // file owns CPU preparation; nested native cases retain their own GPU lease.
    // Both new weights are placement estimates, not failed-child timing samples.
    files: ['packages/devkit/src/__tests__/worker-module-identity.integration.test.ts'],
    weight: 120,
  },
  {
    project: '@forgeax/engine-devkit',
    // Two real `project play` runs (Vite runtime + sandboxed Chromium) share one
    // fixture root. Weight is an estimate from two cold-start Vite fixtures,
    // not yet a CI measurement.
    files: ['packages/devkit/src/__tests__/project-play.e2e.test.ts'],
    weight: 120,
  },
  {
    // Run 37342840315 exceeded both 5 s GI fixture budgets while this child
    // shared eight CPUs with DevKit. Keep the real compiler fixtures exclusive;
    // its complete isolated cost is included below.
    project: '@forgeax/engine-render',
    files: [
      'packages/render/src/__tests__/raytracing/diffuse-gi.unit.test.ts',
      'packages/render/src/__tests__/raytracing/gi-view.unit.test.ts',
    ],
    weight: 70,
  },
  {
    project: '@forgeax/engine-vite-plugin-shader',
    files: [
      'packages/vite-plugin-shader/src/__tests__/vite-plugin-shader.unit.test.ts',
      'packages/vite-plugin-shader/src/__tests__/public-surface.unit.test.ts',
      'packages/vite-plugin-shader/src/__tests__/production-resampling-vite.integration.test.ts',
      'packages/vite-plugin-shader/src/__tests__/surface-manifest.integration.test.ts',
      'packages/vite-plugin-shader/src/__tests__/direct-dfg-manifest.integration.test.ts',
    ],
    // Run 41379898912 stranded this source-production owner in a late shared
    // child until the 45-minute job bound. Drain neighboring coverage work and
    // retain all three full source builds with the runner's compiler budget.
    // The added 900 seconds are a placement estimate, not a completed receipt.
    weight: 920,
  },
  {
    project: '@forgeax/engine-pack',
    files: ['packages/pack/src/__tests__/material-surface-publication.unit.test.ts'],
    weight: 20,
  },
];

export function isExclusiveCoverageGroup(group) {
  // Explicit file sets own repository scans, cold compiler or real Browser work. Do not let
  // an unrelated instrumented child consume their CPU/memory headroom.
  return group.files.length > 0;
}
// Current complete project costs from run 41215740814 raise the retained
// medians from CI runs 38313136540 and 38316658619, excluding
// isolated files. Allocate each child's measured import/coverage/cleanup overhead
// equally across its files, then round project totals to five seconds. Small
// projects use the default; report order stays the canonical project order.
const defaultCoverageProjectWeight = 10;
const coverageProjectWeights = new Map([
  ['@forgeax/engine-animation', 75],
  ['@forgeax/engine-app', 220],
  ['@forgeax/engine-assets-runtime', 160],
  ['@forgeax/engine-audio', 15],
  ['@forgeax/engine-audio-webaudio', 20],
  ['@forgeax/engine-codec', 65],
  ['@forgeax/engine-devkit', 1180],
  ['@forgeax/engine-ecs', 55],
  ['@forgeax/engine-fbx', 25],
  ['@forgeax/engine-geometry', 30],
  ['@forgeax/engine-gltf', 65],
  ['@forgeax/engine-image', 20],
  ['@forgeax/engine-import', 55],
  ['@forgeax/engine-input', 35],
  ['@forgeax/engine-math', 30],
  ['@forgeax/engine-net', 40],
  ['@forgeax/engine-net-websocket', 15],
  ['@forgeax/engine-pack', 165],
  ['@forgeax/engine-physics-rapier2d', 15],
  ['@forgeax/engine-physics-rapier3d', 90],
  ['@forgeax/engine-platform-wechat', 30],
  ['@forgeax/engine-preview', 15],
  ['@forgeax/engine-profiler', 15],
  ['@forgeax/engine-render', 1100],
  ['@forgeax/engine-rhi-debug', 40],
  ['@forgeax/engine-runtime', 590],
  ['@forgeax/engine-scene', 20],
  ['@forgeax/engine-shader', 25],
  ['@forgeax/engine-shader-compiler', 300],
  ['@forgeax/engine-three', 35],
  ['@forgeax/engine-tool-runtime', 15],
  ['@forgeax/engine-types', 35],
  ['@forgeax/engine-ui', 15],
  ['@forgeax/engine-ui-blitz', 30],
  ['@forgeax/engine-vfx', 20],
  ['@forgeax/engine-vfx-compiler', 20],
  ['@forgeax/engine-vfx-render', 35],
  // Complete ordinary child in run 41579286478: 383.91 s, including imports.
  ['@forgeax/engine-vite-plugin-pack', 385],
  // The full-project 1120 s forecast included the now-isolated source builds.
  // Their separate 920 s reservation stays intact. Run 41442400305 completes
  // the remaining mixed child in 111.11 s; reserve 120 s for this project alone.
  ['@forgeax/engine-vite-plugin-shader', 120],
]);
// The all-project preflight runs before any coverage child on shard 0.
const typecheckSeconds = 185;
const coverageThresholds = [
  '--coverage.thresholds.lines=0',
  '--coverage.thresholds.functions=0',
  '--coverage.thresholds.branches=0',
  '--coverage.thresholds.statements=0',
];
const reportCounters = [
  'numTotalTestSuites',
  'numPassedTestSuites',
  'numFailedTestSuites',
  'numPendingTestSuites',
  'numTotalTests',
  'numPassedTests',
  'numFailedTests',
  'numPendingTests',
  'numTodoTests',
];

function parsePositiveInt(value, name, { max = Number.POSITIVE_INFINITY } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}, got ${value}`);
  }
  return parsed;
}

export function parseArgs(argv) {
  const valueOptions = new Set([
    '--project',
    '--group-size',
    '--group-concurrency',
    '--max-workers',
    '--coverage-dir',
    '--output-file',
    '--shard-index',
    '--shard-count',
    '--shard-output-dir',
    '--merge-shards',
  ]);
  const options = {
    coverage: true,
    coverageDir: 'coverage',
    dryRun: false,
    groupSize: defaultGroupSize,
    groupConcurrency: 1,
    maxWorkers: defaultMaxWorkers,
    mergeShards: null,
    outputFile: 'vitest-coverage-out.json',
    projects: [],
    shardCount: 1,
    shardIndex: 0,
    shardOutputDir: null,
    typecheck: true,
    vitestArgs: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--non-coverage') {
      options.coverage = false;
      continue;
    } else if (argument === '--skip-typecheck') {
      options.typecheck = false;
      continue;
    } else if (argument === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    const [key, inlineValue] = argument.split('=', 2);
    const value = inlineValue ?? (valueOptions.has(key) ? argv[++index] : undefined);
    if (key === '--project') {
      if (options.coverage) {
        if (!value) throw new Error('--project requires a value');
        options.projects.push(value);
      } else {
        options.vitestArgs.push(argument);
        if (inlineValue === undefined && value !== undefined) options.vitestArgs.push(value);
      }
    } else if (key === '--group-size') {
      options.groupSize = parsePositiveInt(value, '--group-size', { max: 12 });
    } else if (key === '--group-concurrency') {
      options.groupConcurrency =
        value === 'auto'
          ? 'auto'
          : parsePositiveInt(value, '--group-concurrency', { max: maxGroupConcurrency });
    } else if (key === '--max-workers') {
      options.maxWorkers = parsePositiveInt(value, '--max-workers', { max: 6 });
    } else if (key === '--coverage-dir') {
      if (!value) throw new Error('--coverage-dir requires a value');
      options.coverageDir = value;
    } else if (key === '--output-file') {
      if (!value) throw new Error('--output-file requires a value');
      options.outputFile = value;
    } else if (key === '--shard-count') {
      options.shardCount = parsePositiveInt(value, '--shard-count', { max: 4 });
    } else if (key === '--shard-index') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0)
        throw new Error(`--shard-index must be a non-negative integer, got ${value}`);
      options.shardIndex = parsed;
    } else if (key === '--shard-output-dir') {
      if (!value) throw new Error('--shard-output-dir requires a value');
      options.shardOutputDir = value;
    } else if (key === '--merge-shards') {
      if (!value) throw new Error('--merge-shards requires a value');
      options.mergeShards = value;
    } else if (options.coverage) {
      throw new Error(`unknown argument: ${argument}`);
    } else {
      options.vitestArgs.push(argument);
    }
  }
  if (options.shardIndex >= options.shardCount) {
    throw new Error(
      `--shard-index must be below --shard-count ${options.shardCount}, got ${options.shardIndex}`,
    );
  }
  if (!options.coverage && (options.shardCount > 1 || options.mergeShards !== null)) {
    throw new Error('coverage shards and --merge-shards require coverage mode');
  }
  if (options.shardCount > 1 && options.shardOutputDir === null) {
    throw new Error('--shard-count above 1 requires --shard-output-dir');
  }
  if (options.mergeShards !== null && (options.shardCount > 1 || options.shardOutputDir !== null)) {
    throw new Error('--merge-shards cannot be combined with shard execution options');
  }
  return options;
}

function packageProjectNames() {
  return readdirSync(path.join(rootDir, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(rootDir, 'packages', entry.name, 'package.json'))
    .filter((manifestPath) => existsSync(manifestPath))
    .map((manifestPath) => JSON.parse(readFileSync(manifestPath, 'utf8')).name)
    .filter((name) => typeof name === 'string' && name.startsWith('@forgeax/'))
    .sort();
}

export function allProjectNames() {
  return [
    ...packageProjectNames(),
    '@forgeax/hello-fxaa',
    '@forgeax/hello-physical-material',
    '@forgeax/hello-triangle',
    'unit',
  ];
}

function chunk(values, size) {
  const groups = [];
  for (let index = 0; index < values.length; index += size) {
    groups.push(values.slice(index, index + size));
  }
  return groups;
}

export function projectGroups(projects, size) {
  return chunk(projects, size).flatMap((group) => {
    const groups = [];
    let sharedProjects = [];
    for (const project of group) {
      if (isolatedChildProjects.has(project) || projectPartitions.has(project)) {
        if (sharedProjects.length) groups.push(sharedProjects);
        groups.push([project]);
        sharedProjects = [];
      } else {
        sharedProjects.push(project);
      }
    }
    if (sharedProjects.length) groups.push(sharedProjects);
    return groups;
  });
}

function projectWeight(project) {
  return coverageProjectWeights.get(project) ?? defaultCoverageProjectWeight;
}

function modelingPartitionWeight(count, excludes) {
  const omitted = new Set(excludes);
  const seconds = Object.entries(modelingTimings.files).reduce(
    (total, [file, cost]) => total + (omitted.has(file) ? 0 : cost),
    0,
  );
  return Math.ceil(seconds / count / 5) * 5;
}

// Coverage children are objects so a heavy test file can own its own child
// while the rest of its project keeps the ordinary project group. `label` is
// the stable identity the shard merge uses to prove every child ran once.
export function coverageGroups(
  projects,
  size,
  { isolateFiles = true, completed = completedCoverage } = {},
) {
  const unitNativeFileSets = isolateFiles ? [] : devkitNativeUnitFileSets;
  const fileSets = (isolateFiles ? isolatedCoverageFileSets : unitNativeFileSets).filter(
    ({ project }) => projects.includes(project),
  );
  const excludes = fileSets.flatMap(({ files }) => files);
  const groups = projectGroups(projects, size).flatMap((group) => [
    {
      label: group.join(','),
      projects: group,
      files: [],
      excludes,
      gpuLease: false,
      weight: group.reduce((total, project) => total + projectWeight(project), 0),
    },
    ...fileSets
      .filter(({ project }) => group.includes(project))
      .map(({ project, files, weight, gpuLease = false }) => ({
        label: `${project}:${files.join(',')}`,
        projects: [project],
        files,
        excludes: [],
        weight,
        gpuLease,
      })),
  ]);
  return groups
    .flatMap((group) => {
      const partition =
        group.files.length === 0 &&
        group.projects.length === 1 &&
        projectPartitions.get(group.projects[0]);
      if (!partition || (partition.coverageOnly && !isolateFiles)) return [group];
      const weight =
        group.projects[0] === '@forgeax/engine-modeling'
          ? modelingPartitionWeight(partition.count, [
              ...group.excludes,
              ...(isolateFiles ? uninstrumentedPerformanceFiles : []),
            ])
          : (partition.weight ?? 0);
      return Array.from({ length: partition.count }, (_value, index) => ({
        ...group,
        label: `${group.label}:shard-${index + 1}-of-${partition.count}`,
        shard: `${index + 1}/${partition.count}`,
        // Admit the unsplit broad imports before fine-partition backfill. A
        // forecast underrun must not strand this whole half behind four waves.
        startEarly: partition.coverageOnly === true,
        weight: Math.max(weight, partition.weight ?? 0),
      }));
    })
    .map((group) => {
      const receipt = isolateFiles && completed.groups[group.label];
      return receipt
        ? {
            ...group,
            weight: Math.max(group.weight, Math.ceil(receipt.reservedSeconds / 5) * 5),
            // A partial refresh must not optimize against older partition
            // observations while its unmeasured peers retain a newer workload.
            observedSeconds:
              receipt.run === completed.latestRun ? receipt.latestSeconds : undefined,
            // Partial later runs are distinct scenarios, never restamped as a
            // complete cohort. Missing work keeps the admitted cohort forecast.
            replaySeconds: completed.replayRuns?.map((run) => run.completedSeconds[group.label]),
          }
        : group;
    });
}

export function coverageGroupOrder(groups) {
  return groups
    .map((_group, index) => index)
    .sort(
      (left, right) =>
        Number(groups[right].startEarly === true) - Number(groups[left].startEarly === true) ||
        groups[right].weight - groups[left].weight ||
        left - right,
    );
}

export function scheduledGroupOrder(groups, { coverage, localGpuLease }) {
  const order = coverage ? coverageGroupOrder(groups) : groups.map((_group, index) => index);
  const isNative = (index) =>
    groups[index].gpuLease === true ||
    groups[index].files?.some((file) => devkitNativeUnitFiles.includes(file));
  // Keep one uninterrupted parallel batch, then drain once for exclusive work.
  // Interleaving exclusive groups strands a slot behind each preceding tail.
  // Local native admission remains last so queued GPU work cannot hold up CPU work.
  const phase = (index) =>
    localGpuLease && isNative(index)
      ? 2
      : coverage && isExclusiveCoverageGroup(groups[index])
        ? 1
        : 0;
  return order.sort((left, right) => phase(left) - phase(right));
}

// Estimate the actual parallel-then-exclusive execution, including typecheck.
// Use the reference CI's two slots on every runner when placing groups: actual
// runner resources may limit execution but must not change the shared partition.
function coverageLanes(shardCount, typecheck) {
  return Array.from({ length: shardCount }, (_value, shard) => ({
    parallel: Array(2).fill(shard === 0 && typecheck && shardCount > 1 ? typecheckSeconds : 0),
    exclusive: 0,
  }));
}

function appendCoverageLane(lane, group) {
  const next = { parallel: [...lane.parallel], exclusive: lane.exclusive };
  if (isExclusiveCoverageGroup(group)) next.exclusive += group.weight;
  else next.parallel[next.parallel[0] <= next.parallel[1] ? 0 : 1] += group.weight;
  return next;
}

function coverageLaneFinish(lane) {
  return Math.max(...lane.parallel) + lane.exclusive;
}

function coverageAssignmentLaneFinishes(
  groups,
  assignment,
  shardCount,
  typecheck,
  completed = false,
  replay = -1,
) {
  const lanes = coverageLanes(shardCount, typecheck);
  const critical = completed ? criticalExclusiveCoverageGroup(groups) : -1;
  for (const index of coverageGroupOrder(groups)) {
    const shard = assignment[index];
    if (shard < 0) continue;
    const group = groups[index];
    // A shorter completed compiler sample must not spend the reserved serial
    // tail that its conservative forecast needs on the critical lane.
    const forecast =
      completed && index !== critical && group.observedSeconds !== undefined
        ? {
            ...group,
            weight:
              (replay >= 0 ? group.replaySeconds?.[replay] : undefined) ?? group.observedSeconds,
          }
        : group;
    lanes[shard] = appendCoverageLane(lanes[shard], forecast);
  }
  return lanes.map(coverageLaneFinish);
}

function coverageAssignmentFinish(groups, assignment, shardCount, typecheck, completed = false) {
  return Math.max(
    ...coverageAssignmentLaneFinishes(groups, assignment, shardCount, typecheck, completed),
  );
}

function criticalExclusiveCoverageGroup(groups) {
  return groups.reduce(
    (selected, group, index) =>
      group.files.length > 0 &&
      group.weight >= 900 &&
      (selected < 0 || group.weight > groups[selected].weight)
        ? index
        : selected,
    -1,
  );
}

// Run 41541125949 completed source production but stranded more exclusive
// owners behind it. Reserve the whole serial tail, not a fine-partition quota:
// the parallel batch remains balanced by the two-slot execution model.
function retainsExclusiveCoverageHeadroom(groups, assignment, index, shard) {
  const critical = criticalExclusiveCoverageGroup(groups);
  if (critical < 0) return true;
  const destination = index === critical ? shard : assignment[critical];
  if (destination < 0) return true;
  return !groups.some(
    (group, position) =>
      position !== critical &&
      isExclusiveCoverageGroup(group) &&
      (position === index ? shard : assignment[position]) === destination,
  );
}

function admitsFineCoveragePartition(siblings, part, count, shardCount) {
  const wave = Math.floor((part - 1) / shardCount);
  const rank = (part - 1) % shardCount;
  const parts = siblings.map((candidate) => Number(candidate.shard.split('/')[0]) - 1);
  return (
    !parts.some((position) => Math.floor(position / shardCount) === wave) &&
    parts.filter((position) => position % shardCount === rank).length <
      Math.ceil(count / shardCount / shardCount)
  );
}

// Broad project halves must span jobs. Fine partitions balance by scheduled
// work: equal child counts can strand a whole exclusive compiler behind them.
function canPlaceCoverageGroup(groups, assignment, index, shard, shardCount) {
  if (!retainsExclusiveCoverageHeadroom(groups, assignment, index, shard)) return false;
  const group = groups[index];
  if (!group.shard) return true;
  const [part, count] = group.shard.split('/').map(Number);
  const siblings = groups.filter(
    (candidate, position) =>
      position !== index &&
      candidate.shard &&
      candidate.projects[0] === group.projects[0] &&
      assignment[position] === shard,
  );
  if (siblings.length >= Math.ceil(count / shardCount)) return false;
  if (count > shardCount) {
    return admitsFineCoveragePartition(siblings, part, count, shardCount);
  }
  const broad = groups.filter(
    (candidate) => candidate.shard && Number(candidate.shard.split('/')[1]) <= shardCount,
  );
  const neighbors = broad.filter(
    (candidate) => candidate !== group && assignment[groups.indexOf(candidate)] === shard,
  ).length;
  return neighbors < Math.ceil(broad.length / shardCount);
}

function fineCoverageWave(groups, order, index, shardCount) {
  const group = groups[index];
  if (!group.shard) return null;
  const [part, count] = group.shard.split('/').map(Number);
  if (count <= shardCount) return null;
  const wave = Math.floor((part - 1) / shardCount);
  return order.filter((position) => {
    const candidate = groups[position];
    if (!candidate.shard || candidate.projects[0] !== group.projects[0]) return false;
    const [otherPart, otherCount] = candidate.shard.split('/').map(Number);
    return otherCount === count && Math.floor((otherPart - 1) / shardCount) === wave;
  });
}

// Admit one complete wave atomically. At most four actual jobs means at most
// 24 complete permutations, avoiding a greedy dead end under both spread quotas.
function placeFineCoverageWave(groups, indexes, assignment, lanes, shardCount) {
  let best;
  function visit(offset, planned, projected) {
    if (offset === indexes.length) {
      const finishes = projected.map(coverageLaneFinish);
      const finish = Math.max(...finishes);
      const spread = finishes.reduce((sum, value) => sum + value * value, 0);
      if (!best || finish < best.finish || (finish === best.finish && spread < best.spread)) {
        best = { assignment: planned, lanes: projected, finish, spread };
      }
      return;
    }
    const index = indexes[offset];
    for (let shard = 0; shard < shardCount; shard++) {
      if (!canPlaceCoverageGroup(groups, planned, index, shard, shardCount)) continue;
      const next = [...planned];
      next[index] = shard;
      const nextLanes = [...projected];
      nextLanes[shard] = appendCoverageLane(projected[shard], groups[index]);
      visit(offset + 1, next, nextLanes);
    }
  }
  visit(0, assignment, lanes);
  if (!best) throw new Error(`no coverage lanes admit complete wave ${groups[indexes[0]].label}`);
  return best;
}

// The actual 16-part/four-job roster has at most 576 complete wave/rank
// allocations. Larger future rosters keep bounded wave admission and local moves.
function* fineCoverageAssignments(groups, assignment, shardCount) {
  const projects = new Map();
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index];
    if (!group.shard || Number(group.shard.split('/')[1]) <= shardCount) continue;
    const key = `${group.projects[0]}:${group.shard.split('/')[1]}`;
    const indexes = projects.get(key) ?? [];
    indexes.push(index);
    projects.set(key, indexes);
  }
  for (const indexes of projects.values()) {
    if (indexes.length > shardCount * shardCount) continue;
    const planned = [...assignment];
    for (const index of indexes) planned[index] = -1;
    function* visit(offset, current) {
      if (offset === indexes.length) {
        yield current;
        return;
      }
      const index = indexes[offset];
      for (let shard = 0; shard < shardCount; shard++) {
        if (!canPlaceCoverageGroup(groups, current, index, shard, shardCount)) continue;
        const next = [...current];
        next[index] = shard;
        yield* visit(offset + 1, next);
      }
    }
    yield* visit(0, planned);
  }
}

function* coverageAssignmentCandidates(groups, assignment, shardCount) {
  for (let index = 0; index < groups.length; index++) {
    for (let shard = 0; shard < shardCount; shard++) {
      if (
        shard === assignment[index] ||
        !canPlaceCoverageGroup(groups, assignment, index, shard, shardCount)
      )
        continue;
      const candidate = [...assignment];
      candidate[index] = shard;
      yield candidate;
    }
  }
  for (let left = 0; left < groups.length; left++) {
    for (let right = left + 1; right < groups.length; right++) {
      if (assignment[left] === assignment[right]) continue;
      const candidate = [...assignment];
      [candidate[left], candidate[right]] = [candidate[right], candidate[left]];
      if (
        canPlaceCoverageGroup(groups, candidate, left, candidate[left], shardCount) &&
        canPlaceCoverageGroup(groups, candidate, right, candidate[right], shardCount)
      )
        yield candidate;
    }
  }
  yield* fineCoverageAssignments(groups, assignment, shardCount);
}

function balanceCompletedCoverage(groups, assignment, shardCount, typecheck) {
  const capacity = coverageAssignmentFinish(groups, assignment, shardCount, typecheck);
  let current = assignment;
  let finish = coverageAssignmentFinish(groups, current, shardCount, typecheck, true);
  for (;;) {
    let best = current;
    let bestFinish = finish;
    for (const candidate of coverageAssignmentCandidates(groups, current, shardCount)) {
      if (coverageAssignmentFinish(groups, candidate, shardCount, typecheck) > capacity) continue;
      const completed = coverageAssignmentFinish(groups, candidate, shardCount, typecheck, true);
      if (completed < bestFinish) {
        best = candidate;
        bestFinish = completed;
      }
    }
    if (best === current) return current;
    current = best;
    finish = bestFinish;
  }
}

function coverageAssignmentMetrics(groups, assignment, shardCount, typecheck) {
  const replayCount = Math.max(0, ...groups.map((group) => group.replaySeconds?.length ?? 0));
  const finishes = Array.from({ length: replayCount + 1 }, (_value, index) =>
    coverageAssignmentLaneFinishes(groups, assignment, shardCount, typecheck, true, index - 1),
  ).flat();
  return {
    finish: Math.max(...finishes),
    spread: finishes.reduce((total, finish) => total + finish * finish, 0),
  };
}

function completedCoverageCacheKey(groups, shardCount, typecheck) {
  return JSON.stringify([
    shardCount,
    typecheck,
    groups.map((group) => [
      group.label,
      group.weight,
      group.observedSeconds ?? null,
      group.replaySeconds ?? null,
      group.shard ?? null,
      group.startEarly === true,
      group.gpuLease === true,
      group.projects,
      group.files,
    ]),
  ]);
}

function completedCoverageRandom() {
  let state = 0x5f3759df;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function shuffleCoverageLanes(shardCount, random) {
  const lanes = Array.from({ length: shardCount }, (_value, index) => index);
  for (let index = lanes.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [lanes[index], lanes[other]] = [lanes[other], lanes[index]];
  }
  return lanes;
}

function startCompletedCoverageRestart(
  groups,
  best,
  restart,
  shardCount,
  typecheck,
  capacity,
  finePlans,
  fineIndexes,
  broadIndexes,
  random,
) {
  if (restart === 0) return [...best];
  const current = [...best];
  const plan = finePlans[Math.floor(random() * finePlans.length)];
  for (const index of fineIndexes) current[index] = plan[index];
  const lanes = shuffleCoverageLanes(shardCount, random);
  broadIndexes.forEach((index, offset) => {
    current[index] = lanes[offset];
  });
  return coverageAssignmentFinish(groups, current, shardCount, typecheck) <= capacity
    ? current
    : [...best];
}

function completedCoverageCandidate(
  groups,
  current,
  move,
  shardCount,
  finePlans,
  fineIndexes,
  broadIndexes,
  movableIndexes,
  random,
) {
  const candidate = [...current];
  if (move === 0) {
    const lanes = shuffleCoverageLanes(shardCount, random);
    broadIndexes.forEach((index, offset) => {
      candidate[index] = lanes[offset];
    });
    return candidate;
  }
  if (move === 1) {
    const plan = finePlans[Math.floor(random() * finePlans.length)];
    for (const index of fineIndexes) candidate[index] = plan[index];
    return candidate;
  }
  if (move === 2) {
    const left = Math.floor(random() * groups.length);
    const right = Math.floor(random() * groups.length);
    if (left === right || current[left] === current[right]) return null;
    [candidate[left], candidate[right]] = [candidate[right], candidate[left]];
    if (
      !canPlaceCoverageGroup(groups, candidate, left, candidate[left], shardCount) ||
      !canPlaceCoverageGroup(groups, candidate, right, candidate[right], shardCount)
    )
      return null;
    return candidate;
  }

  const index = movableIndexes[Math.floor(random() * movableIndexes.length)];
  const shard = Math.floor(random() * shardCount);
  if (
    shard === current[index] ||
    !canPlaceCoverageGroup(groups, candidate, index, shard, shardCount)
  )
    return null;
  candidate[index] = shard;
  return candidate;
}

function acceptCompletedCoverageCandidate(current, candidate, iteration, random) {
  const delta = candidate.finish - current.finish;
  const temperature = 35 * 0.02 ** (iteration / completedCoverageSearchIterations);
  return delta <= 0 || random() < Math.exp(-delta / temperature);
}

function completedCoverageMetricsImprove(candidate, current) {
  return (
    candidate.finish < current.finish ||
    (candidate.finish === current.finish && candidate.spread < current.spread)
  );
}

// A bounded deterministic search escapes one-move scheduling minima in the
// partial run replay. It changes complete-group placement only, and candidates
// stay under the original conservative reservation and roster constraints.
function optimizeCompletedCoverage(groups, assignment, shardCount, typecheck) {
  const measured = groups.filter((group) => group.observedSeconds !== undefined).length;
  if (measured < 20) return assignment;

  const broadIndexes = groups.flatMap((group, index) =>
    group.shard && Number(group.shard.split('/')[1]) <= shardCount ? [index] : [],
  );
  const fineIndexes = groups.flatMap((group, index) =>
    group.shard && Number(group.shard.split('/')[1]) > shardCount ? [index] : [],
  );
  const movableIndexes = groups.flatMap((group, index) => (!group.shard ? [index] : []));
  if (
    broadIndexes.length !== shardCount ||
    fineIndexes.length === 0 ||
    movableIndexes.length === 0
  ) {
    return assignment;
  }

  const finePlans = [...fineCoverageAssignments(groups, assignment, shardCount)];
  if (finePlans.length === 0) return assignment;

  const capacity = coverageAssignmentFinish(groups, assignment, shardCount, typecheck);
  let best = [...assignment];
  let bestMetrics = coverageAssignmentMetrics(groups, best, shardCount, typecheck);
  const random = completedCoverageRandom();

  for (let restart = 0; restart < completedCoverageSearchRestarts; restart += 1) {
    let current = startCompletedCoverageRestart(
      groups,
      best,
      restart,
      shardCount,
      typecheck,
      capacity,
      finePlans,
      fineIndexes,
      broadIndexes,
      random,
    );
    let currentMetrics = coverageAssignmentMetrics(groups, current, shardCount, typecheck);

    for (let iteration = 0; iteration < completedCoverageSearchIterations; iteration += 1) {
      const move = Math.floor(random() * 4);
      const candidate = completedCoverageCandidate(
        groups,
        current,
        move,
        shardCount,
        finePlans,
        fineIndexes,
        broadIndexes,
        movableIndexes,
        random,
      );
      if (!candidate) continue;
      if (coverageAssignmentFinish(groups, candidate, shardCount, typecheck) > capacity) continue;
      const metrics = coverageAssignmentMetrics(groups, candidate, shardCount, typecheck);
      if (acceptCompletedCoverageCandidate(currentMetrics, metrics, iteration, random)) {
        current = candidate;
        currentMetrics = metrics;
      }
      if (completedCoverageMetricsImprove(metrics, bestMetrics)) {
        best = candidate;
        bestMetrics = metrics;
      }
    }
  }
  return best;
}

function cachedCoverageAssignment(groups, shardCount, typecheck) {
  if (!groups.some((group) => group.observedSeconds !== undefined)) return null;
  const key = completedCoverageCacheKey(groups, shardCount, typecheck);
  const assignment = completedCoverageAssignmentCache.get(key);
  if (!assignment) return { key, assignment: null };
  return { key, assignment: [...assignment] };
}

// Improve only by moving one complete child; every iteration strictly lowers
// the slowest lane under the same two-slot then exclusive execution model.
function refineCoverageAssignment(groups, assignment, shardCount, typecheck) {
  let current = assignment;
  let finish = coverageAssignmentFinish(groups, current, shardCount, typecheck);
  for (;;) {
    let best = current;
    let bestFinish = finish;
    for (const candidate of coverageAssignmentCandidates(groups, current, shardCount)) {
      const candidateFinish = coverageAssignmentFinish(groups, candidate, shardCount, typecheck);
      if (candidateFinish < bestFinish) {
        best = candidate;
        bestFinish = candidateFinish;
      }
    }
    if (best === current) return balanceCompletedCoverage(groups, current, shardCount, typecheck);
    current = best;
    finish = bestFinish;
  }
}

export function assignCoverageShards(groups, shardCount, { typecheck = true } = {}) {
  // Local single-job execution still serializes exclusive children; it has no
  // peer job onto which a placement constraint could move a complete owner.
  if (shardCount === 1) return Array(groups.length).fill(0);
  const cached = cachedCoverageAssignment(groups, shardCount, typecheck);
  if (cached?.assignment) return cached.assignment;
  let lanes = coverageLanes(shardCount, typecheck);
  const critical = criticalExclusiveCoverageGroup(groups);
  const weights = groups.map((group) => group.weight * (isExclusiveCoverageGroup(group) ? 2 : 1));
  const order = groups
    .map((_group, index) => index)
    .sort(
      (a, b) => Number(b === critical) - Number(a === critical) || weights[b] - weights[a] || a - b,
    );
  let assignment = Array(groups.length).fill(-1);
  for (const index of order) {
    if (assignment[index] >= 0) continue;
    const wave = fineCoverageWave(groups, order, index, shardCount);
    if (wave) {
      const planned = placeFineCoverageWave(groups, wave, assignment, lanes, shardCount);
      assignment = planned.assignment;
      lanes = planned.lanes;
      continue;
    }
    const candidates = lanes.map((lane) => appendCoverageLane(lane, groups[index]));
    let selected = -1;
    for (let shard = 0; shard < shardCount; shard += 1) {
      if (!canPlaceCoverageGroup(groups, assignment, index, shard, shardCount)) continue;
      if (
        selected < 0 ||
        coverageLaneFinish(candidates[shard]) < coverageLaneFinish(candidates[selected])
      )
        selected = shard;
    }
    if (selected < 0) throw new Error(`no coverage lane admits ${groups[index].label}`);
    assignment[index] = selected;
    lanes[selected] = candidates[selected];
  }
  const balanced = refineCoverageAssignment(groups, assignment, shardCount, typecheck);
  const optimized = optimizeCompletedCoverage(groups, balanced, shardCount, typecheck);
  if (cached) {
    if (completedCoverageAssignmentCache.size >= 8) {
      completedCoverageAssignmentCache.delete(completedCoverageAssignmentCache.keys().next().value);
    }
    completedCoverageAssignmentCache.set(cached.key, [...optimized]);
  }
  return optimized;
}

// Every shard records the full expected roster it derived; the merge
// recomputes that roster independently and accepts only an exact partition.
export function validateShardManifests(manifests, expectedGroups) {
  if (manifests.length === 0) throw new Error('no coverage shard manifests found');
  const shardCount = manifests[0].shardCount;
  const failures = [];
  if (manifests.length !== shardCount) {
    failures.push(`expected ${shardCount} shard manifests, found ${manifests.length}`);
  }
  const indexes = manifests.map(({ shardIndex }) => shardIndex).sort((a, b) => a - b);
  if (indexes.some((shardIndex, position) => shardIndex !== position)) {
    failures.push(`shard indexes must be 0..${shardCount - 1} exactly once, got ${indexes}`);
  }
  for (const manifest of manifests) {
    if (manifest.shardCount !== shardCount) {
      failures.push(`shard ${manifest.shardIndex} declares shardCount=${manifest.shardCount}`);
    }
    if (JSON.stringify(manifest.expectedGroups) !== JSON.stringify(expectedGroups)) {
      failures.push(`shard ${manifest.shardIndex} planned a different coverage group roster`);
    }
  }
  const seen = new Map();
  for (const manifest of manifests) {
    for (const label of manifest.groups) seen.set(label, (seen.get(label) ?? 0) + 1);
  }
  for (const label of expectedGroups) {
    const count = seen.get(label) ?? 0;
    if (count !== 1) failures.push(`group ${label} ran ${count} times`);
  }
  for (const label of seen.keys()) {
    if (!expectedGroups.includes(label)) failures.push(`unexpected group ${label}`);
  }
  if (failures.length) throw new Error(`coverage shard merge rejected: ${failures.join('; ')}`);
}

function greenReport(report) {
  return Boolean(
    report &&
      report.success === true &&
      Number(report.numFailedTests ?? 0) === 0 &&
      Number(report.numFailedTestSuites ?? 0) === 0,
  );
}

function readReport(reportPath) {
  if (!existsSync(reportPath)) return null;
  try {
    return JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (error) {
    throw new Error(`failed to parse ${reportPath}: ${error.message}`);
  }
}

function runChild(args, { env = process.env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: rootDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let outputError = null;
    const collect = (chunks) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxChildOutputBytes) {
        outputError ??= new Error(
          `Vitest child output exceeded ${maxChildOutputBytes} bytes; refusing to buffer unbounded concurrent logs`,
        );
        child.kill('SIGTERM');
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', (error) => resolve({ error, status: null, signal: null, stdout, stderr }));
    child.on('close', (status, signal) =>
      resolve({ error: outputError, status, signal, stdout, stderr }),
    );
  });
}

export function buildTypecheckArgs({ cliPath, projects, maxWorkers }) {
  return [
    cliPath,
    'run',
    ...projects.flatMap((project) => ['--project', project]),
    `--maxWorkers=${maxWorkers}`,
    '--typecheck.only',
    '--reporter=default',
  ];
}

async function runTypecheck({ cliPath, projects, maxWorkers }) {
  const child = await runChild(buildTypecheckArgs({ cliPath, projects, maxWorkers }));
  const stdout = Buffer.concat(child.stdout).toString('utf8');
  const stderr = Buffer.concat(child.stderr).toString('utf8');
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  if (child.error)
    throw new Error(`Vitest typecheck preflight could not start: ${child.error.message}`);
  if (child.signal) {
    const error = new Error(`Vitest typecheck preflight terminated by ${child.signal}`);
    error.signal = child.signal;
    throw error;
  }
  if (child.status !== 0) {
    const error = new Error(`Vitest typecheck preflight failed with status ${child.status}`);
    error.status = child.status ?? 1;
    throw error;
  }
}

async function runSerialCoveragePreflights({ cliPath, projects }) {
  for (const preflight of serialCoveragePreflights) {
    if (!projects.includes(preflight.project)) continue;
    const child = await runChild([
      cliPath,
      'run',
      '--project',
      preflight.project,
      preflight.file,
      '--maxWorkers=1',
      '--typecheck.enabled=false',
      '--reporter=default',
    ]);
    const stdout = Buffer.concat(child.stdout).toString('utf8');
    const stderr = Buffer.concat(child.stderr).toString('utf8');
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    if (child.error) throw child.error;
    if (child.signal) throw new Error(`coverage preflight terminated by ${child.signal}`);
    if (child.status !== 0)
      throw new Error(`coverage preflight failed with status ${child.status}: ${preflight.file}`);
  }
}

export function buildGroupArgs({
  cliPath,
  group,
  maxWorkers,
  coverage,
  vitestArgs = [],
  coverageDir,
  reportPath,
}) {
  const args = [
    cliPath,
    'run',
    ...group.projects.flatMap((project) => ['--project', project]),
    ...group.files,
    ...(group.shard ? [`--shard=${group.shard}`] : []),
    `--maxWorkers=${maxWorkers}`,
  ];
  if (!coverage) {
    return [
      ...args,
      ...group.excludes.map(
        (file) => `--exclude=${path.resolve(rootDir, file).replaceAll('\\', '/')}`,
      ),
      ...vitestArgs,
    ];
  }
  return [
    ...args,
    // Typechecking is one all-project preflight in main(); coverage children
    // only own instrumented runtime tests.
    '--typecheck.enabled=false',
    '--coverage',
    ...serialCoveragePreflights.map(
      ({ file }) => `--exclude=${path.resolve(rootDir, file).replaceAll('\\', '/')}`,
    ),
    ...uninstrumentedPerformanceFiles.map(
      (file) => `--exclude=${path.resolve(rootDir, file).replaceAll('\\', '/')}`,
    ),
    ...group.excludes.map(
      (file) => `--exclude=${path.resolve(rootDir, file).replaceAll('\\', '/')}`,
    ),
    '--coverage.reporter=json',
    `--coverage.reportsDirectory=${coverageDir}`,
    ...coverageThresholds,
    '--reporter=default',
    '--reporter=json',
    `--outputFile=${reportPath}`,
  ];
}

async function runGroup({
  cliPath,
  group,
  groupIndex,
  maxWorkers,
  coverage,
  vitestArgs,
  runChildImpl = runChild,
}) {
  const tempDir = coverage ? mkdtempSync(path.join(os.tmpdir(), 'forgeax-vitest-coverage-')) : null;
  const coverageDir = tempDir === null ? null : path.join(tempDir, 'coverage');
  const reportPath = tempDir === null ? null : path.join(tempDir, 'vitest.json');
  const logPath = tempDir === null ? null : path.join(tempDir, 'vitest.log');
  if (coverageDir !== null) mkdirSync(coverageDir, { recursive: true });
  const args = buildGroupArgs({
    cliPath,
    group,
    maxWorkers,
    coverage,
    vitestArgs,
    coverageDir,
    reportPath,
  });
  const child = await runChildImpl(args);
  const stdout = child.stdout ? Buffer.concat(child.stdout).toString('utf8') : '';
  const stderr = child.stderr ? Buffer.concat(child.stderr).toString('utf8') : '';
  const log = child.output ?? `${stdout}${stderr}`;
  if (logPath !== null) writeFileSync(logPath, log);
  if (child.output === undefined) {
    process.stdout.write(stdout);
    process.stderr.write(stderr);
  }

  if (child.error) {
    throw new Error(`Vitest group ${groupIndex} could not start: ${child.error.message}`);
  }
  if (child.signal) {
    const error = new Error(`Vitest group ${groupIndex} terminated by ${child.signal}`);
    error.signal = child.signal;
    throw error;
  }
  const report = coverage && reportPath !== null ? readReport(reportPath) : null;
  const closeTimeoutOnly =
    coverage &&
    child.status !== 0 &&
    log.includes('close timed out after 500ms') &&
    greenReport(report);
  if (child.status !== 0 && !closeTimeoutOnly) {
    const error = new Error(
      `Vitest group ${groupIndex} failed with status ${child.status}; group=${group.label}; log=${logPath ?? 'inherited output'}`,
    );
    error.status = child.status ?? 1;
    throw error;
  }

  if (!coverage) return { report: null, coveragePath: null, tempDir: null };

  if (!greenReport(report)) {
    throw new Error(
      `Vitest group ${groupIndex} reported failures; group=${group.label}; report=${reportPath}`,
    );
  }
  const coveragePath = path.join(coverageDir, 'coverage-final.json');
  if (!existsSync(coveragePath)) {
    throw new Error(
      `Vitest group ${groupIndex} did not produce ${coveragePath}; group=${group.label}`,
    );
  }
  return { coveragePath, report, tempDir };
}

function mergeReports(reports) {
  const aggregate = {
    numTotalTestSuites: 0,
    numPassedTestSuites: 0,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: 0,
    numPassedTests: 0,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    snapshot: {},
    startTime: Number.POSITIVE_INFINITY,
    success: true,
    testResults: [],
  };
  for (const report of reports) {
    for (const counter of reportCounters) {
      aggregate[counter] += Number(report[counter] ?? 0);
    }
    if (typeof report.startTime === 'number')
      aggregate.startTime = Math.min(aggregate.startTime, report.startTime);
    aggregate.success &&= greenReport(report);
    aggregate.testResults.push(...(Array.isArray(report.testResults) ? report.testResults : []));
    for (const [key, value] of Object.entries(report.snapshot ?? {})) {
      if (typeof value === 'number')
        aggregate.snapshot[key] = (aggregate.snapshot[key] ?? 0) + value;
      else aggregate.snapshot[key] = value;
    }
  }
  if (!Number.isFinite(aggregate.startTime)) delete aggregate.startTime;
  return aggregate;
}

function coverageDependencies() {
  const rootRequire = createRequire(import.meta.url);
  const providerPath = rootRequire.resolve('@vitest/coverage-v8');
  const providerRequire = createRequire(providerPath);
  return {
    createCoverageMap: providerRequire('istanbul-lib-coverage').createCoverageMap,
    libReport: providerRequire('istanbul-lib-report'),
    reports: providerRequire('istanbul-reports'),
  };
}

function mergeCoverageMaps(coveragePaths, { fromRoot = rootDir } = {}) {
  const { createCoverageMap } = coverageDependencies();
  const coverageMap = createCoverageMap({});
  for (const coveragePath of coveragePaths) {
    const coverage = JSON.parse(readFileSync(coveragePath, 'utf8'));
    coverageMap.merge(
      fromRoot === rootDir ? coverage : rerootCoverage(coverage, fromRoot, rootDir),
    );
  }
  return coverageMap;
}

// Shards run on runners with different checkout roots, so shard coverage is
// stored relative to the repository and re-rooted at the merge checkout;
// otherwise one source file becomes one istanbul entry per runner and the
// uncovered placeholders dilute the aggregate.
export function rerootCoverage(coverage, fromRoot, toRoot) {
  const reroot = (filePath) => {
    const relative = fromRoot ? path.relative(fromRoot, filePath) : filePath;
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`coverage path ${filePath} is outside ${fromRoot || 'the repository'}`);
    }
    const portable = relative.split(path.sep).join('/');
    return toRoot ? path.join(toRoot, portable) : portable;
  };
  return Object.fromEntries(
    Object.values(coverage).map((fileCoverage) => {
      // CoverageMap#toJSON yields FileCoverage instances; their raw data is `.data`.
      const data = fileCoverage.data ?? fileCoverage;
      const filePath = reroot(data.path);
      return [filePath, { ...data, path: filePath }];
    }),
  );
}

function writeCoverageReport(coveragePaths, outputDir, { fromRoot = rootDir } = {}) {
  const { libReport, reports } = coverageDependencies();
  const coverageMap = mergeCoverageMaps(coveragePaths, { fromRoot });

  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  const context = libReport.createContext({ dir: outputDir, coverageMap });
  for (const reporter of ['text', 'json', 'json-summary', 'html']) {
    reports.create(reporter, { projectRoot: rootDir }).execute(context);
  }
  const finalPath = path.join(outputDir, 'coverage-final.json');
  if (!existsSync(finalPath)) writeFileSync(finalPath, JSON.stringify(coverageMap.toJSON()));
  const summary = coverageMap.getCoverageSummary().toJSON();
  const summaryPath = path.join(outputDir, 'coverage-summary.json');
  if (!existsSync(summaryPath))
    writeFileSync(summaryPath, JSON.stringify({ total: summary }, null, 2));
  return summary;
}

function assertRootThresholds(summary) {
  const failures = [];
  for (const metric of ['lines', 'functions']) {
    const actual = Number(summary[metric]?.pct);
    if (!Number.isFinite(actual) || actual < 70) {
      failures.push(`${metric}=${summary[metric]?.pct ?? 'Unknown'}% (required >= 70%)`);
    }
  }
  if (failures.length)
    throw new Error(`aggregate coverage threshold failed: ${failures.join(', ')}`);
}

const shardManifestName = 'shard.json';
const shardReportName = 'vitest.json';
const shardCoverageName = 'coverage-final.json';

function writeShardOutput({ outputDir, manifest, groupResults }) {
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(
    path.join(outputDir, shardReportName),
    JSON.stringify(mergeReports(groupResults.map(({ report }) => report)), null, 2),
  );
  writeFileSync(
    path.join(outputDir, shardCoverageName),
    JSON.stringify(
      rerootCoverage(
        mergeCoverageMaps(groupResults.map(({ coveragePath }) => coveragePath)).toJSON(),
        rootDir,
        '',
      ),
    ),
  );
  writeFileSync(path.join(outputDir, shardManifestName), JSON.stringify(manifest, null, 2));
}

function findShardDirectories(directory) {
  const found = [];
  if (existsSync(path.join(directory, shardManifestName))) found.push(directory);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) found.push(...findShardDirectories(path.join(directory, entry.name)));
  }
  return found.sort();
}

function writeFinalReport({ options, reports, coveragePaths, groupCount, coverageRoot = rootDir }) {
  const outputFile = path.resolve(rootDir, options.outputFile);
  const coverageDir = path.resolve(rootDir, options.coverageDir);
  const aggregateReport = mergeReports(reports);
  writeFileSync(outputFile, JSON.stringify(aggregateReport, null, 2));
  const summary = writeCoverageReport(coveragePaths, coverageDir, { fromRoot: coverageRoot });
  assertRootThresholds(summary);
  process.stdout.write(
    `[vitest] split coverage passed: groups=${groupCount}, tests=${aggregateReport.numTotalTests}, files=${aggregateReport.testResults.length}\n`,
  );
}

function mergeShards({ options, groups }) {
  const shardDirectories = findShardDirectories(path.resolve(rootDir, options.mergeShards));
  const manifests = shardDirectories.map((directory) =>
    JSON.parse(readFileSync(path.join(directory, shardManifestName), 'utf8')),
  );
  validateShardManifests(
    manifests,
    groups.map(({ label }) => label),
  );
  const reports = shardDirectories.map((directory) =>
    readReport(path.join(directory, shardReportName)),
  );
  for (const [position, report] of reports.entries()) {
    if (!greenReport(report)) {
      throw new Error(`coverage shard ${manifests[position].shardIndex} report is not green`);
    }
  }
  writeFinalReport({
    options,
    reports,
    coveragePaths: shardDirectories.map((directory) => path.join(directory, shardCoverageName)),
    groupCount: groups.length,
    coverageRoot: '',
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const discovered = allProjectNames();
  const projects = options.projects.length ? options.projects : discovered;
  const unknown = projects.filter((project) => !discovered.includes(project));
  if (unknown.length) throw new Error(`unknown Vitest project(s): ${unknown.join(', ')}`);
  const groups = coverageGroups(projects, options.groupSize, { isolateFiles: options.coverage });
  if (options.mergeShards !== null) {
    mergeShards({ options, groups });
    return;
  }
  const shardAssignment = assignCoverageShards(groups, options.shardCount, {
    typecheck: options.typecheck,
  });
  const selectedGroups = groups.filter(
    (_group, index) => shardAssignment[index] === options.shardIndex,
  );
  const localGpuLease = process.env.FORGEAX_LOCAL_GPU_LEASE === '1';
  const groupOrder = scheduledGroupOrder(selectedGroups, {
    coverage: options.coverage,
    localGpuLease,
  });
  const selectedProjects = [...new Set(selectedGroups.flatMap((group) => group.projects))];
  const runsTypecheck = options.coverage && options.typecheck && options.shardIndex === 0;
  const resources = runnerResources();
  const groupConcurrency =
    options.groupConcurrency === 'auto'
      ? coverageGroupConcurrency(resources)
      : options.groupConcurrency;
  if (groupConcurrency > 1 && options.maxWorkers > 1) {
    throw new Error(
      'concurrent groups require --max-workers=1 to preserve the isolated coverage memory bound',
    );
  }
  const scheduling = `${options.coverage ? 'weighted-longest-first' : 'stable'}${localGpuLease ? '+native-last' : ''}`;
  const plan = `[vitest] group concurrency=${groupConcurrency}, scheduling=${scheduling}, shard=${options.shardIndex + 1}/${options.shardCount}, groups=${selectedGroups.length}/${groups.length} (requested=${options.groupConcurrency}, typecheck=${runsTypecheck ? 'on' : 'off'}, cpus=${resources.cpus}, memoryBytes=${resources.memoryBytes})\n`;
  if (options.dryRun) {
    process.stderr.write(plan);
    for (const index of groupOrder) {
      const group = selectedGroups[index];
      const groupIndex = groups.indexOf(group);
      process.stdout.write(
        `group-${String(groupIndex + 1).padStart(2, '0')}: ${group.label} (weight ${group.weight})\n`,
      );
    }
    return;
  }

  const cliPath = path.join(scriptDir, 'run-vitest-projects.mjs');
  let groupResults = [];
  try {
    process.stderr.write(plan);
    if (runsTypecheck) {
      const startedAt = Date.now();
      process.stderr.write(
        `[vitest] typecheck preflight: projects=${projects.length}, maxWorkers=${options.maxWorkers}\n`,
      );
      await runTypecheck({
        cliPath,
        projects,
        maxWorkers: options.maxWorkers,
      });
      process.stderr.write(
        `[vitest] typecheck preflight passed in ${((Date.now() - startedAt) / 1000).toFixed(2)}s\n`,
      );
    }
    if (options.coverage) {
      const startedAt = Date.now();
      await runSerialCoveragePreflights({ cliPath, projects: selectedProjects });
      process.stderr.write(
        `[vitest] serial coverage preflights passed in ${((Date.now() - startedAt) / 1000).toFixed(2)}s\n`,
      );
    }
    groupResults = await runGroups({
      groups: selectedGroups,
      concurrency: groupConcurrency,
      order: groupOrder,
      isExclusive: isExclusiveCoverageGroup,
      runGroupImpl: async (group, index) => {
        const startedAt = Date.now();
        const label = `Vitest group ${group.label}`;
        const shaderWorkers = shaderCompileWorkers(
          resources,
          process.env.FORGEAX_SHADER_COMPILE_WORKERS,
          (isExclusiveCoverageGroup(group) ? 1 : groupConcurrency) * options.maxWorkers,
        );
        const runBrowserCommandImpl =
          group.gpuLease && localGpuLease
            ? (await import('./run-browser-gate-with-retry.mjs')).runBrowserCommand
            : undefined;
        process.stderr.write(
          `[vitest] ${options.coverage ? 'coverage' : 'bounded unit'} group ${index + 1}/${selectedGroups.length}: ${group.label} (shaderWorkers=${shaderWorkers})\n`,
        );
        const run = () =>
          runGroup({
            cliPath,
            group,
            groupIndex: index + 1,
            maxWorkers: options.maxWorkers,
            coverage: options.coverage,
            vitestArgs: options.vitestArgs,
            runChildImpl: (args) => {
              // Copy after local GPU admission so the child inherits its held lease.
              const env = {
                ...process.env,
                FORGEAX_SHADER_COMPILE_WORKERS: String(shaderWorkers),
              };
              return runBrowserCommandImpl
                ? runBrowserCommandImpl([process.execPath, ...args], { label, env })
                : runChild(args, { env });
            },
          });
        const result =
          group.gpuLease && localGpuLease ? await withLocalGpuLease(run, { label }) : await run();
        process.stderr.write(
          `[vitest] group ${index + 1}/${selectedGroups.length} passed in ${((Date.now() - startedAt) / 1000).toFixed(2)}s\n`,
        );
        return result;
      },
    });

    if (!options.coverage) {
      process.stdout.write(
        `[vitest] bounded unit passed: groups=${groups.length}, projects=${projects.length}\n`,
      );
      return;
    }
    if (options.shardOutputDir !== null) {
      writeShardOutput({
        outputDir: path.resolve(rootDir, options.shardOutputDir),
        manifest: {
          shardIndex: options.shardIndex,
          shardCount: options.shardCount,
          expectedGroups: groups.map(({ label }) => label),
          groups: selectedGroups.map(({ label }) => label),
        },
        groupResults,
      });
      process.stdout.write(
        `[vitest] coverage shard ${options.shardIndex + 1}/${options.shardCount} passed: groups=${selectedGroups.length}\n`,
      );
    } else {
      writeFinalReport({
        options,
        reports: groupResults.map(({ report }) => report),
        coveragePaths: groupResults.map(({ coveragePath }) => coveragePath),
        groupCount: groups.length,
      });
    }
    for (const { tempDir } of groupResults) rmSync(tempDir, { recursive: true, force: true });
  } catch (error) {
    process.stderr.write(`[vitest] split coverage failed: ${error.message}\n`);
    if (error.signal) process.kill(process.pid, error.signal);
    process.exitCode = error.status ?? 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`[vitest] split coverage failed: ${error.message}\n`);
    if (error.signal) process.kill(process.pid, error.signal);
    process.exitCode = 1;
  }
}
