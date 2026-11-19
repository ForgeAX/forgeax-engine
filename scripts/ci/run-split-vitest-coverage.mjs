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
  shaderProducerHeapSize,
  shaderSourceCompileWorkers,
} from '../lib/runner-resources.mjs';
import { coreDeferredCoverageFiles } from './core-validation.mjs';
import completedCoverage from './coverage-completed-child-seconds.json' with { type: 'json' };
import { withLocalGpuLease } from './local-gpu-lease.mjs';
import modelingTimings from './modeling-coverage-file-seconds.json' with { type: 'json' };
import { createModelingFilePhaseStream } from './modeling-file-phase-reporter.mjs';
import { sourceCompilationPhasePrefix } from './source-compilation-phase-reporter.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '../..');
const defaultGroupSize = 4;
const defaultMaxWorkers = 1;
const maxGroupConcurrency = 3;
const maxChildOutputBytes = 64 * 1024 * 1024;
const completedCoverageAssignmentCache = new Map();
const coverageAssignmentOrders = new WeakMap();
const coverageAssignmentInputs = new WeakMap();
const coveragePlacementInputs = new WeakMap();
const completedCoverageSearchRestarts = 48;
// Retain all historical replay windows after admitting a slower partial cohort.
// More bounded search work preserves the same execution and test deadlines.
const completedCoverageSearchIterations = 60_000;
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
    // Both fixtures own a real Browser and backend graph. Run 43863763618
    // OOM-killed the live-look producer beside ordinary Modeling coverage.
    // Reuse this exclusive child instead of adding a process. Its successful
    // look file took 196 s in run 43847849110; reserve 300 s for added startup
    // and instrumentation without calling the expanded child a measured sample.
    files: [
      'packages/devkit/src/__tests__/scene-bootstrap.e2e.test.ts',
      'packages/devkit/src/__tests__/live-dev-look.e2e.test.ts',
    ],
    receiptLabel: 'packages/devkit/src/__tests__/scene-bootstrap.e2e.test.ts',
    weight: 75,
    reservationWeight: 375,
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
// The source-contract batch reserves each unchanged critical case deadline and
// one 15-second process/transform startup, rather than three separate startups.
const sourceContractStartupWeight = 15;
const isolatedCoverageFileSets = [
  {
    // Run 42758031056 crossed the original 15 s repository scan beside a
    // TypeScript compiler child. Keep the complete file instrumented and cold.
    project: '@forgeax/engine-app',
    files: ['packages/app/__tests__/builtin-systems.test.ts'],
    batch: 'source-contracts',
    weight: 15,
  },
  {
    // Retain real CLI discovery and its 5 s test / 60 s child bounds.
    project: '@forgeax/engine-codec',
    files: ['packages/codec/scripts/__tests__/fetch-basis.test.mjs'],
    batch: 'source-contracts',
    weight: 5,
  },
  {
    // Retain both real TypeScript programs and the original 30 s oracle.
    project: '@forgeax/engine-three',
    files: ['packages/three/src/__tests__/api-audit.test.ts'],
    batch: 'source-contracts',
    weight: 30,
  },
  {
    // Run 43758622089 crossed this unchanged 30 s admission bound while the
    // broad Runtime child overlapped Modeling. Keep the whole Null-RHI case
    // with the existing serial CPU contracts; no source cooking or GPU lease.
    project: '@forgeax/engine-runtime',
    files: ['packages/runtime/src/__tests__/gtao-deferred-admission.integration.test.ts'],
    batch: 'source-contracts',
    batchReceiptLabel:
      '@forgeax/engine-app,@forgeax/engine-codec,@forgeax/engine-three:packages/app/__tests__/builtin-systems.test.ts,packages/codec/scripts/__tests__/fetch-basis.test.mjs,packages/three/src/__tests__/api-audit.test.ts',
    weight: 30,
  },
  {
    // Run 41345505497 crossed the unchanged 60 s mip/gutter oracle beside
    // another coverage child. Preserve all three 1024-square bakes exclusively.
    project: '@forgeax/engine-modeling',
    files: ['packages/modeling/src/__tests__/bake-cage.unit.test.ts'],
    weight: 115,
    // The 1024 oracle now uses bounded row Workers. Reserve startup and full
    // instrumented-file cost without treating the failed serial child as a sample.
    reservationWeight: 200,
  },
  {
    // Run 41703381180 crossed the unchanged 30 s fractional-sharpness oracle
    // while ordinary coverage children shared its lane. Run 41959265373 also
    // crossed the unchanged 30 s near-coil case under the 16-way Modeling load.
    // Keep both files sequential in this exclusive single-worker child; retain
    // the measured 60 s subd cost plus the conservative 65 s sweep reservation.
    project: '@forgeax/engine-modeling',
    files: [
      'packages/modeling/src/__tests__/subd-crease.unit.test.ts',
      'packages/modeling/src/__tests__/sweep.unit.test.ts',
    ],
    receiptLabel: 'packages/modeling/src/__tests__/subd-crease.unit.test.ts',
    weight: 60,
    reservationWeight: 125,
    packagesOnly: true,
  },
  {
    // The same run's three-build bootstrap cases reached 15.094/15.061 s.
    // Drain instrumented neighbors without changing the four bases or budgets.
    project: '@forgeax/engine-devkit',
    files: [
      'packages/devkit/src/__tests__/execution-bootstrap-cache.integration.test.ts',
      'packages/devkit/src/__tests__/asset-libraries.integration.test.ts',
      'packages/devkit/src/__tests__/host-authoring-publication.integration.test.ts',
    ],
    // Runs 43693841655 and 43706568773 crossed the mounted Content oracle's unchanged 120 s
    // bound beside another instrumented child. Keep the whole file with the
    // existing cold owner; reserve its full budget without relabeling prior
    // bootstrap observations as evidence for this expanded child.
    receiptLabel: 'packages/devkit/src/__tests__/execution-bootstrap-cache.integration.test.ts',
    weight: 75,
    // Run 43802933357 crossed authoring publication's unchanged 15 s bound
    // beside Modeling. Merge its two cases here instead of adding a process;
    // reserve both case budgets without claiming another timing observation.
    reservationWeight: 225,
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
    // Retain both workloads in the existing exclusive child. The direct
    // Surface case in run 44402862972 timed out with seven shader workers;
    // account for its real material cooks with the bounded source compiler.
    project: '@forgeax/engine-render',
    files: [
      'packages/render/src/__tests__/gpu-driven-batch-topology-pbr.unit.test.ts',
      'packages/render/src/__tests__/direct-shadow-preparation.integration.test.ts',
    ],
    weight: 90,
    sourceCompilation: true,
    packagesOnly: true,
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
    // Run 42250822849 also crossed the two direct/vertex 30 s cooking budgets
    // beside Modeling. Keep their complete files in this same cold-producer owner.
    project: '@forgeax/engine-render',
    files: [
      'packages/render/src/__tests__/gpu-driven-production.integration.test.ts',
      'packages/render/src/__tests__/raytracing/probe-global.unit.test.ts',
      'packages/render/src/__tests__/direct-preparation.integration.test.ts',
      'packages/render/src/__tests__/vertex-color-program.integration.test.ts',
      // Run 44024988647 crossed the unchanged 30/60/120-second cold cooker
      // bounds beside broad instrumented Render/Modeling work. Retain every
      // complete file in this existing exclusive producer owner.
      'packages/render/src/__tests__/mesh-builder-stock-material-inputs.integration.test.ts',
      'packages/render/src/__tests__/skin-candidate-host.unit.test.ts',
      'packages/render/src/__tests__/standard-scene-data-runtime.integration.test.ts',
      'packages/render/src/__tests__/planar-receiver-routing.unit.test.ts',
      'packages/render/src/__tests__/raytracing/renderer-diffuse-retained.unit.test.ts',
      'packages/render/src/raytracing/__tests__/scene-field-projection.integration.test.ts',
    ],
    // Retain the original two-file timing identity; the extra cooking work is
    // an explicit reservation, not a restamped historical measurement.
    receiptLabel:
      'packages/render/src/__tests__/gpu-driven-production.integration.test.ts,packages/render/src/__tests__/raytracing/probe-global.unit.test.ts',
    weight: 100,
    // Added reservations are forecasts, not timing samples of this larger owner.
    reservationWeight: 520,
    // Run 44402862972 also crossed the consumed-resource case's 30 s limit
    // in this existing exclusive child with seven shader workers.
    sourceCompilation: true,
    packagesOnly: true,
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
    sourceCompilation: true,
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
      'packages/shader-compiler/src/material/__tests__/standard-material-cook.integration.test.ts',
      'packages/shader-compiler/src/material/__tests__/vertex-color-publication.integration.test.ts',
      'packages/shader-compiler/src/material/__tests__/visible-surface-cook.integration.test.ts',
      // Run 44046829101 crossed their original cold-source budgets beside
      // instrumented Modeling. Preserve every complete file and drain neighbors.
      'packages/shader-compiler/src/__tests__/material-cook.unit.test.ts',
      'packages/shader-compiler/src/material/__tests__/gbuffer-publication.integration.test.ts',
      'packages/shader-compiler/src/material/__tests__/material-static-switches.integration.test.ts',
      'packages/shader-compiler/src/material/__tests__/node-material-pool.integration.test.ts',
      // Run 44117571697 crossed these original cold-source deadlines in the
      // broad instrumented child. Admit complete files with compiler Workers.
      'packages/shader-compiler/src/__tests__/material-surface-import.integration.test.ts',
      'packages/shader-compiler/src/__tests__/material-webgpu-build-profile.integration.test.ts',
      'packages/shader-compiler/src/material/__tests__/custom-surface-coverage.integration.test.ts',
      'packages/shader-compiler/src/material/__tests__/parameter-identifiers.integration.test.ts',
      'packages/shader-compiler/src/material/__tests__/ray-surface-derivatives.integration.test.ts',
      'packages/shader-compiler/src/material/__tests__/standard-static-shadow.integration.test.ts',
      'packages/shader-compiler/src/material/__tests__/surface-resources.integration.test.ts',
    ],
    receiptLabel:
      'packages/shader-compiler/src/material/__tests__/pack-program-reuse.integration.test.ts,packages/shader-compiler/src/material/__tests__/node-program-compiler.integration.test.ts',
    weight: 40,
    // Run 44024988647 crossed the added files' unchanged 30-second cold
    // cooking bounds. Keep the original receipt and reserve the full owner.
    reservationWeight: 960,
    sourceCompilation: true,
    packagesOnly: true,
  },
  {
    // Same run: preserve Runtime's real custom-Surface source cook and 30 s
    // bound, using the existing source-producer admission rather than sharing.
    project: '@forgeax/engine-runtime',
    files: ['packages/runtime/src/__tests__/custom-surface-publication.integration.test.ts'],
    batch: 'scriptable-publications',
    weight: 30,
    sourceCompilation: true,
    packagesOnly: true,
  },
  {
    // Run 40650966486 spent 247.73 s in this file inside the shared Pack child;
    // cold clearcoat cases exceeded their unchanged 30 s deadlines. Drain the
    // neighboring instrumented child before admitting the complete file.
    project: '@forgeax/engine-vite-plugin-pack',
    files: [
      'packages/vite-plugin-pack/src/__tests__/declared-standard-material.integration.test.ts',
      'packages/vite-plugin-pack/src/__tests__/imported-material-publication.integration.test.ts',
      'packages/vite-plugin-pack/src/__tests__/scriptable-standard-material.integration.test.ts',
    ],
    weight: 250,
    receiptLabel:
      'packages/vite-plugin-pack/src/__tests__/declared-standard-material.integration.test.ts',
    reservationWeight: 310,
    sourceCompilation: true,
    packagesOnly: true,
  },
  {
    // Run 44046829101 crossed both original 60 s import/cook/parse bounds
    // beside instrumented producers. Share the existing serial publication
    // child: its original project receipts already include these cases.
    project: '@forgeax/engine-gltf',
    files: [
      'packages/gltf/src/__tests__/diffuse-transmission-import.integration.test.ts',
      'packages/gltf/src/__tests__/physical-material-import.integration.test.ts',
    ],
    batch: 'scriptable-publications',
    weight: 120,
    sourceCompilation: true,
    packagesOnly: true,
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
    // Run 44190189587 crossed both original 15 s Standard/Skin cold-cook
    // bounds in a two-worker shared child with only one compiler lane each.
    // Keep the complete four-root artifact/ABI oracle and its original bounds.
    project: '@forgeax/engine-vite-plugin-shader',
    files: ['packages/vite-plugin-shader/src/__tests__/standard-material-cold-cook.unit.test.ts'],
    batch: 'source-contracts',
    weight: 60,
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
    sourceCompilation: true,
    // Run 41379898912 stranded this source-production owner in a late shared
    // child until the 45-minute job bound. Drain neighboring coverage work and
    // retain all three full source builds with the runner's compiler budget.
    // Historical rosters retain this complete child's original forecast.
    // The larger current Water roster admits three independent cold owners
    // below, preserving each complete producer and the enclosing job limit.
    weight: 920,
  },
  {
    // Run 43703295156 reached the real Vite child's unchanged 4500 ms bound
    // inside 225 instrumented files. Keep the complete browser-entry oracle
    // with the existing serial publication batch, without adding a child.
    project: '@forgeax/engine-import',
    files: ['packages/import/src/__tests__/browser-package-build.integration.test.ts'],
    batch: 'scriptable-publications',
    weight: 5,
  },
  {
    project: '@forgeax/engine-pack',
    files: ['packages/pack/src/__tests__/material-surface-publication.unit.test.ts'],
    batch: 'scriptable-publications',
    // Preserve this complete child's historical identity. The added cases
    // remain charged to their original broad receipts and add a reservation.
    batchReceiptLabel:
      '@forgeax/engine-pack:packages/pack/src/__tests__/material-surface-publication.unit.test.ts',
    weight: 20,
  },
  {
    // Run 42979759251 crossed both 5 s cases beside another cold compiler
    // child. Keep the real single/reusable Workers and all captured JSON bytes.
    project: '@forgeax/engine-pack',
    files: ['packages/pack/src/__tests__/scriptable-pack-json.integration.test.ts'],
    batch: 'scriptable-publications',
    weight: 15,
  },
  {
    // The same run crossed the 15 s module-load bound during a rebuild.
    // Retain the complete publication clock file and its unchanged deadlines.
    project: '@forgeax/engine-vite-plugin-pack',
    files: ['packages/vite-plugin-pack/src/__tests__/authored-pack-serving.regression.test.ts'],
    batch: 'scriptable-publications',
    weight: 15,
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

function parseWorkerOption(options, key, value) {
  if (key === '--group-concurrency') {
    options.groupConcurrency =
      value === 'auto' ? 'auto' : parsePositiveInt(value, key, { max: maxGroupConcurrency });
  } else if (key === '--max-workers') {
    options.maxWorkers = parsePositiveInt(value, key, { max: 6 });
  } else {
    options.modelingMaxWorkers = parsePositiveInt(value, key, { max: 2 });
  }
}

export function parseArgs(argv) {
  const typecheckOnly = argv.includes('--typecheck-only');
  const args = argv.filter((argument) => argument !== '--typecheck-only');
  const valueOptions = new Set([
    '--project',
    '--group-size',
    '--group-concurrency',
    '--max-workers',
    '--modeling-max-workers',
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
    modelingMaxWorkers: defaultMaxWorkers,
    mergeShards: null,
    outputFile: 'vitest-coverage-out.json',
    projects: [],
    shardCount: 1,
    shardIndex: 0,
    shardOutputDir: null,
    typecheck: true,
    typecheckOnly,
    vitestArgs: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
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
    const value = inlineValue ?? (valueOptions.has(key) ? args[++index] : undefined);
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
    } else if (
      key === '--group-concurrency' ||
      key === '--max-workers' ||
      key === '--modeling-max-workers'
    ) {
      parseWorkerOption(options, key, value);
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
  validateTypecheckOnlyOptions(options);
  if (options.shardCount > 1 && options.shardOutputDir === null) {
    throw new Error('--shard-count above 1 requires --shard-output-dir');
  }
  if (options.mergeShards !== null && (options.shardCount > 1 || options.shardOutputDir !== null)) {
    throw new Error('--merge-shards cannot be combined with shard execution options');
  }
  return options;
}

function validateTypecheckOnlyOptions(options) {
  if (!options.typecheckOnly) return;
  if (!options.typecheck)
    throw new Error('--typecheck-only cannot be combined with --skip-typecheck');
  if (options.shardOutputDir !== null || options.mergeShards !== null) {
    throw new Error('--typecheck-only cannot be combined with coverage shard outputs');
  }
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

// These registered Node app projects cook ordinary CPU assets or exercise DOM
// controls. They consume package outputs, not prepared Engine shader profiles.
export const packageOnlyNodeAppProjects = Object.freeze([
  '@forgeax/water-r5-gpu-mesh-async-pontoons',
  '@forgeax/water-r8-entry-experiment',
  '@forgeax/water-mesh-demo',
  '@forgeax/water-r8-integration-acceptance',
  'unit',
]);

export function allProjectNames() {
  return [
    ...packageProjectNames(),
    '@forgeax/hello-fxaa',
    '@forgeax/hello-physical-material',
    '@forgeax/hello-triangle',
    // Registered Node app projects share the primary/typecheck and coverage
    // selector. Keep the legacy eighty-project prefix on its original chunks.
    ...packageOnlyNodeAppProjects,
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

// Related cold contracts share one complete, serial Vitest child rather than
// paying several startups and consuming additional per-job tail slots.
// Their case work is already charged to the original project receipts. Zero
// additional historical weight is not a zero-time observation: current admission
// retains the complete independent forecast through the existing reservation.
function coalesceCoverageBatches(groups) {
  const batches = new Map();
  const result = [];
  for (const { batch, batchReceiptLabel, ...group } of groups) {
    if (!batch) {
      result.push(group);
      continue;
    }
    let entry = batches.get(batch);
    if (!entry) {
      const combined = {
        ...group,
        projects: [],
        files: [],
        weight: 0,
        reservationWeight: sourceContractStartupWeight,
      };
      entry = { group: combined, receiptLabel: batchReceiptLabel };
      batches.set(batch, entry);
      result.push(combined);
    }
    const combined = entry.group;
    // An explicit receipt may belong to a project visited later in the batch.
    // Earlier members add work, but do not replace that historical identity.
    entry.receiptLabel ??= batchReceiptLabel;
    for (const project of group.projects)
      if (!combined.projects.includes(project)) combined.projects.push(project);
    combined.files.push(...group.files);
    combined.reservationWeight += group.weight;
    const receiptProjects = entry.receiptLabel?.split(':')[0].split(',');
    combined.label = receiptProjects?.every((project) => combined.projects.includes(project))
      ? entry.receiptLabel
      : `${combined.projects.join(',')}:${combined.files.join(',')}`;
  }
  return result;
}

function currentCoverageReplays(applicableRuns, currentCohort) {
  if (!currentCohort) return applicableRuns;
  if (currentCohort.validationProfile !== 'core') return [currentCohort];
  // Daily cohorts share one execution profile. A fresh observation may change
  // the preferred layout, but it cannot erase an earlier daily replay window.
  return applicableRuns.filter(
    (run) => run.validationProfile === 'core' && run.requiredProjects?.length,
  );
}

// Coverage children are objects so a heavy test file can own its own child
// while the rest of its project keeps the ordinary project group. `label` is
// the stable identity the shard merge uses to prove every child ran once.
export function coverageGroups(
  projects,
  size,
  { isolateFiles = true, completed = completedCoverage, environment = process.env } = {},
) {
  // New project workloads must not rewrite a historical replay's file roster
  // or cold-source forecast. Their own qualified partial cohort applies only
  // when that required project is present in discovery.
  const applicableRuns = completed.replayRuns?.filter(
    (run) =>
      (run.requiredProjects ?? []).every((project) => projects.includes(project)) &&
      (run.validationProfile === undefined ||
        run.validationProfile ===
          (environment.FORGEAX_CI_CORE_VALIDATION === '1' ? 'core' : 'full')),
  );
  // A changed cold-source partition has no completed historical child with
  // that identity. Use its qualified current roster cohort, keeping older
  // complete-source identities and replay windows on their original roster.
  const currentCohort = applicableRuns?.findLast((run) => run.requiredProjects?.length);
  const replayRuns = currentCoverageReplays(applicableRuns, currentCohort);
  const unitNativeFileSets = isolateFiles ? [] : devkitNativeUnitFileSets;
  const deferredCoverage = new Set(isolateFiles ? coreDeferredCoverageFiles(environment) : []);
  const fileSets = (isolateFiles ? isolatedCoverageFileSets : unitNativeFileSets)
    .filter(({ project }) => projects.includes(project))
    .filter(({ files }) => !files.every((file) => deferredCoverage.has(file)))
    .flatMap((group) => {
      if (
        !projects.includes('@forgeax/engine-water') ||
        !group.files.includes(
          'packages/vite-plugin-shader/src/__tests__/direct-dfg-manifest.integration.test.ts',
        )
      )
        return [group];
      // Completed cases cost 468.640/472.873 s; the old serial owner paid
      // another 78 s before them. These three reservations are forecasts,
      // not completed receipts. Every cold case still compiles the full roster.
      return [
        { ...group, files: group.files.slice(0, 3), weight: 650 },
        // These standalone compiler contracts own fresh source production.
        { ...group, files: [group.files[3]], weight: 530, packagesOnly: true },
        // Run 43703295156 interrupted this full source case after 662 s.
        // Reserve its existing 900 s case budget without inventing a sample.
        {
          ...group,
          files: [group.files[4]],
          weight: 530,
          reservationWeight: 900,
          packagesOnly: true,
        },
      ];
    });
  const excludes = [...fileSets.flatMap(({ files }) => files), ...deferredCoverage];
  const groups = projectGroups(projects, size).flatMap((group) => [
    {
      label: group.join(','),
      projects: group,
      files: [],
      excludes,
      gpuLease: false,
      ...(group.every((project) => packageOnlyNodeAppProjects.includes(project))
        ? { packagesOnly: true }
        : {}),
      weight: group.reduce((total, project) => total + projectWeight(project), 0),
    },
    ...fileSets
      .filter(({ project }) => group.includes(project))
      .map(
        ({
          project,
          files,
          weight,
          reservationWeight,
          gpuLease = false,
          receiptLabel,
          batch,
          batchReceiptLabel,
          sourceCompilation = false,
          packagesOnly = false,
        }) => ({
          label: `${project}:${receiptLabel ?? files.join(',')}`,
          ...(batch === undefined ? {} : { batch }),
          ...(batchReceiptLabel === undefined ? {} : { batchReceiptLabel }),
          projects: [project],
          files,
          excludes: [],
          weight,
          ...(reservationWeight === undefined ? {} : { reservationWeight }),
          gpuLease,
          sourceCompilation,
          ...(packagesOnly ? { packagesOnly: true } : {}),
        }),
      ),
  ]);
  return coalesceCoverageBatches(groups)
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
        ...(projects.includes('@forgeax/engine-water') &&
        group.projects[0] === '@forgeax/engine-render'
          ? { requiresTwoWorkerJob: true }
          : {}),
        weight: Math.max(weight, partition.weight ?? 0),
      }));
    })
    .map((group) => {
      const receipt = isolateFiles && completed.groups[group.label];
      const weight = receipt
        ? Math.max(group.weight, Math.ceil(receipt.reservedSeconds / 5) * 5)
        : group.weight;
      const reservationWeight = Math.max(
        group.reservationWeight ?? weight,
        ...(replayRuns ?? []).map(
          (run) => Math.ceil((run.completedSeconds[group.label] ?? 0) / 5) * 5,
        ),
      );
      // A newly separated owner can have complete replay evidence without
      // rewriting the historical seed that already charged its case work.
      const hasReplay =
        isolateFiles &&
        replayRuns?.some(
          (run) =>
            run.completedSeconds[group.label] !== undefined ||
            run.reservedSeconds?.[group.label] !== undefined,
        );
      return receipt || hasReplay
        ? {
            ...group,
            weight,
            // Later partial cohorts own current capacity, not the earlier
            // complete seed's historical cost or missing-owner identity.
            ...(reservationWeight > weight || group.reservationWeight !== undefined
              ? { reservationWeight }
              : {}),
            // A partial refresh must not optimize against older partition
            // observations while its unmeasured peers retain a newer workload.
            observedSeconds: currentCohort
              ? currentCohort.completedSeconds[group.label]
              : receipt?.run === completed.latestRun
                ? receipt.latestSeconds
                : undefined,
            // Partial later runs are distinct scenarios, never restamped as a
            // complete cohort. Missing work keeps the admitted cohort forecast.
            replaySeconds: replayRuns?.map(
              (run) => run.completedSeconds[group.label] ?? run.reservedSeconds?.[group.label],
            ),
            replayReserved: replayRuns?.map(
              (run) =>
                run.completedSeconds[group.label] === undefined &&
                run.reservedSeconds?.[group.label] !== undefined,
            ),
            replayBudgetSeconds: replayRuns?.map((run) => run.budgetSeconds ?? 2300),
            replayTypechecks: replayRuns?.map((run) => run.typecheck),
          }
        : group;
    });
}

export function coverageGroupOrder(groups, typecheck = false) {
  if (typecheck) {
    return groups
      .map((_group, index) => index)
      .sort(
        (left, right) =>
          Number(groups[right].startEarly === true) - Number(groups[left].startEarly === true) ||
          (groups[right].observedSeconds ??
            groups[right].reservationWeight ??
            groups[right].weight) -
            (groups[left].observedSeconds ??
              groups[left].reservationWeight ??
              groups[left].weight) ||
          left - right,
      );
  }
  const scenarios = coverageReplayScenarios(groups, typecheck);
  const scores = groups.map(
    (_, index) =>
      scenarios.reduce((total, scenario) => total + scenario.weights[index] * scenario.scale, 0) /
      scenarios.length,
  );
  return groups
    .map((_group, index) => index)
    .sort(
      (left, right) =>
        Number(groups[right].startEarly === true) - Number(groups[left].startEarly === true) ||
        scores[right] - scores[left] ||
        left - right,
    );
}

export function scheduledGroupOrder(
  groups,
  { coverage, localGpuLease, typecheck = false, coverageOrder },
) {
  const order = coverage
    ? [...(coverageOrder ?? coverageGroupOrder(groups, typecheck))]
    : groups.map((_group, index) => index);
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

function appendCoverageLane(lane, group, useReservation = true) {
  const next = { parallel: [...lane.parallel], exclusive: lane.exclusive };
  const weight = useReservation ? (group.reservationWeight ?? group.weight) : group.weight;
  if (isExclusiveCoverageGroup(group)) next.exclusive += weight;
  else next.parallel[next.parallel[0] <= next.parallel[1] ? 0 : 1] += weight;
  return next;
}

function coverageLaneFinish(lane) {
  return Math.max(...lane.parallel) + lane.exclusive;
}

function coverageScenarioWeights(groups, completed, replay, useReservation, reservationMode) {
  const critical = completed ? criticalExclusiveCoverageGroup(groups) : -1;
  return groups.map((group, index) => {
    const retained = replay >= 0 ? group.replaySeconds?.[replay] : undefined;
    const reserved = group.replayReserved?.[replay] === true;
    const current =
      reservationMode === 'current' ? group.weight : Math.max(retained ?? 0, group.weight);
    const seconds =
      (reserved && reservationMode !== 'recorded' ? current : retained) ??
      (index !== critical ? group.observedSeconds : undefined);
    const forecast = completed && seconds !== undefined ? seconds : group.weight;
    return !completed && useReservation ? (group.reservationWeight ?? forecast) : forecast;
  });
}

function coverageReplayScenarios(groups, typecheck) {
  const replayCount = Math.max(0, ...groups.map((group) => group.replaySeconds?.length ?? 0));
  const budgets = groups.find((group) => group.replayBudgetSeconds)?.replayBudgetSeconds;
  const typechecks = groups.find((group) => group.replayTypechecks)?.replayTypechecks;
  return Array.from({ length: replayCount + 1 }, (_, index) => {
    const replay = index - 1;
    if (typechecks?.[replay] !== undefined && typechecks[replay] !== typecheck) return [];
    const budget = replay < 0 ? 2300 : (budgets?.[replay] ?? 2300);
    const reserved = groups.some((group) => group.replayReserved?.[replay]);
    const modes = reserved ? ['recorded', 'current', 'retained-max'] : ['recorded'];
    const seen = new Set();
    return modes.flatMap((mode) => {
      const weights = coverageScenarioWeights(groups, true, replay, true, mode);
      const key = weights.join(',');
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ weights, scale: 2300 / budget }];
    });
  }).flat();
}

function coverageModel(groups, shardCount, typecheck) {
  return {
    order: coverageAssignmentOrders.get(groups) ?? coverageGroupOrder(groups, typecheck),
    exclusive: groups.map(isExclusiveCoverageGroup),
    shardCount,
    typecheck,
    scratch: new Float64Array(shardCount * 3),
  };
}

// Synchronous call-local scratch; neither assignment nor recorded costs change.
function evaluateCoverageLanes(model, assignment, weights) {
  const lanes = model.scratch;
  lanes.fill(0);
  if (model.typecheck && model.shardCount > 1) lanes[0] = lanes[1] = typecheckSeconds;
  for (const index of model.order) {
    const shard = assignment[index];
    if (shard < 0) continue;
    const base = shard * 3;
    const slot = model.exclusive[index] ? 2 : lanes[base] <= lanes[base + 1] ? 0 : 1;
    lanes[base + slot] += weights[index];
  }
  return lanes;
}

function coverageModelFinish(lanes, shard) {
  const base = shard * 3;
  return Math.max(lanes[base], lanes[base + 1]) + lanes[base + 2];
}

export function coverageAssignmentLaneFinishes(
  groups,
  assignment,
  shardCount,
  typecheck,
  completed = false,
  replay = -1,
  useReservation = true,
  reservationMode = 'recorded',
) {
  const model = coverageModel(groups, shardCount, typecheck);
  const weights = coverageScenarioWeights(
    groups,
    completed,
    replay,
    useReservation,
    reservationMode,
  );
  const lanes = evaluateCoverageLanes(model, assignment, weights);
  return Array.from({ length: shardCount }, (_, shard) => coverageModelFinish(lanes, shard));
}

function coverageAssignmentFinish(
  groups,
  assignment,
  shardCount,
  typecheck,
  completed = false,
  useReservation = true,
) {
  return Math.max(
    ...coverageAssignmentLaneFinishes(
      groups,
      assignment,
      shardCount,
      typecheck,
      completed,
      -1,
      useReservation,
    ),
  );
}

function criticalExclusiveCoverageGroup(groups) {
  return groups.reduce(
    (selected, group, index) =>
      group.files?.length > 0 &&
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
function retainsExclusiveCoverageHeadroom(inputs, assignment, index, shard) {
  const { critical, exclusive } = inputs;
  if (critical < 0) return true;
  const destination = index === critical ? shard : assignment[critical];
  if (destination < 0) return true;
  return !exclusive.some(
    (position) => (position === index ? shard : assignment[position]) === destination,
  );
}

// A sparse partial refresh cannot justify concentrating its few measured slow
// owners. Retain the even-share spread until a full optimization cohort exists.
function retainsSparseCoverageSpread(inputs, assignment, index, shard) {
  if (inputs.sparseLimit === 0 || !inputs.measured.has(index)) return true;
  return countCoverageNeighbors(inputs.measured, assignment, index, shard) < inputs.sparseLimit;
}

// Placement repeatedly tests candidate assignments against the same roster.
// Normalize the static facts once while retaining the live lane constraints.
function prepareCoveragePlacement(groups, shardCount) {
  const critical = criticalExclusiveCoverageGroup(groups);
  const exclusive = [];
  const measured = new Set();
  const broad = [];
  const siblings = new Map();
  const partitions = groups.map((group, index) => {
    if (index !== critical && isExclusiveCoverageGroup(group)) exclusive.push(index);
    if (group.observedSeconds !== undefined) measured.add(index);
    if (!group.shard) return null;
    const [part, count] = group.shard.split('/').map(Number);
    if (count <= shardCount) broad.push(index);
    const project = group.projects[0];
    const cohort = siblings.get(project) ?? [];
    cohort.push(index);
    siblings.set(project, cohort);
    return { count, project, wave: Math.floor((part - 1) / shardCount) };
  });
  return {
    critical,
    exclusive,
    measured,
    sparseLimit:
      measured.size < shardCount || measured.size >= 20 ? 0 : Math.ceil(measured.size / shardCount),
    childLimit: Math.min(16, Math.ceil(groups.length / shardCount) + 1),
    broad,
    broadLimit: Math.ceil(broad.length / shardCount),
    siblings,
    partitions,
  };
}

function countCoverageNeighbors(indexes, assignment, index, shard) {
  let count = 0;
  for (const position of indexes) {
    if (position !== index && assignment[position] === shard) count += 1;
  }
  return count;
}

// Broad project halves span jobs; fine partitions retain both spread quotas
// and source headroom while complete-child placement balances measured work.
function admitsCoverageWorkerPolicy(group, shard, shardCount) {
  // Run 43693841655 spent 1233.27 s importing/executing 559 Render files
  // on a one-worker job. Jobs zero/two already admit two ordinary workers;
  // use that existing budget without increasing concurrency or case bounds.
  return shardCount !== 4 || group.requiresTwoWorkerJob !== true || shard === 0 || shard === 2;
}

function canPlaceCoverageGroup(groups, assignment, index, shard, shardCount) {
  if (!admitsCoverageWorkerPolicy(groups[index], shard, shardCount)) return false;
  const inputs =
    coveragePlacementInputs.get(groups) ?? prepareCoveragePlacement(groups, shardCount);
  if (!retainsExclusiveCoverageHeadroom(inputs, assignment, index, shard)) return false;
  if (!retainsSparseCoverageSpread(inputs, assignment, index, shard)) return false;
  // Timings do not bound startup and serial tails when a few cold children
  // overrun. Keep at most one child above the even share on every physical job.
  let childNeighbors = 0;
  for (let position = 0; position < assignment.length; position += 1) {
    if (position !== index && assignment[position] === shard) childNeighbors += 1;
  }
  if (childNeighbors >= inputs.childLimit) return false;
  const partition = inputs.partitions[index];
  if (!partition) return true;
  const { count, project, wave } = partition;
  const siblings = inputs.siblings.get(project);
  if (countCoverageNeighbors(siblings, assignment, index, shard) >= Math.ceil(count / shardCount))
    return false;
  if (count > shardCount) {
    return !siblings.some(
      (position) =>
        position !== index &&
        assignment[position] === shard &&
        inputs.partitions[position].wave === wave,
    );
  }
  return countCoverageNeighbors(inputs.broad, assignment, index, shard) < inputs.broadLimit;
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
// 24 complete permutations, avoiding a greedy dead end under the complete-wave spread quota.
function placeFineCoverageWave(groups, indexes, assignment, lanes, shardCount, costs) {
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
      nextLanes[shard] = appendCoverageLane(
        projected[shard],
        { ...groups[index], weight: costs[index] },
        false,
      );
      visit(offset + 1, next, nextLanes);
    }
  }
  visit(0, assignment, lanes);
  if (!best) throw new Error(`no coverage lanes admit complete wave ${groups[indexes[0]].label}`);
  return best;
}

// The actual 16-part/four-job roster has at most 576 complete wave/rank
// allocations. Larger future rosters keep bounded wave admission and local moves.
function* coverageAssignmentCandidates(groups, assignment, shardCount) {
  // Typecheck occupies physical job zero. Move whole admitted rosters as well
  // as individual owners so job zero can receive a lighter existing roster.
  for (let shard = 1; shard < shardCount; shard++) {
    const candidate = assignment.map((lane) => (lane === 0 ? shard : lane === shard ? 0 : lane));
    if (
      candidate.every((lane, index) => admitsCoverageWorkerPolicy(groups[index], lane, shardCount))
    )
      yield candidate;
  }
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
}

// Typecheck/startup headroom can require an atomic fine-wave rotation even
// when no single move or pair swap improves all retained windows.
function* completedCoverageCandidates(groups, assignment, shardCount, finish) {
  yield* coverageAssignmentCandidates(groups, assignment, shardCount);
  if (finish <= 2300 || shardCount > 4) return;
  const waves = new Map();
  groups.forEach((group, index) => {
    if (!group.shard) return;
    const [part, count] = group.shard.split('/').map(Number);
    const key =
      count <= shardCount ? 'broad' : `${group.projects[0]}:${Math.floor((part - 1) / shardCount)}`;
    const indexes = waves.get(key) ?? [];
    indexes.push(index);
    waves.set(key, indexes);
  });
  for (const indexes of waves.values()) {
    if (indexes.length !== shardCount) continue;
    function* place(lanes) {
      if (lanes.length < indexes.length) {
        for (let lane = 0; lane < shardCount; lane++) {
          if (!lanes.includes(lane)) yield* place([...lanes, lane]);
        }
        return;
      }
      const candidate = [...assignment];
      indexes.forEach((index, position) => {
        candidate[index] = lanes[position];
      });
      if (
        indexes.every((index) =>
          canPlaceCoverageGroup(groups, candidate, index, candidate[index], shardCount),
        )
      ) {
        yield candidate;
      }
    }
    yield* place([]);
  }
}

function balanceCompletedCoverage(groups, assignment, shardCount, typecheck) {
  if (!groups.some((group) => group.observedSeconds !== undefined)) return assignment;
  let current = assignment;
  let metrics = coverageAssignmentMetrics(groups, current, shardCount, typecheck);
  for (;;) {
    let best = current;
    let bestMetrics = metrics;
    for (const candidate of completedCoverageCandidates(
      groups,
      current,
      shardCount,
      metrics.finish,
    )) {
      const candidateMetrics = coverageAssignmentMetrics(groups, candidate, shardCount, typecheck);
      if (completedCoverageMetricsImprove(candidateMetrics, bestMetrics)) {
        best = candidate;
        bestMetrics = candidateMetrics;
      }
    }
    if (best === current) return current;
    current = best;
    metrics = bestMetrics;
  }
}

function prepareCoverageAssignmentInputs(groups, shardCount, typecheck) {
  return {
    model: coverageModel(groups, shardCount, typecheck),
    scenarios: coverageReplayScenarios(groups, typecheck),
    reservation: coverageScenarioWeights(groups, false, -1, false, 'recorded'),
  };
}

function coverageAssignmentMetrics(groups, assignment, shardCount, typecheck) {
  let inputs = coverageAssignmentInputs.get(groups);
  if (!inputs) {
    inputs = prepareCoverageAssignmentInputs(groups, shardCount, typecheck);
    coverageAssignmentInputs.set(groups, inputs);
  }
  const { model } = inputs;
  let finish = 0,
    spread = 0;
  const violations = [];
  for (const scenario of inputs.scenarios) {
    const lanes = evaluateCoverageLanes(model, assignment, scenario.weights);
    for (let shard = 0; shard < shardCount; shard++) {
      const seconds = coverageModelFinish(lanes, shard) * scenario.scale;
      finish = Math.max(finish, seconds);
      spread += seconds * seconds;
      if (seconds > 2300) violations.push(seconds - 2300);
    }
  }
  const reserved = evaluateCoverageLanes(model, assignment, inputs.reservation);
  const reservation = Math.max(
    ...Array.from({ length: shardCount }, (_, shard) => coverageModelFinish(reserved, shard)),
  );
  return { finish, violation: Math.hypot(...violations), reservation, spread };
}

function completedCoverageCacheKey(groups, shardCount, typecheck) {
  return JSON.stringify([
    shardCount,
    typecheck,
    groups.map((group) => [
      group.label,
      group.weight,
      group.reservationWeight ?? null,
      group.observedSeconds ?? null,
      group.replaySeconds ?? null,
      group.replayReserved ?? null,
      group.replayBudgetSeconds ?? null,
      group.replayTypechecks ?? null,
      group.shard ?? null,
      group.startEarly === true,
      group.requiresTwoWorkerJob === true,
      group.gpuLease === true,
      group.projects,
      group.files,
    ]),
  ]);
}

function completedCoverageRandom() {
  // Keep all retained complete and partial replay windows deterministic.
  let state = 0x00000024;
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

// Equal-size swaps preserve each job's child count. A one-for-two exchange
// crosses that barrier while retaining complete owners and all admission caps.
function completedCoverageUnequalExchange(groups, current, shardCount, indexes, random) {
  const first = indexes[Math.floor(random() * indexes.length)];
  const source = current[first];
  const target = (source + 1 + Math.floor(random() * (shardCount - 1))) % shardCount;
  const neighbors = indexes.filter((index) => current[index] === target);
  if (neighbors.length < 2) return null;
  const second = Math.floor(random() * neighbors.length);
  const third = (second + 1 + Math.floor(random() * (neighbors.length - 1))) % neighbors.length;
  const changed = [first, neighbors[second], neighbors[third]];
  const candidate = [...current];
  candidate[first] = target;
  candidate[neighbors[second]] = source;
  candidate[neighbors[third]] = source;
  return changed.every((index) =>
    canPlaceCoverageGroup(groups, candidate, index, candidate[index], shardCount),
  )
    ? candidate
    : null;
}

function completedCoverageCandidate(
  groups,
  current,
  move,
  shardCount,
  broadIndexes,
  fineIndexes,
  movableIndexes,
  random,
) {
  if (move === 6)
    return completedCoverageUnequalExchange(groups, current, shardCount, movableIndexes, random);
  const candidate = [...current];
  if (move === 0) {
    const lanes = shuffleCoverageLanes(shardCount, random);
    broadIndexes.forEach((index, offset) => {
      candidate[index] = lanes[offset];
    });
    return broadIndexes.every((index) =>
      canPlaceCoverageGroup(groups, candidate, index, candidate[index], shardCount),
    )
      ? candidate
      : null;
  }
  // A complete fine wave can cross a placement barrier that individual
  // swaps cannot, while retaining one child on every physical job.
  if (move === 4) {
    const selected = groups[fineIndexes[Math.floor(random() * fineIndexes.length)]];
    const wave = Math.floor((Number(selected.shard.split('/')[0]) - 1) / shardCount);
    const indexes = fineIndexes.filter(
      (index) =>
        groups[index].projects[0] === selected.projects[0] &&
        Math.floor((Number(groups[index].shard.split('/')[0]) - 1) / shardCount) === wave,
    );
    if (indexes.length !== shardCount) return null;
    const lanes = shuffleCoverageLanes(shardCount, random);
    indexes.forEach((index, offset) => {
      candidate[index] = lanes[offset];
    });
    return indexes.every((index) =>
      canPlaceCoverageGroup(groups, candidate, index, candidate[index], shardCount),
    )
      ? candidate
      : null;
  }
  if (move === 1 || move === 2 || move === 5) {
    const indexes = Array.from({ length: move === 5 ? 4 : move + 1 }, () =>
      Math.floor(random() * groups.length),
    );
    if (new Set(indexes).size !== indexes.length) return null;
    indexes.forEach((index, offset) => {
      candidate[index] = current[indexes[(offset + 1) % indexes.length]];
    });
    if (
      indexes.some(
        (index) => !canPlaceCoverageGroup(groups, candidate, index, candidate[index], shardCount),
      )
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
  const currentFits = current.finish <= 2300;
  const candidateFits = candidate.finish <= 2300;
  if (currentFits !== candidateFits) return candidateFits;
  const delta = currentFits
    ? candidate.reservation - current.reservation
    : candidate.violation - current.violation;
  const temperature = 35 * 0.02 ** (iteration / completedCoverageSearchIterations);
  return delta <= 0 || random() < Math.exp(-delta / temperature);
}

function completedCoverageMetricsImprove(candidate, current) {
  const currentFits = current.finish <= 2300;
  const candidateFits = candidate.finish <= 2300;
  if (currentFits !== candidateFits) return candidateFits;
  if (currentFits && candidate.reservation !== current.reservation) {
    return candidate.reservation < current.reservation;
  }
  if (!currentFits && candidate.violation !== current.violation) {
    return candidate.violation < current.violation;
  }
  return (
    candidate.finish < current.finish ||
    (candidate.finish === current.finish && candidate.spread < current.spread)
  );
}

// A bounded deterministic search escapes one-move scheduling minima in the
// partial run replay. Keep complete-group and roster constraints. Historical
// maxima remain the balancing objective once every retained run fits its own
// window. Their envelope is not another hard deadline: independent historical
// maxima need not have occurred simultaneously.
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

  let best = [...assignment];
  let bestMetrics = coverageAssignmentMetrics(groups, best, shardCount, typecheck);
  const random = completedCoverageRandom();

  // Stop restarting once every retained scenario fits its original window.
  for (
    let restart = 0;
    restart < completedCoverageSearchRestarts && bestMetrics.finish > 2300;
    restart += 1
  ) {
    let current = [...best];
    // Each restart starts from a distinct recorded cost scenario, while the
    // shared scorer still requires every original window and admission rule.
    if (restart > 0) {
      const scenarios = coverageAssignmentInputs.get(groups).scenarios;
      current = greedyCoverageAssignment(
        groups,
        shardCount,
        typecheck,
        scenarios[(restart - 1) % scenarios.length].weights,
      );
    }
    let currentMetrics = coverageAssignmentMetrics(groups, current, shardCount, typecheck);

    for (let iteration = 0; iteration < completedCoverageSearchIterations; iteration += 1) {
      // Runtime-only cohorts can rebalance job sizes; keep the established
      // typechecked search with its fixed job-zero reservation unchanged.
      const move = Math.floor(random() * (typecheck ? 6 : 7));
      const candidate = completedCoverageCandidate(
        groups,
        current,
        move,
        shardCount,
        broadIndexes,
        fineIndexes,
        movableIndexes,
        random,
      );
      if (!candidate) continue;
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
    // Refine each completed restart before exploring from its best placement.
    // Waiting until all restarts finish can strand a useful wave rotation.
    best = balanceCompletedCoverage(groups, best, shardCount, typecheck);
    bestMetrics = coverageAssignmentMetrics(groups, best, shardCount, typecheck);
  }
  return balanceCompletedCoverage(groups, best, shardCount, typecheck);
}

// A bounded two-step exchange can cross a one-move minimum. Intermediate
// assignments retain structural admission; the scorer retains every window.
function repairCompletedCoverage(groups, assignment, shardCount, typecheck) {
  if (groups.length > 80) return assignment;
  let current = assignment;
  let metrics = coverageAssignmentMetrics(groups, current, shardCount, typecheck);
  for (let round = 0; round < shardCount && metrics.finish > 2300; round++) {
    const neighbors = [...coverageAssignmentCandidates(groups, current, shardCount)].map(
      (assignment) => ({
        assignment,
        metrics: coverageAssignmentMetrics(groups, assignment, shardCount, typecheck),
      }),
    );
    neighbors.sort((left, right) =>
      completedCoverageMetricsImprove(left.metrics, right.metrics)
        ? -1
        : completedCoverageMetricsImprove(right.metrics, left.metrics)
          ? 1
          : 0,
    );
    let best = current,
      bestMetrics = metrics;
    for (const first of neighbors.slice(0, 16)) {
      for (const candidate of coverageAssignmentCandidates(groups, first.assignment, shardCount)) {
        const projected = coverageAssignmentMetrics(groups, candidate, shardCount, typecheck);
        if (completedCoverageMetricsImprove(projected, bestMetrics)) {
          best = candidate;
          bestMetrics = projected;
        }
      }
    }
    if (best === current) break;
    current = balanceCompletedCoverage(groups, best, shardCount, typecheck);
    metrics = coverageAssignmentMetrics(groups, current, shardCount, typecheck);
  }
  return current;
}

function retainedCoverageWindowsFit(groups, assignment, shardCount, typecheck) {
  const budgets = groups.find((group) => group.replayBudgetSeconds)?.replayBudgetSeconds ?? [];
  const replayCount = Math.max(0, ...groups.map((group) => group.replaySeconds?.length ?? 0));
  return Array.from({ length: replayCount + 1 }, (_value, index) => {
    const replay = index - 1;
    const budget = replay < 0 ? 2300 : (budgets[replay] ?? 2300);
    return ['recorded', 'current', 'retained-max'].every((reservationMode) => {
      const finishes = coverageAssignmentLaneFinishes(
        groups,
        assignment,
        shardCount,
        typecheck,
        true,
        replay,
        true,
        reservationMode,
      );
      return Math.max(...finishes) <= budget;
    });
  }).every(Boolean);
}

// New reserved owners can move to another job after the baseline receipt
// schedule is built, but only when every retained run still fits its window.
function placeReservedCoverageOwners(groups, assignment, shardCount, typecheck) {
  const reserved = groups
    .map((_group, index) => index)
    .filter(
      (index) => (groups[index].reservationWeight ?? groups[index].weight) > groups[index].weight,
    )
    .sort(
      (left, right) =>
        (groups[right].reservationWeight ?? groups[right].weight) -
        groups[right].weight -
        ((groups[left].reservationWeight ?? groups[left].weight) - groups[left].weight),
    );
  let current = [...assignment];
  for (const index of reserved) {
    let best = current;
    let bestFinish = coverageAssignmentFinish(groups, current, shardCount, typecheck);
    for (let shard = 0; shard < shardCount; shard += 1) {
      if (
        shard === current[index] ||
        !canPlaceCoverageGroup(groups, current, index, shard, shardCount)
      )
        continue;
      const candidate = [...current];
      candidate[index] = shard;
      if (!retainedCoverageWindowsFit(groups, candidate, shardCount, typecheck)) continue;
      const finish = coverageAssignmentFinish(groups, candidate, shardCount, typecheck);
      if (finish < bestFinish) {
        best = candidate;
        bestFinish = finish;
      }
    }
    current = best;
  }
  return current;
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
  let finish = coverageAssignmentFinish(groups, current, shardCount, typecheck, false, false);
  for (;;) {
    let best = current;
    let bestFinish = finish;
    for (const candidate of coverageAssignmentCandidates(groups, current, shardCount)) {
      const candidateFinish = coverageAssignmentFinish(
        groups,
        candidate,
        shardCount,
        typecheck,
        false,
        false,
      );
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

function greedyCoverageAssignment(
  groups,
  shardCount,
  typecheck,
  costs = groups.map((group) => group.weight),
) {
  let lanes = coverageLanes(shardCount, typecheck);
  const critical = criticalExclusiveCoverageGroup(groups);
  const weights = groups.map(
    (group, index) => costs[index] * (isExclusiveCoverageGroup(group) ? 2 : 1),
  );
  const order = groups
    .map((_group, index) => index)
    .sort(
      (a, b) =>
        Number(b === critical) - Number(a === critical) ||
        Number(isExclusiveCoverageGroup(groups[b])) - Number(isExclusiveCoverageGroup(groups[a])) ||
        // Admit constrained broad halves before an unconstrained peer can
        // consume their two-worker jobs during a measured-cost restart.
        Number(groups[b].requiresTwoWorkerJob === true) -
          Number(groups[a].requiresTwoWorkerJob === true) ||
        weights[b] - weights[a] ||
        a - b,
    );
  let assignment = Array(groups.length).fill(-1);
  for (const index of order) {
    if (assignment[index] >= 0) continue;
    const wave = fineCoverageWave(groups, order, index, shardCount);
    if (wave) {
      const planned = placeFineCoverageWave(groups, wave, assignment, lanes, shardCount, costs);
      assignment = planned.assignment;
      lanes = planned.lanes;
      continue;
    }
    const projected = { ...groups[index], weight: costs[index] };
    const candidates = lanes.map((lane) => appendCoverageLane(lane, projected, false));
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
  return assignment;
}

// A frozen forecast is only a search seed, never executed CI evidence. Recheck
// its exact roster, admission and every current replay before accepting it.
export function coveragePlacementSeed(
  groups,
  shardCount,
  typecheck,
  seed = completedCoverage.placementSeeds?.find(
    (seed) =>
      seed.shardCount === shardCount &&
      seed.typecheck === typecheck &&
      Object.keys(seed.assignment).length === groups.length &&
      groups.every((group) => Object.hasOwn(seed.assignment, group.label)),
  ),
) {
  if (!seed || seed.shardCount !== shardCount || seed.typecheck !== typecheck) return null;
  if (Object.keys(seed.assignment).length !== groups.length) return null;
  const assignment = groups.map((group) => seed.assignment[group.label]);
  if (
    assignment.some((shard) => !Number.isInteger(shard) || shard < 0 || shard >= shardCount) ||
    assignment.some(
      (shard, index) => !canPlaceCoverageGroup(groups, assignment, index, shard, shardCount),
    )
  )
    return null;
  return coverageAssignmentMetrics(groups, assignment, shardCount, typecheck).finish <= 2300
    ? assignment
    : null;
}

export function assignCoverageShards(groups, shardCount, { typecheck = true } = {}) {
  // Local single-job execution still serializes exclusive children; it has no
  // peer job onto which a placement constraint could move a complete owner.
  if (shardCount === 1) return Array(groups.length).fill(0);
  coveragePlacementInputs.set(groups, prepareCoveragePlacement(groups, shardCount));
  try {
    return planCoverageShards(groups, shardCount, typecheck);
  } finally {
    coveragePlacementInputs.delete(groups);
  }
}

function planCoverageShards(groups, shardCount, typecheck) {
  coverageAssignmentOrders.set(groups, coverageGroupOrder(groups, typecheck));
  coverageAssignmentInputs.delete(groups);
  const cached = cachedCoverageAssignment(groups, shardCount, typecheck);
  if (cached?.assignment) return cached.assignment;
  const seed = coveragePlacementSeed(groups, shardCount, typecheck);
  const assignment = seed ?? greedyCoverageAssignment(groups, shardCount, typecheck);
  const balanced = seed ?? refineCoverageAssignment(groups, assignment, shardCount, typecheck);
  const optimized = placeReservedCoverageOwners(
    groups,
    repairCompletedCoverage(
      groups,
      optimizeCompletedCoverage(groups, balanced, shardCount, typecheck),
      shardCount,
      typecheck,
    ),
    shardCount,
    typecheck,
  );
  if (cached) {
    if (completedCoverageAssignmentCache.size >= 8) {
      completedCoverageAssignmentCache.delete(completedCoverageAssignmentCache.keys().next().value);
    }
    completedCoverageAssignmentCache.set(cached.key, [...optimized]);
  }
  coverageAssignmentInputs.delete(groups);
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

function logSourceCompilationCommand(child, args, env, enabled) {
  if (!enabled) return;
  process.stderr.write(
    `${JSON.stringify({
      kind: 'vitest-source-compilation-command',
      phase: 'start',
      command: [process.execPath, ...args],
      pid: child.pid,
      nodeOptions: env.NODE_OPTIONS ?? '',
      shaderWorkers: env.FORGEAX_SHADER_COMPILE_WORKERS,
    })}\n`,
  );
}

export function runChild(
  args,
  { env = process.env, progress, filePhases = false, sourcePhases = false } = {},
) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: rootDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    logSourceCompilationCommand(child, args, env, sourcePhases);
    const stdout = [];
    const stderr = [];
    const phases =
      progress && sourcePhases
        ? createModelingFilePhaseStream(
            progress,
            sourceCompilationPhasePrefix,
            '[vitest-source-compilation-phase-live] ',
          )
        : filePhases && progress
          ? createModelingFilePhaseStream(progress)
          : null;
    let outputBytes = 0;
    let outputError = null;
    const collect = (stream, chunks) => (chunk) => {
      if (stream === 'stderr') phases?.collect(chunk);
      outputBytes += chunk.length;
      if (outputBytes > maxChildOutputBytes) {
        outputError ??= new Error(
          `Vitest child output exceeded ${maxChildOutputBytes} bytes; refusing to buffer unbounded concurrent logs`,
        );
        phases?.stop();
        child.kill('SIGTERM');
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', collect('stdout', stdout));
    child.stderr.on('data', collect('stderr', stderr));
    child.on('error', (error) => {
      phases?.stop();
      resolve({ error, status: null, signal: null, stdout, stderr });
    });
    child.on('close', (status, signal) => {
      phases?.stop();
      resolve({ error: outputError, status, signal, stdout, stderr });
    });
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

// Ordinary files retain isolation and share the same bounded worker budget.
// Explicit source owners stay serial, including multi-file cold publications.
export function coverageGroupMaxWorkers(group, options, resources, groupConcurrency) {
  if (!options.coverage) return options.maxWorkers;
  if (isExclusiveCoverageGroup(group)) return 1;
  const requested =
    group.shard && group.projects.length === 1 && group.projects[0] === '@forgeax/engine-modeling'
      ? Math.max(options.maxWorkers, options.modelingMaxWorkers)
      : options.maxWorkers;
  const cpuBudget = Math.floor(resources.cpus / groupConcurrency) - 2;
  const memoryBudget = Math.floor(
    ((resources.memoryBytes / 1024 ** 3 - 3) / groupConcurrency - 1) / 2,
  );
  return Math.max(1, Math.min(requested, cpuBudget, memoryBudget));
}

/** Cold source owners keep one file worker and admit their compiler pool within capacity. */
export function coverageGroupEnvironment(
  group,
  resources,
  shaderWorkers,
  environment = process.env,
) {
  const childEnvironment = { ...environment };
  delete childEnvironment.FORGEAX_SHADER_COMPILE_DIAGNOSTICS;
  if (!group.sourceCompilation)
    return { ...childEnvironment, FORGEAX_SHADER_COMPILE_WORKERS: String(shaderWorkers) };
  if (!isExclusiveCoverageGroup(group))
    throw new Error('Source compilation requires an exclusive coverage owner');
  return {
    ...childEnvironment,
    FORGEAX_SHADER_COMPILE_DIAGNOSTICS: '1',
    NODE_OPTIONS: [
      environment.NODE_OPTIONS,
      `--max-old-space-size=${shaderProducerHeapSize(resources)}`,
    ]
      .filter(Boolean)
      .join(' '),
    FORGEAX_SHADER_COMPILE_WORKERS: String(shaderSourceCompileWorkers(resources, shaderWorkers)),
  };
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
    ...(group.projects.length === 1 && group.projects[0] === '@forgeax/engine-modeling'
      ? [`--reporter=${path.join(scriptDir, 'modeling-file-phase-reporter.mjs')}`]
      : []),
    ...(group.sourceCompilation
      ? [`--reporter=${path.join(scriptDir, 'source-compilation-phase-reporter.mjs')}`]
      : []),
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

function resolveProjects(options) {
  const discovered = allProjectNames();
  const projects = options.projects.length ? options.projects : discovered;
  const unknown = projects.filter((project) => !discovered.includes(project));
  if (unknown.length) throw new Error(`unknown Vitest project(s): ${unknown.join(', ')}`);
  return projects;
}

async function runVitestTypecheckOnly(options) {
  const startedAt = Date.now();
  await runTypecheck({
    cliPath: path.join(scriptDir, 'run-vitest-projects.mjs'),
    projects: resolveProjects(options),
    maxWorkers: options.maxWorkers,
  });
  process.stderr.write(
    `[vitest] typecheck-only preflight passed in ${((Date.now() - startedAt) / 1000).toFixed(2)}s\n`,
  );
}

function groupExecutionConcurrency(options, resources) {
  const concurrency =
    options.groupConcurrency === 'auto'
      ? coverageGroupConcurrency(resources)
      : options.groupConcurrency;
  if (!options.coverage && concurrency > 1 && options.maxWorkers > 1) {
    throw new Error(
      'concurrent groups require --max-workers=1 to preserve the isolated coverage memory bound',
    );
  }
  return concurrency;
}

async function main(options) {
  const projects = resolveProjects(options);
  const groups = coverageGroups(projects, options.groupSize, { isolateFiles: options.coverage });
  if (options.mergeShards !== null) {
    mergeShards({ options, groups });
    return;
  }
  const shardAssignment = assignCoverageShards(groups, options.shardCount, {
    typecheck: options.typecheck,
  });
  const selectedGroupIndices = groups.flatMap((_group, index) =>
    shardAssignment[index] === options.shardIndex ? [index] : [],
  );
  const selectedGroups = selectedGroupIndices.map((index) => groups[index]);
  const localGpuLease = process.env.FORGEAX_LOCAL_GPU_LEASE === '1';
  const selectedPosition = new Map(
    selectedGroupIndices.map((globalIndex, selectedIndex) => [globalIndex, selectedIndex]),
  );
  const coverageOrder = coverageGroupOrder(groups, options.typecheck)
    .filter((index) => shardAssignment[index] === options.shardIndex)
    .map((index) => selectedPosition.get(index));
  const groupOrder = scheduledGroupOrder(selectedGroups, {
    coverage: options.coverage,
    localGpuLease,
    typecheck: options.typecheck,
    coverageOrder,
  });
  const selectedProjects = [...new Set(selectedGroups.flatMap((group) => group.projects))];
  const runsTypecheck = options.coverage && options.typecheck && options.shardIndex === 0;
  const resources = runnerResources();
  const groupConcurrency = groupExecutionConcurrency(options, resources);
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
        const maxWorkers = coverageGroupMaxWorkers(group, options, resources, groupConcurrency);
        const shaderWorkers = group.sourceCompilation
          ? shaderSourceCompileWorkers(resources, process.env.FORGEAX_SHADER_COMPILE_WORKERS)
          : shaderCompileWorkers(
              resources,
              process.env.FORGEAX_SHADER_COMPILE_WORKERS,
              (isExclusiveCoverageGroup(group) ? 1 : groupConcurrency) * maxWorkers,
            );
        const runBrowserCommandImpl =
          group.gpuLease && localGpuLease
            ? (await import('./run-browser-gate-with-retry.mjs')).runBrowserCommand
            : undefined;
        process.stderr.write(
          `[vitest] ${options.coverage ? 'coverage' : 'bounded unit'} group ${index + 1}/${selectedGroups.length}: ${group.label} (testWorkers=${maxWorkers}, shaderWorkers=${shaderWorkers})\n`,
        );
        const run = () =>
          runGroup({
            cliPath,
            group,
            groupIndex: index + 1,
            maxWorkers,
            coverage: options.coverage,
            vitestArgs: options.vitestArgs,
            runChildImpl: (args) => {
              // Copy after local GPU admission so the child inherits its held lease.
              const env = coverageGroupEnvironment(group, resources, shaderWorkers);
              if (options.coverage) env.NODE_DISABLE_COMPILE_CACHE = '1';
              return runBrowserCommandImpl
                ? runBrowserCommandImpl([process.execPath, ...args], { label, env })
                : runChild(args, {
                    env,
                    sourcePhases: options.coverage && group.sourceCompilation === true,
                    filePhases:
                      options.coverage &&
                      group.projects.length === 1 &&
                      group.projects[0] === '@forgeax/engine-modeling',
                    progress: {
                      groupIndex: index + 1,
                      total: selectedGroups.length,
                      label: group.label,
                    },
                  });
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
    const options = parseArgs(process.argv.slice(2));
    if (options.typecheckOnly) await runVitestTypecheckOnly(options);
    else await main(options);
  } catch (error) {
    process.stderr.write(`[vitest] split coverage failed: ${error.message}\n`);
    if (error.signal) process.kill(process.pid, error.signal);
    process.exitCode = 1;
  }
}
