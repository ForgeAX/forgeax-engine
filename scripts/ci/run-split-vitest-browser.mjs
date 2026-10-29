#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGroups } from '../lib/run-bounded-groups.mjs';
import { readMemoryPressureDiagnostics } from '../lib/runner-resources.mjs';
import { readBrowserCosts, summarizeBrowserCosts } from './browser-cost-report.mjs';
import hostFiles from './browser-host-files.json' with { type: 'json' };
import { browserProcessCacheDir } from './browser-process-cache.mjs';
import { runBrowserCommand } from './run-browser-gate-with-retry.mjs';

const browserHostFiles = new Set(hostFiles);
export function browserGroupIsHostOnly(group) {
  return group.length > 0 && group.every((file) => browserHostFiles.has(file));
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '../..');
const defaultGroupSize = 8;
const defaultMaxWorkers = 1;
const defaultGroupConcurrency = 1;
const maxGroupConcurrency = 3;
const browserGroupTimeoutMs = 300_000;
const directLightBrowserGroupTimeoutMs = 420_000;
const previewBrowserGroupTimeoutMs = 420_000;
const surfaceProvenanceBrowserGroupTimeoutMs = 360_000;
const generatedLodBrowserGroupTimeoutMs = 630_000;
const browserNodeHeapArg = '--max-old-space-size=4096';
const defaultShardCount = 1;
const defaultShardIndex = 0;
const defaultShardStrategy = 'round-robin';
const entityVisibilityBrowserTest =
  'apps/hello/entity-visibility/src/__tests__/visibility.browser.test.ts';
const r32floatCapabilityGenerationTest =
  'packages/rhi-webgpu/src/__tests__/r32float-capability-generation.integration.test.ts';
const advancedLightingBrowserFiles = new Set([
  'apps/learn-render/5.advanced-lighting/6.hdr/src/__tests__/onerror-gate.browser.test.ts',
  'apps/learn-render/5.advanced-lighting/7.bloom/src/__tests__/onerror-gate.browser.test.ts',
  'apps/learn-render/5.advanced-lighting/8.deferred-shading/src/__tests__/onerror-gate.browser.test.ts',
  'apps/learn-render/5.advanced-lighting/9.ssao/src/__tests__/onerror-gate.browser.test.ts',
]);
const iblIrradianceBrowserFile =
  'apps/learn-render/6.pbr/2.ibl-irradiance/src/__tests__/onerror-gate.browser.test.ts';
const iblSpecularBrowserFile =
  'apps/learn-render/6.pbr/3.ibl-specular/src/__tests__/onerror-gate.browser.test.ts';
const transmissionBrowserFile =
  'apps/learn-render/6.pbr/4.transmission-refraction/src/__tests__/onerror-gate.browser.test.ts';
const threeShadowBrowserFiles = new Set(
  ['directional', 'point', 'spot'].map(
    (kind) => `packages/three/src/__tests__/shadow-${kind}.browser.test.ts`,
  ),
);
const threeMaterialOutputBrowserFiles = [0, 1].map(
  (partition) => `packages/three/src/__tests__/material-output-${partition}.browser.test.ts`,
);
const topologyBrowserFile = 'apps/hello/topology/src/__tests__/topology.browser.test.ts';
const directLightBrowserFile =
  'apps/parity/color-lighting/cases/direct-light/__tests__/direct-light.browser.test.ts';
const instancingStaticBrowserFile =
  'apps/parity/instancing-static/src/__tests__/instances.browser.test.ts';
const thinWrapperBrowserFile = 'packages/app/__tests__/thin-wrapper.browser.test.ts';
const solarAtmosphereBrowserFiles = [
  'packages/runtime/src/__tests__/solar-atmosphere-calibration.browser.test.ts',
  'packages/runtime/src/__tests__/solar-atmosphere-fog-time.browser.test.ts',
  'packages/runtime/src/__tests__/solar-atmosphere-mesh-occlusion.browser.test.ts',
  'packages/runtime/src/__tests__/solar-atmosphere-transparent-forward.browser.test.ts',
  'packages/runtime/src/__tests__/solar-atmosphere-transparent-deferred.browser.test.ts',
];
const surfaceProvenanceBrowserFile =
  'packages/runtime/src/__tests__/surface-standard-pipeline.browser.test.ts';
const generatedLodBrowserFile = 'packages/runtime/src/__tests__/generated-lod.browser.test.ts';
const lightingChannelReplayFiles = new Set(
  ['world', 'publication'].flatMap((mode) =>
    ['rigid', 'skin'].flatMap((receiver) =>
      ['forward', 'deferred'].map(
        (renderPath) =>
          `packages/runtime/src/__tests__/lighting-channels-${mode}-${receiver}-${renderPath}.browser.test.ts`,
      ),
    ),
  ),
);
const lightingChannelBrowserFiles = new Set([
  ...lightingChannelReplayFiles,
  ...['sections', 'instances', 'transparent', 'physical'].map(
    (receiver) =>
      `packages/runtime/src/__tests__/lighting-channels-world-${receiver}.browser.test.ts`,
  ),
  'packages/runtime/src/__tests__/lighting-channels-views.browser.test.ts',
  'packages/runtime/src/__tests__/lighting-channels-lifecycle.browser.test.ts',
  'packages/app/__tests__/lighting-channels.browser.test.ts',
]);
const shortRendererBootstrapBrowserFiles = new Set([
  // Run38101911822: the unchanged 30 s textures bootstrap took 38.5 s
  // beside instancing. Preserve the case in one existing exclusive slot.
  'apps/learn-render/1.getting-started/4.textures/src/__tests__/onerror-gate.browser.test.ts',
  'packages/render/src/__tests__/managed-material-runtime.browser.test.ts',
  'packages/runtime/src/__tests__/barrel-distortion-zero-size.browser.test.ts',
  'packages/runtime/src/__tests__/clamp-to-last.e2e.browser.test.ts',
  'packages/runtime/src/__tests__/composite-skybox-cross-world.browser.test.ts',
]);
const renderWorkerPreloadBrowserFile =
  'packages/app/src/__tests__/render-worker-preload-errors.browser.test.ts';
const exclusiveRunnerBrowserFiles = new Set([
  // Run 40654473789 crossed the unchanged 120 s render/reference/replay case
  // beside a 111 s lighting-channel group on the same eight-CPU affinity set.
  'packages/three/src/__tests__/render.browser.test.ts',
  // The complete capture passed alone on Linux after mixed group 86 stalled.
  'packages/runtime/src/__tests__/wave1-shadow-diagnostic.browser.test.ts',
  // Run 39457755532 exceeded 300 s beside a 237 s GPU neighbor. The complete
  // 24-case owner later took 280.693 s alone (run 39554721730), so its cases are
  // partitioned across two processes that keep the original deadlines.
  ...threeMaterialOutputBrowserFiles,
  'packages/runtime/src/__tests__/vfx-mesh-lighting.browser.test.ts',
  'packages/runtime/src/__tests__/image-environment-presentation.browser.test.ts',
  ...solarAtmosphereBrowserFiles,
  'packages/runtime/src/__tests__/volumetric-fog-world-time.browser.test.ts',

  'apps/parity/color-lighting/src/visual/__tests__/vertex-color-visual.browser.test.ts',
  'packages/runtime/src/__tests__/external-texture-perf.browser.test.ts',
  renderWorkerPreloadBrowserFile,
  'apps/learn-render/1.getting-started/5.transformations/src/__tests__/onerror-gate.browser.test.ts',
  // The complete SSS App consumer journey captures both Worker layouts and
  // exceeded its mixed eight-file group twice in PR run 38102350918. Keep the
  // original case/process deadlines and drain other Browser work while it runs.
  'packages/app/__tests__/subsurface.browser.test.ts',
  // Run 38129668305 exceeded the nine-light 30 s case budget while other
  // Browser groups shared the same CPU set. Keep all three cases and their
  // original scene; drain the competing groups before this owner starts.
  'packages/runtime/src/__tests__/light-casters-9-light.browser.test.ts',
]);
const browserProcessIsolatedFiles = new Set([
  'packages/three/src/__tests__/render.browser.test.ts',
  ...threeShadowBrowserFiles,
  ...threeMaterialOutputBrowserFiles,
  'packages/audio-webaudio/src/__tests__/pcm-stream.browser.test.ts',
  ...advancedLightingBrowserFiles,
  iblIrradianceBrowserFile,
  iblSpecularBrowserFile,
  transmissionBrowserFile,
  topologyBrowserFile,
  directLightBrowserFile,
  instancingStaticBrowserFile,
  thinWrapperBrowserFile,
  renderWorkerPreloadBrowserFile,
  'apps/learn-render/1.getting-started/5.transformations/src/__tests__/onerror-gate.browser.test.ts',
  'apps/learn-render/1.getting-started/2.hello-triangle/src/__tests__/onerror-gate.browser.test.ts',
  ...solarAtmosphereBrowserFiles,
  'packages/runtime/src/__tests__/volumetric-fog-world-time.browser.test.ts',
  surfaceProvenanceBrowserFile,
  'packages/runtime/src/__tests__/framebuffer-snapshot.browser.test.ts',
  'packages/runtime/src/__tests__/image-environment-presentation.browser.test.ts',
  'packages/runtime/src/__tests__/light-casters-9-light.browser.test.ts',
  'packages/runtime/src/__tests__/material-mrt.browser.test.ts',
  generatedLodBrowserFile,
  'packages/runtime/src/__tests__/material-publication.browser.test.ts',
  'packages/runtime/src/__tests__/canvas-texture.browser.test.ts',
  'packages/runtime/src/__tests__/render-publication.browser.test.ts',
  'packages/runtime/src/__tests__/lod-transition.browser.test.ts',
  'packages/runtime/src/__tests__/barrel-distortion-output.browser.test.ts',
  ...shortRendererBootstrapBrowserFiles,
  'packages/runtime/src/__tests__/external-texture-perf.browser.test.ts',
  'packages/render/src/__tests__/ssr-gpu-dispatch.browser.test.ts',
  'packages/runtime/src/__tests__/standard-gbuffer-replay.browser.test.ts',
  // Complete subsurface journeys retain their measured process boundaries.
  'packages/runtime/src/__tests__/subsurface.browser.test.ts',
  'packages/app/__tests__/subsurface.browser.test.ts',

  'packages/runtime/src/__tests__/multi-camera.browser.test.ts',
  'packages/runtime/src/__tests__/render-publication.browser.test.ts',
  'packages/runtime/src/__tests__/shadow-contact-column.browser.test.ts',
  'packages/runtime/src/__tests__/shadow-contact-centimeter-1024.browser.test.ts',
  'packages/runtime/src/__tests__/shadow-contact-centimeter-2048.browser.test.ts',
  'packages/app/__tests__/render-worker.browser.test.ts',
  'packages/app/__tests__/render-worker-contract.browser.test.ts',
  'packages/app/__tests__/render-worker-multi-camera.browser.test.ts',
  'packages/app/__tests__/worker-policy.browser.test.ts',
  'packages/app/__tests__/engine-worker-asset-loss.browser.test.ts',
  'packages/app/__tests__/render-worker-deformation.browser.test.ts',
  'packages/app/__tests__/render-worker-geometry.browser.test.ts',
  'packages/app/__tests__/render-worker-media.browser.test.ts',
  'packages/app/__tests__/render-worker-tiles.browser.test.ts',
  'packages/runtime/src/__tests__/vfx-mesh-lighting.browser.test.ts',
  'packages/runtime/src/__tests__/vfx-mesh-lighting-publication.browser.test.ts',
  'packages/runtime/src/__tests__/wave1-rendering-recovery.browser.test.ts',
  'packages/runtime/src/__tests__/wave1-shadow-diagnostic.browser.test.ts',
  'packages/app/__tests__/render-worker-environment.browser.test.ts',
]);
const renderingGroupSize = 4;
function isRenderingBrowserFile(file) {
  return (
    file.startsWith('packages/runtime/src/__tests__/') ||
    file.startsWith('packages/render/src/__tests__/raytracing/') ||
    file === 'packages/ui/src/preview/__tests__/capture-determinism.browser.test.ts'
  );
}
const assetColdOwnerFiles = new Set([
  iblIrradianceBrowserFile,
  iblSpecularBrowserFile,
  transmissionBrowserFile,
  topologyBrowserFile,
]);
const instancingStaticBrowserGroupTimeoutMs = 900_000;
const colorLightingCasePrefix = 'apps/parity/color-lighting/cases/';
const colorLightingCaseGroupSize = 4;
const colorLightingCaseSeconds = 18;
const excludedDirectories = new Set([
  '.git',
  '.forgeax-harness',
  'artifacts',
  'dist',
  'node_modules',
]);

function parsePositiveInt(value, name, { max = Number.POSITIVE_INFINITY } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}, got ${value}`);
  }
  return parsed;
}

export function parseArgs(argv) {
  const valueOptions = new Set([
    '--file',
    '--group-concurrency',
    '--group-size',
    '--max-workers',
    '--shard-count',
    '--shard-index',
    '--shard-strategy',
  ]);
  const options = {
    dryRun: false,
    files: [],
    groupConcurrency: defaultGroupConcurrency,
    groupSize: defaultGroupSize,
    maxWorkers: defaultMaxWorkers,
    shardCount: defaultShardCount,
    shardIndex: defaultShardIndex,
    shardStrategy: defaultShardStrategy,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    const [key, inlineValue] = argument.split('=', 2);
    const value = inlineValue ?? (valueOptions.has(key) ? argv[++index] : undefined);
    if (key === '--file') {
      if (!value) throw new Error('--file needs an exact repository test path');
      options.files.push(value);
    } else if (key === '--group-concurrency') {
      options.groupConcurrency = parsePositiveInt(value, '--group-concurrency', {
        max: maxGroupConcurrency,
      });
    } else if (key === '--group-size') {
      options.groupSize = parsePositiveInt(value, '--group-size', { max: 24 });
    } else if (key === '--max-workers') {
      options.maxWorkers = parsePositiveInt(value, '--max-workers', { max: 6 });
    } else if (key === '--shard-count') {
      options.shardCount = parsePositiveInt(value, '--shard-count', {
        max: ciBrowserShardTailSeconds.length,
      });
    } else if (key === '--shard-index') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed >= ciBrowserShardTailSeconds.length)
        throw new Error(
          `--shard-index must be an integer from 0 to ${ciBrowserShardTailSeconds.length - 1}, got ${value}`,
        );
      options.shardIndex = parsed;
    } else if (key === '--shard-strategy') {
      if (value !== 'round-robin' && value !== 'balanced') {
        throw new Error(`--shard-strategy must be round-robin or balanced, got ${value}`);
      }
      options.shardStrategy = value;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (options.shardIndex >= options.shardCount)
    throw new Error(
      `--shard-index must be less than --shard-count, got ${options.shardIndex + 1}/${options.shardCount}`,
    );
  return options;
}

// Median complete successful child cost from the runs recorded in the table;
// failed or truncated children are excluded. Allocate startup/cleanup equally, so there
// is no second fixed startup surcharge that overwhelms short groups.
const measuredBrowserSeconds = JSON.parse(
  readFileSync(path.join(scriptDir, 'browser-file-seconds.json'), 'utf8'),
);
const measuredBrowserFileSeconds = new Map(Object.entries(measuredBrowserSeconds.files));
const renderWorkerBrowserFile =
  /^packages\/app\/__tests__\/(?:render-worker[a-z-]*|worker-policy|engine-worker-asset-loss)\.browser\.test\.ts$/;
function estimatedBrowserFileSeconds(file) {
  // Full native/reference/replay journeys. These are scheduling estimates;
  // unknown-file weights grouped them into a 300 s timeout in run 39384469626.
  if (file === 'packages/three/src/__tests__/output.browser.test.ts') return 100;
  if (file === 'packages/three/src/__tests__/render.browser.test.ts') return 90;
  // r184 comparisons include authored/filter mutations and retained-map replay.
  // Run 39435724371 exhausted 300 s when all shadow journeys shared one group.
  if (threeShadowBrowserFiles.has(file)) return 100;
  if (file === 'packages/three/src/__tests__/shadow-updates.browser.test.ts') return 240;
  if (file === 'packages/three/src/__tests__/shadow-alpha.browser.test.ts') return 100;
  if (file === 'packages/three/src/__tests__/variance-shadow.browser.test.ts') return 100;
  if (file === 'packages/three/src/__tests__/loading.browser.test.ts') return 60;
  if (file === 'packages/three/src/__tests__/environment.browser.test.ts') return 90;
  if (file === 'packages/three/src/__tests__/transmission-output.browser.test.ts') return 90;
  if (lightingChannelReplayFiles.has(file)) return 240;
  if (lightingChannelBrowserFiles.has(file)) return 100;
  if (file === 'packages/runtime/src/__tests__/volumetric-fog-world-time.browser.test.ts')
    return 240;
  if (solarAtmosphereBrowserFiles.includes(file)) return file.includes('transparent-') ? 240 : 180;
  if (renderWorkerBrowserFile.test(file)) return 75;
  if (file.startsWith('packages/runtime/src/__tests__/')) return 20;
  if (file.startsWith(colorLightingCasePrefix)) return colorLightingCaseSeconds;
  return 5;
}
export function browserFileWeight(file) {
  return measuredBrowserFileSeconds.get(file) ?? estimatedBrowserFileSeconds(file);
}

export function browserGroupWeight(group) {
  return group.reduce((seconds, file) => seconds + browserFileWeight(file), 0);
}

export function browserGroupRunOrder(groups, selectedIndexes, concurrency) {
  if (concurrency <= 1) return undefined;
  return selectedIndexes
    .map((_index, position) => position)
    .sort(
      (left, right) =>
        Number(browserGroupRequiresExclusiveRunner(groups[selectedIndexes[right]])) -
          Number(browserGroupRequiresExclusiveRunner(groups[selectedIndexes[left]])) ||
        browserGroupWeight(groups[selectedIndexes[right]]) -
          browserGroupWeight(groups[selectedIndexes[left]]) ||
        left - right,
    );
}

// Median executed smoke/runtime tails in runs 38316658619 and 38320931831,
// rounded to 5 s. Mesh uses
// a conservative 200 s estimate for sixteen cases and their offline analyzer
// inputs; the failed twenty-case receipt is not a timing baseline.
export const ciBrowserShardTailSeconds = Object.freeze([125, 230, 200, 0]);

export function assignBrowserGroupsToShards(
  groups,
  shardCount,
  strategy = defaultShardStrategy,
  { tailSeconds = [], concurrency = 1 } = {},
) {
  if (strategy === 'round-robin') {
    return groups.map((_group, groupIndex) => groupIndex % shardCount);
  }
  const totals = Array.from({ length: shardCount }, (_value, shard) =>
    shard < tailSeconds.length ? tailSeconds[shard] * concurrency : 0,
  );
  const assignment = Array(groups.length).fill(0);
  const ranked = groups
    .map((group, index) => ({
      index,
      weight:
        browserGroupWeight(group) * (browserGroupRequiresExclusiveRunner(group) ? concurrency : 1),
    }))
    .sort((left, right) => right.weight - left.weight || left.index - right.index);
  for (const { index, weight } of ranked) {
    let selected = 0;
    for (let shard = 1; shard < shardCount; shard += 1) {
      if (totals[shard] < totals[selected]) selected = shard;
    }
    assignment[index] = selected;
    totals[selected] += weight;
  }
  return assignment;
}

export function browserTestFiles(directory = rootDir, relativeDirectory = '') {
  const files = [];
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      if (
        excludedDirectories.has(entry.name) ||
        relativePath === 'docs/reports' ||
        relativePath.startsWith('docs/reports/') ||
        relativePath === 'packages/wgpu-wasm/target' ||
        relativePath === 'packages/dawn-node/.native-build' ||
        relativePath === '.worktrees' ||
        relativePath === '.claude/worktrees' ||
        relativePath.startsWith('.claude/worktrees/')
      ) {
        continue;
      }
      files.push(...browserTestFiles(path.join(directory, entry.name), relativePath));
      continue;
    }
    if (
      entry.isFile() &&
      entry.name.endsWith('.browser.test.ts') &&
      relativePath !== entityVisibilityBrowserTest
    ) {
      files.push(relativePath);
    }
  }
  return files;
}

function chunk(values, size) {
  const groups = [];
  let group = [];
  let seconds = 0;
  for (const file of values) {
    const cost = browserFileWeight(file);
    // File count alone can fill a five-minute process with several heavy
    // owners. Use the existing measurements and leave room for host variance.
    if (group.length && (group.length >= size || seconds + cost > browserGroupTimeoutMs / 2000)) {
      groups.push(group);
      group = [];
      seconds = 0;
    }
    group.push(file);
    seconds += cost;
  }
  if (group.length) groups.push(group);
  return groups;
}

function planGroups(files, groupSize) {
  const host = files.filter((file) => browserHostFiles.has(file));
  files = files.filter((file) => !browserHostFiles.has(file));
  const preview = files.filter((file) => file.startsWith('apps/preview/'));
  const isolated = files.filter((file) => browserProcessIsolatedFiles.has(file));
  const regular = files.filter(
    (file) => !file.startsWith('apps/preview/') && !browserProcessIsolatedFiles.has(file),
  );
  const colorLightingCases = regular.filter((file) => file.startsWith(colorLightingCasePrefix));
  const rendering = regular.filter(isRenderingBrowserFile);
  const ordinaryRegular = regular.filter(
    (file) => !file.startsWith(colorLightingCasePrefix) && !isRenderingBrowserFile(file),
  );

  const isolatedAdvancedLighting = isolated
    .filter((file) => advancedLightingBrowserFiles.has(file))
    .map((file) => [file]);
  const assetColdOwners = isolated.filter((file) => assetColdOwnerFiles.has(file));
  const isolatedGroups = [
    ...isolatedAdvancedLighting,
    ...(assetColdOwners.length > 0 ? [assetColdOwners] : []),
    ...isolated
      .filter((file) => !advancedLightingBrowserFiles.has(file) && !assetColdOwnerFiles.has(file))
      .map((file) => [file]),
  ];
  return [
    ...host.filter((file) => browserProcessIsolatedFiles.has(file)).map((file) => [file]),
    ...chunk(
      host.filter((file) => !browserProcessIsolatedFiles.has(file) && isRenderingBrowserFile(file)),
      Math.min(groupSize, renderingGroupSize),
    ),
    ...chunk(
      host.filter(
        (file) => !browserProcessIsolatedFiles.has(file) && !isRenderingBrowserFile(file),
      ),
      groupSize,
    ),
    ...(preview.length > 0 ? [preview] : []),
    ...isolatedGroups,
    ...chunk(colorLightingCases, colorLightingCaseGroupSize),
    ...chunk(rendering, Math.min(groupSize, renderingGroupSize)),
    ...chunk(ordinaryRegular, groupSize),
  ];
}

function resolveCliPath() {
  const candidates = [
    path.join(rootDir, 'node_modules/vitest/vitest.mjs'),
    path.join(rootDir, 'node_modules/vitest/dist/cli.js'),
  ];
  const cliPath = candidates.find((candidate) => existsSync(candidate));
  if (!cliPath) throw new Error('cannot resolve the workspace Vitest CLI');
  return cliPath;
}

export function withBrowserHeapLimit(environment) {
  const inherited = environment.NODE_OPTIONS?.trim() ?? '';
  if (/(^|\s)--max-old-space-size(?:=|\s)/.test(inherited)) return environment;
  return {
    ...environment,
    NODE_OPTIONS: [inherited, browserNodeHeapArg].filter(Boolean).join(' '),
  };
}

export function browserProducerReadiness(group, requestedReadiness) {
  const previewGroup = group.some((file) => file.startsWith('apps/preview/'));
  return previewGroup ||
    group.includes(surfaceProvenanceBrowserFile) ||
    requestedReadiness === 'before-consume'
    ? 'before-consume'
    : 'on-demand';
}

export function browserGroupRequiresExclusiveRunner(group) {
  return (
    browserProducerReadiness(group, undefined) === 'before-consume' ||
    group.some(
      (file) =>
        shortRendererBootstrapBrowserFiles.has(file) ||
        exclusiveRunnerBrowserFiles.has(file) ||
        renderWorkerBrowserFile.test(file),
    )
  );
}

export function browserConfigForGroup(group) {
  if (group.length === 1 && group[0] === renderWorkerPreloadBrowserFile) {
    return 'config/vitest.render-preload-fixture.config.ts';
  }
  return browserGroupIsHostOnly(group)
    ? 'config/vitest.browser-host.config.ts'
    : 'config/vitest.browser.config.ts';
}

export async function runGroup({ cliPath, group, groupIndex, groupCount, maxWorkers }) {
  const hostOnly = browserGroupIsHostOnly(group);
  process.stderr.write(`[vitest] browser group ${groupIndex}/${groupCount}: ${group.join(', ')}\n`);
  if (browserGroupRequiresExclusiveRunner(group))
    process.stderr.write('[vitest] browser group owns the runner exclusively\n');
  const groupTimeoutMs = group.includes(instancingStaticBrowserFile)
    ? instancingStaticBrowserGroupTimeoutMs
    : group.includes(directLightBrowserFile)
      ? directLightBrowserGroupTimeoutMs
      : group.includes(surfaceProvenanceBrowserFile)
        ? surfaceProvenanceBrowserGroupTimeoutMs
        : group.includes(generatedLodBrowserFile)
          ? generatedLodBrowserGroupTimeoutMs
          : group.some((file) => file.startsWith('apps/preview/'))
            ? previewBrowserGroupTimeoutMs
            : browserGroupTimeoutMs;
  const producerReadiness = browserProducerReadiness(
    group,
    process.env.FORGEAX_BROWSER_PACK_READINESS,
  );
  const command = [
    process.execPath,
    cliPath,
    'run',
    '--config',
    browserConfigForGroup(group),
    '--project=browser',
    '--passWithNoTests=false',
    `--maxWorkers=${maxWorkers}`,
    ...(process.env.FORGEAX_BROWSER_COST_REPORT === '1'
      ? [
          '--reporter=default',
          `--reporter=${path.join(rootDir, 'scripts/ci/browser-cost-reporter.mjs')}`,
        ]
      : []),
    ...group,
  ];
  const environment = withBrowserHeapLimit({
    ...process.env,
    FORGEAX_BROWSER_COST_COORDINATOR: '1',
    FORGEAX_BROWSER_ENTITY_VISIBILITY: '0',
    FORGEAX_BROWSER_CROSS_ORIGIN_ISOLATED: group.some(
      (file) =>
        file === 'packages/app/__tests__/worker-policy.browser.test.ts' ||
        file === 'packages/app/__tests__/engine-worker-asset-loss.browser.test.ts',
    )
      ? '1'
      : '0',
    FORGEAX_BROWSER_PREVIEW_ONLY: group.every((file) => file.startsWith('apps/preview/'))
      ? '1'
      : '0',
    FORGEAX_BROWSER_SURFACE_ONLY: group.includes(surfaceProvenanceBrowserFile) ? '1' : '0',
    FORGEAX_BROWSER_PACK_READINESS: producerReadiness,
    FORGEAX_TOOL_PREVIEW: '1',
  });
  const result = await runBrowserCommand(command, {
    cwd: rootDir,
    env: environment,
    timeoutMs: groupTimeoutMs,
    gpuLease: !hostOnly,
    label: `Vitest browser group ${groupIndex}/${groupCount} files=${group.join(',')}`,
  });
  if (result.pid !== undefined && result.cleanup?.kind !== 'failed') {
    rmSync(browserProcessCacheDir(rootDir, result.pid), { recursive: true, force: true });
  }
  if (result.status === 0)
    return {
      elapsedMs: result.elapsedMs,
      files:
        process.env.FORGEAX_BROWSER_COST_REPORT === '1'
          ? readBrowserCosts(result.output, group)
          : [],
    };
  if (result.signal === 'SIGKILL') {
    process.stderr.write(
      `[vitest] browser group ${groupIndex} memory-pressure=${JSON.stringify(readMemoryPressureDiagnostics())}\n`,
    );
  }
  throw new Error(`Vitest browser group ${groupIndex} failed; ${result.failure}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let files = browserTestFiles();
  if (!files.includes(r32floatCapabilityGenerationTest))
    files.push(r32floatCapabilityGenerationTest);
  if (options.files.length) {
    for (const file of options.files)
      if (!files.includes(file)) throw new Error(`browser file is not in the gate roster: ${file}`);
    files = [...new Set(options.files)];
    console.log('[vitest] DIAGNOSTIC selection; full browser CI is still required');
  }
  const groups = planGroups(files, options.groupSize);
  if (groups.length === 0) throw new Error('no browser test files were discovered');
  const shardAssignment = assignBrowserGroupsToShards(
    groups,
    options.shardCount,
    options.shardStrategy,
    {
      tailSeconds: process.env.FORGEAX_BROWSER_FIXED_SMOKE === '1' ? ciBrowserShardTailSeconds : [],
      concurrency: options.groupConcurrency,
    },
  );
  const selectedGroups = groups.filter(
    (_group, groupIndex) => shardAssignment[groupIndex] === options.shardIndex,
  );
  if (selectedGroups.length === 0) {
    throw new Error(
      `browser shard ${options.shardIndex + 1}/${options.shardCount} selected no groups from ${groups.length}`,
    );
  }

  if (options.dryRun) {
    for (const [index, group] of groups.entries()) {
      if (shardAssignment[index] !== options.shardIndex) continue;
      process.stdout.write(
        `group-${String(index + 1).padStart(2, '0')} (${group.length} files): ${group.join(', ')}\n`,
      );
    }
    return;
  }

  const profileInputs = path.join(rootDir, 'node_modules/.cache/forgeax-build/browser-shaders');
  let shaderPreparation;
  const prepareShaders = () =>
    (shaderPreparation ??= (async () => {
      const prepared = await runBrowserCommand(
        [
          process.execPath,
          'scripts/forgeax/prepare-shader-release-inputs.mjs',
          '--build',
          '--profile',
          'point-ssao',
          '--input',
          profileInputs,
          ...(process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST
            ? ['--shared-input-manifest', process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST]
            : []),
        ],
        { cwd: rootDir, label: 'browser point-shadow shader producer' },
      );
      if (prepared.status !== 0)
        throw new Error(`browser shader preparation failed; ${prepared.failure}`);
    })());

  const cliPath = resolveCliPath();
  const selectedIndexes = groups
    .map((_group, index) => index)
    .filter((index) => shardAssignment[index] === options.shardIndex);
  const observations = [];
  let complete = false;
  try {
    await runGroups({
      groups: selectedIndexes,
      concurrency: options.groupConcurrency,
      order: browserGroupRunOrder(groups, selectedIndexes, options.groupConcurrency),
      isExclusive: (index) => browserGroupRequiresExclusiveRunner(groups[index]),
      runGroupImpl: async (index) => {
        if (!browserGroupIsHostOnly(groups[index])) await prepareShaders();
        const observation = await runGroup({
          cliPath,
          group: groups[index],
          groupIndex: index + 1,
          groupCount: groups.length,
          maxWorkers: options.maxWorkers,
        });
        observations.push(observation);
      },
    });
    complete = true;
  } finally {
    if (process.env.FORGEAX_BROWSER_COST_REPORT === '1')
      summarizeBrowserCosts(observations, { shard: options.shardIndex, complete });
  }
  process.stdout.write(
    `[vitest] split browser passed: groups=${groups.length}, selected=${selectedGroups.length}, files=${files.length}, shard=${options.shardIndex + 1}/${options.shardCount}, strategy=${options.shardStrategy}, groupConcurrency=${options.groupConcurrency}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`[vitest] split browser failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
