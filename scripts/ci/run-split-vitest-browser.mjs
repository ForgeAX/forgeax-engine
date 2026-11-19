#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGroups } from '../lib/run-bounded-groups.mjs';
import { readMemoryPressureDiagnostics } from '../lib/runner-resources.mjs';
import { readBrowserCosts, summarizeBrowserCosts } from './browser-cost-report.mjs';
import hostFiles from './browser-host-files.json' with { type: 'json' };
import { browserProcessCacheDir } from './browser-process-cache.mjs';
import { coreValidationFiles } from './core-validation.mjs';
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
const compatibilitySceneBrowserFile =
  'packages/runtime/src/__tests__/compatibility-scene.browser.test.ts';
const compatibilitySceneBrowserConfig = 'config/vitest.webgpu-scene.config.ts';
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
const threeMaterialOutputBrowserFiles = [0, 1, 2, 3].map(
  (partition) => `packages/three/src/__tests__/material-output-${partition}.browser.test.ts`,
);
const topologyBrowserFile = 'apps/hello/topology/src/__tests__/topology.browser.test.ts';
const directLightBrowserFile =
  'apps/parity/color-lighting/cases/direct-light/__tests__/direct-light.browser.test.ts';
const instancingStaticBrowserFile =
  'apps/parity/instancing-static/src/__tests__/instances.browser.test.ts';
const thinWrapperBrowserFile = 'packages/app/__tests__/thin-wrapper.browser.test.ts';
const thinWrapperThrowBrowserFile = 'packages/app/__tests__/thin-wrapper-throw.browser.test.ts';
const solarAtmosphereBrowserFiles = [
  'packages/runtime/src/__tests__/atmosphere-full-webgl2.browser.test.ts',
  'packages/runtime/src/__tests__/solar-atmosphere-calibration.browser.test.ts',
  'packages/runtime/src/__tests__/solar-atmosphere-fog-time.browser.test.ts',
  'packages/runtime/src/__tests__/solar-atmosphere-mesh-occlusion.browser.test.ts',
  'packages/runtime/src/__tests__/solar-atmosphere-transparent-forward.browser.test.ts',
  'packages/runtime/src/__tests__/solar-atmosphere-transparent-deferred.browser.test.ts',
];
const surfacePipelineBrowserFile =
  'packages/runtime/src/__tests__/surface-standard-pipeline.browser.test.ts';
const surfaceLifecycleBrowserFile =
  'packages/runtime/src/__tests__/surface-standard-lifecycle.browser.test.ts';
const surfaceProvenanceBrowserFiles = [surfacePipelineBrowserFile, surfaceLifecycleBrowserFile];
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
  'packages/runtime/src/__tests__/lighting-channels-views-world.browser.test.ts',
  'packages/runtime/src/__tests__/lighting-channels-views-publication.browser.test.ts',
  'packages/runtime/src/__tests__/lighting-channels-lifecycle.browser.test.ts',
  'packages/app/__tests__/lighting-channels.browser.test.ts',
]);
const shortRendererBootstrapBrowserFiles = new Set([
  // The archive creates a second cold native device. Drain neighboring
  // compilation and native owners within the existing cold-start budget.
  compatibilitySceneBrowserFile,
  // The dual-host parity capture missed its unchanged 15 s ready-frame
  // bound in mixed group 90 of run 41494219900. Keep its complete owner alone.
  'packages/runtime/src/__tests__/pixel-parity-capture.browser.test.ts',
  // Run38101911822: the unchanged 30 s textures bootstrap took 38.5 s
  // beside instancing. Preserve the case in one existing exclusive slot.
  'apps/learn-render/1.getting-started/4.textures/src/__tests__/onerror-gate.browser.test.ts',
  'packages/render/src/__tests__/managed-material-runtime.browser.test.ts',
  'packages/runtime/src/__tests__/barrel-distortion-zero-size.browser.test.ts',
  'packages/runtime/src/__tests__/clamp-to-last.e2e.browser.test.ts',
  'packages/runtime/src/__tests__/single-source-skybox.browser.test.ts',
]);
const renderWorkerPreloadBrowserFile =
  'packages/app/src/__tests__/render-worker-preload-errors.browser.test.ts';
const renderWorkerPressureBrowserFile =
  'packages/app/__tests__/render-worker-pressure.browser.test.ts';
const shadowQualityBrowserFiles = new Set([
  'packages/runtime/src/__tests__/cube-plane-shadow-contact.browser.test.ts',
  'packages/runtime/src/__tests__/cube-plane-shadow-contact-deferred.browser.test.ts',
  'packages/runtime/src/__tests__/curved-shadow-receiver.browser.test.ts',
]);
const pixelParityCaptureBrowserFile =
  'packages/runtime/src/__tests__/pixel-parity-capture.browser.test.ts';
const dynamicGeometryBrowserFile =
  'packages/runtime/src/__tests__/wave1-dynamic-geometry.browser.test.ts';
const threeSurfaceExpressionBrowserFile =
  'packages/three/src/__tests__/surface-expression.browser.test.ts';
const exclusiveRunnerBrowserFiles = new Set([
  // Run 44402862972 exceeded the original Standard Surface case budget
  // beside another live browser. Keep its existing group and drain neighbors.
  threeSurfaceExpressionBrowserFile,
  // Run 43810781689 crossed cold SSR preparation beside another heavy
  // Renderer owner. The same four cases pass in their existing process alone.
  'packages/runtime/src/__tests__/morph-surface.browser.test.ts',
  // Run 43802933357 crossed the kernel's original 15 s case bound beside
  // another GPU group; deliberate WebGL loss also races device settlement.
  // Drain neighbors for their existing mixed batches, without a new process.
  'packages/render/src/__tests__/portable-kernel-expansion.browser.test.ts',
  'packages/runtime/src/__tests__/webgl-context-loss.browser.test.ts',
  // Run42247651279 exceeded its 60 s case after two volumetric-fog owners.
  // Preserve the complete geometry, physics, shadow and TAA journey alone.
  dynamicGeometryBrowserFile,
  // Run42045444805: these native/replay owners exhausted both 300 s children
  // while sharing the same runner. Retain complete cases and original bounds.
  'packages/runtime/src/__tests__/multi-camera.browser.test.ts',
  'packages/runtime/src/__tests__/multi-camera-publication.browser.test.ts',
  'packages/runtime/src/__tests__/multi-camera-vfx.browser.test.ts',
  'packages/three/src/__tests__/shadow-alpha.browser.test.ts',
  // Run41607916066: the 15 s direct-light capture overlapped the wave/Toon
  // group. The native observer also needs its own complete GPU realm.
  directLightBrowserFile,
  'packages/runtime/src/__tests__/weapon-spirit-material.browser.test.ts',
  // Runs 41474743972 and 41546866475 exhausted unchanged native readiness
  // bounds beside another GPU owner. Run each complete view journey alone.
  'packages/runtime/src/__tests__/lighting-channels-views-world.browser.test.ts',
  'packages/runtime/src/__tests__/lighting-channels-views-publication.browser.test.ts',
  'packages/three/src/__tests__/texture.browser.test.ts',
  // Run 41535701837 exhausted Standard's 15 s preparation bound in a mixed
  // four-file process. Keep both native pictures, compositor and light controls.
  pixelParityCaptureBrowserFile,
  // Ordinary and publication IES owners retain all four cases and 19 devices.
  // Each keeps the original process deadline without competing GPU groups.
  'packages/runtime/src/__tests__/ies-local-lights.browser.test.ts',
  'packages/runtime/src/__tests__/ies-local-lights-publication.browser.test.ts',
  // Run 41269699158 exhausted a mixed 300 s process. Keep the complete
  // shared-renderer contact matrix away from competing software GPU owners.
  ...shadowQualityBrowserFiles,
  // Run 40654473789 crossed the unchanged 120 s render/reference/replay case
  // beside a 111 s lighting-channel group on the same eight-CPU affinity set.
  'packages/three/src/__tests__/render.browser.test.ts',
  // Run 41591466819 crossed the unchanged 240 s directional-shadow case
  // beside mixed Browser work. Keep its full native/reference/replay journey.
  'packages/three/src/__tests__/shadow-directional.browser.test.ts',
  // Run 42292831412 exhausted the unchanged 240 s Spot case while a
  // lighting-channel group competed with its fresh-device replay work.
  'packages/three/src/__tests__/shadow-spot.browser.test.ts',
  // The mixed native/Three shadow proof missed its 20 s readiness bound
  // alongside GTAO and lighting-channel groups in run 44271875944.
  // Drain neighbors and isolate its process from the interfaces GPU tests.
  'packages/three/src/__tests__/interop.browser.test.ts',
  // Independent alpha material journeys keep every original pixel/replay
  // control in separate exclusive processes under the same 300 s bound.
  'packages/three/src/__tests__/shadow-alpha.browser.test.ts',
  'packages/three/src/__tests__/shadow-alpha-standard.browser.test.ts',
  // The complete capture passed alone on Linux after mixed group 86 stalled.
  'packages/runtime/src/__tests__/wave1-shadow-diagnostic.browser.test.ts',
  // Run 39457755532 exceeded 300 s beside a 237 s GPU neighbor. The complete
  // 24-case owner later took 280.693 s alone (run 39554721730), so its cases are
  // partitioned across four processes that keep the original deadlines.
  ...threeMaterialOutputBrowserFiles,
  'packages/runtime/src/__tests__/vfx-mesh-lighting.browser.test.ts',
  'packages/runtime/src/__tests__/vfx-mesh-lighting-publication.browser.test.ts',
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
  dynamicGeometryBrowserFile,
  'packages/runtime/src/__tests__/weapon-spirit-material.browser.test.ts',
  // Each independent-view path owns its own 300 s case and process deadline.
  'packages/runtime/src/__tests__/lighting-channels-views-world.browser.test.ts',
  'packages/runtime/src/__tests__/lighting-channels-views-publication.browser.test.ts',
  pixelParityCaptureBrowserFile,
  ...shadowQualityBrowserFiles,
  // Run 40671760654 exhausted one 300 s process with all three native owners.
  // Preserve each complete journey and its existing deadline in its own process.
  'packages/runtime/src/__tests__/point-light-decay.browser.test.ts',
  'packages/runtime/src/__tests__/point-light-shadow.browser.test.ts',
  'packages/runtime/src/__tests__/point-sprites.browser.test.ts',
  'packages/three/src/__tests__/render.browser.test.ts',
  'packages/three/src/__tests__/interop.browser.test.ts',
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
  // Its renderer-host module mock must not share the real App/Worker owner.
  thinWrapperThrowBrowserFile,
  renderWorkerPreloadBrowserFile,
  'apps/learn-render/1.getting-started/5.transformations/src/__tests__/onerror-gate.browser.test.ts',
  'apps/learn-render/1.getting-started/2.hello-triangle/src/__tests__/onerror-gate.browser.test.ts',
  ...solarAtmosphereBrowserFiles,
  'packages/runtime/src/__tests__/volumetric-fog-world-time.browser.test.ts',
  ...surfaceProvenanceBrowserFiles,
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
  'packages/runtime/src/__tests__/multi-camera-publication.browser.test.ts',
  'packages/runtime/src/__tests__/multi-camera-vfx.browser.test.ts',
  'packages/runtime/src/__tests__/render-publication.browser.test.ts',
  'packages/runtime/src/__tests__/shadow-contact-column.browser.test.ts',
  'packages/runtime/src/__tests__/shadow-contact-centimeter-1024.browser.test.ts',
  'packages/runtime/src/__tests__/shadow-contact-centimeter-2048.browser.test.ts',
  'packages/runtime/src/__tests__/shadow-contact-webgl2-column.browser.test.ts',
  'packages/runtime/src/__tests__/shadow-contact-webgl2-centimeter.browser.test.ts',
  'packages/app/__tests__/render-worker.browser.test.ts',
  // Run 42870354116 exhausted the shared 300 s child after the recovery and
  // engine-pressure receipts; keep full-Renderer pressure in its own process.
  renderWorkerPressureBrowserFile,
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
    continueOnFailure: false,
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
    if (argument === '--continue-on-failure') {
      options.continueOnFailure = true;
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

// Complete successful child costs from the runs recorded in the table. Refresh
// conservatively against historical forecasts; failed or truncated children are
// excluded even when their parent run has completed. Allocate startup/cleanup
// equally, without a second fixed surcharge that overwhelms short groups.
const measuredBrowserSeconds = JSON.parse(
  readFileSync(path.join(scriptDir, 'browser-file-seconds.json'), 'utf8'),
);
const measuredBrowserFileSeconds = new Map(Object.entries(measuredBrowserSeconds.files));
// Dispatch complete matching children without summing unrelated per-file maxima.
// Group construction and full-profile forecasts retain the original file table.
const measuredCoreBrowserGroups = new Map();
for (const run of measuredBrowserSeconds.coreProfile.sourceRuns) {
  const receipt = JSON.parse(
    readFileSync(path.join(scriptDir, 'browser-timing-snapshots', `${run}.json`), 'utf8'),
  );
  for (const group of receipt.groups) {
    const key = group.files.join('\n');
    measuredCoreBrowserGroups.set(
      key,
      Math.max(measuredCoreBrowserGroups.get(key) ?? 0, group.processSeconds),
    );
  }
}

const renderWorkerBrowserFile =
  /^packages\/app\/__tests__\/(?:render-worker[a-z-]*|worker-policy|engine-worker-asset-loss)\.browser\.test\.ts$/;
function estimatedShadowQualitySeconds(file) {
  // Scheduling estimate until a complete isolated CI receipt is available.
  if (
    file === 'packages/runtime/src/__tests__/cube-plane-shadow-contact.browser.test.ts' ||
    file === 'packages/runtime/src/__tests__/cube-plane-shadow-contact-deferred.browser.test.ts'
  )
    return 120;
  if (file === 'packages/runtime/src/__tests__/curved-shadow-receiver.browser.test.ts') return 180;
}

function estimatedThreeBrowserFileSeconds(file) {
  if (!file.startsWith('packages/three/src/__tests__/')) return undefined;
  if (file === 'packages/three/src/__tests__/output.browser.test.ts') return 100;
  if (file === 'packages/three/src/__tests__/render.browser.test.ts') return 90;
  // r184 comparisons include authored/filter mutations and retained-map replay.
  // Run 39435724371 exhausted 300 s when all shadow journeys shared one group.
  if (threeShadowBrowserFiles.has(file)) return 100;
  if (file === 'packages/three/src/__tests__/shadow-updates.browser.test.ts') return 240;
  if (/^packages\/three\/src\/__tests__\/shadow-alpha(?:-standard)?\.browser\.test\.ts$/.test(file))
    return 100;
  if (file === 'packages/three/src/__tests__/variance-shadow.browser.test.ts') return 100;
  if (file === 'packages/three/src/__tests__/loading.browser.test.ts') return 60;
  if (file === 'packages/three/src/__tests__/environment.browser.test.ts') return 90;
  if (file === 'packages/three/src/__tests__/transmission-output.browser.test.ts') return 90;
  // Run 43745792265 overflowed an eight-file native/reference/replay child.
  // Forecast unmeasured Three owners conservatively; preserve measured receipts.
  return 60;
}

function estimatedBrowserFileSeconds(file) {
  const shadowQualitySeconds = estimatedShadowQualitySeconds(file);
  if (shadowQualitySeconds !== undefined) return shadowQualitySeconds;
  // Full native/reference/replay journeys. These are scheduling estimates;
  // unknown-file weights grouped them into a 300 s timeout in run 39384469626.
  if (file === compatibilitySceneBrowserFile) return 90;
  const threeSeconds = estimatedThreeBrowserFileSeconds(file);
  if (threeSeconds !== undefined) return threeSeconds;
  if (lightingChannelReplayFiles.has(file)) return 240;
  if (lightingChannelBrowserFiles.has(file)) return 100;
  if (file === 'packages/runtime/src/__tests__/volumetric-fog-world-time.browser.test.ts')
    return 240;
  if (solarAtmosphereBrowserFiles.includes(file)) return file.includes('transparent-') ? 240 : 180;
  if (renderWorkerBrowserFile.test(file)) return 75;
  // Reserve both device-loss journeys and a cold Surface publication.
  if (file === surfaceLifecycleBrowserFile) return 120;
  if (file.startsWith('packages/runtime/src/__tests__/')) return 20;
  if (file.startsWith(colorLightingCasePrefix)) return colorLightingCaseSeconds;
  return 5;
}
export function browserFileWeight(file) {
  return measuredBrowserFileSeconds.get(file) ?? estimatedBrowserFileSeconds(file);
}

export function browserGroupWeight(
  group,
  fileWeight = browserFileWeight,
  environment = process.env,
) {
  const measured =
    environment.FORGEAX_CI_CORE_VALIDATION === '1' &&
    environment.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' &&
    environment.FORGEAX_BROWSER_FIXED_SMOKE === '1' &&
    fileWeight === browserFileWeight
      ? measuredCoreBrowserGroups.get(group.join('\n'))
      : undefined;
  const seconds = measured ?? group.reduce((sum, file) => sum + fileWeight(file), 0);
  // Run 44387085437 completed the paired group's full work in 222.118 s.
  // Reserve the rounded cost for dispatch without changing group construction.
  if (fileWeight === browserFileWeight && group.includes(threeSurfaceExpressionBrowserFile))
    return Math.max(seconds, 225);
  return seconds;
}

export function browserGroupRunOrder(
  groups,
  selectedIndexes,
  concurrency,
  { fileWeight = browserFileWeight } = {},
) {
  if (concurrency <= 1) return undefined;
  return selectedIndexes
    .map((_index, position) => position)
    .sort(
      (left, right) =>
        Number(browserGroupRequiresExclusiveRunner(groups[selectedIndexes[right]])) -
          Number(browserGroupRequiresExclusiveRunner(groups[selectedIndexes[left]])) ||
        browserGroupWeight(groups[selectedIndexes[right]], fileWeight) -
          browserGroupWeight(groups[selectedIndexes[left]], fileWeight) ||
        left - right,
    );
}

// Shards zero/one retain MSAA/reconnect and the complete CSM reservation.
// Runtime Pack Worker shares the existing prepared View shard zero instead.
// Its required result remains part of the Browser aggregate.
export const ciBrowserShardTailSeconds = Object.freeze([210, 180, 0, 0]);

export function assignBrowserGroupsToShards(
  groups,
  shardCount,
  strategy = defaultShardStrategy,
  { tailSeconds = [], concurrency = 1, fileWeight = browserFileWeight } = {},
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
        browserGroupWeight(group, fileWeight) *
        (browserGroupRequiresExclusiveRunner(group) ? concurrency : 1),
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

function chunk(values, size, fileWeight) {
  const groups = [];
  let group = [];
  let seconds = 0;
  for (const file of values) {
    const cost = fileWeight(file);
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
  const previous = groups.at(-2);
  const last = groups.at(-1);
  if (previous?.length > 2 && last?.length === 1) {
    const neighbor = previous.at(-1);
    if (fileWeight(neighbor) + fileWeight(last[0]) <= browserGroupTimeoutMs / 2000) {
      previous.pop();
      last.unshift(neighbor);
    }
  }
  return groups;
}

export function planBrowserGroups(files, groupSize, { fileWeight = browserFileWeight } = {}) {
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
      fileWeight,
    ),
    ...chunk(
      host.filter(
        (file) => !browserProcessIsolatedFiles.has(file) && !isRenderingBrowserFile(file),
      ),
      groupSize,
      fileWeight,
    ),
    ...(preview.length > 0 ? [preview] : []),
    ...isolatedGroups,
    ...chunk(colorLightingCases, colorLightingCaseGroupSize, fileWeight),
    ...chunk(rendering, Math.min(groupSize, renderingGroupSize), fileWeight),
    ...chunk(ordinaryRegular, groupSize, fileWeight),
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
    group.some((file) => surfaceProvenanceBrowserFiles.includes(file)) ||
    requestedReadiness === 'before-consume'
    ? 'before-consume'
    : 'on-demand';
}

// Native popup state belongs to the foreground window. Another group's page
// activation dismisses an open select even when CDP still reports DOM focus.
function browserGroupRequiresForeground(group) {
  return group.some((file) => file.startsWith('packages/ui-blitz/src/__tests__/'));
}

export function browserGroupRequiresExclusiveRunner(group) {
  return (
    browserProducerReadiness(group, undefined) === 'before-consume' ||
    browserGroupRequiresForeground(group) ||
    group.some(
      (file) =>
        shortRendererBootstrapBrowserFiles.has(file) ||
        exclusiveRunnerBrowserFiles.has(file) ||
        renderWorkerBrowserFile.test(file),
    )
  );
}

export function browserConfigForGroup(group) {
  if (group.length === 1 && group[0] === compatibilitySceneBrowserFile)
    return compatibilitySceneBrowserConfig;
  if (group.length === 1 && group[0] === renderWorkerPreloadBrowserFile) {
    return 'config/vitest.render-preload-fixture.config.ts';
  }
  return browserGroupIsHostOnly(group)
    ? 'config/vitest.browser-host.config.ts'
    : 'config/vitest.browser.config.ts';
}

export async function runGroup({ cliPath, group, groupIndex, groupCount, maxWorkers }) {
  const hostOnly = browserGroupIsHostOnly(group);
  const foreground = browserGroupRequiresForeground(group);
  const surfaceProvenance = group.some((file) => surfaceProvenanceBrowserFiles.includes(file));
  process.stderr.write(`[vitest] browser group ${groupIndex}/${groupCount}: ${group.join(', ')}\n`);
  if (browserGroupRequiresExclusiveRunner(group))
    process.stderr.write('[vitest] browser group owns the runner exclusively\n');
  const groupTimeoutMs = group.includes(instancingStaticBrowserFile)
    ? instancingStaticBrowserGroupTimeoutMs
    : group.includes(directLightBrowserFile)
      ? directLightBrowserGroupTimeoutMs
      : surfaceProvenance
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
  const config = browserConfigForGroup(group);
  const command = [
    process.execPath,
    cliPath,
    'run',
    '--config',
    config,
    `--project=${config === compatibilitySceneBrowserConfig ? 'compatibility-scene' : 'browser'}`,
    '--passWithNoTests=false',
    `--maxWorkers=${foreground ? 1 : maxWorkers}`,
    ...(foreground ? ['--no-file-parallelism'] : []),
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
    ...(foreground ? { FORGEAX_BROWSER_BACKGROUND: '0' } : {}),
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
    FORGEAX_BROWSER_SURFACE_ONLY: surfaceProvenance ? '1' : '0',
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
  if (!options.files.length) {
    const completeCount = files.length;
    files = coreValidationFiles(files);
    console.error(`[core-validation] Browser retained=${files.length}/${completeCount}`);
  }
  const groups = planBrowserGroups(files, options.groupSize);
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
  const failures = [];
  let complete = false;
  try {
    await runGroups({
      groups: selectedIndexes,
      concurrency: options.groupConcurrency,
      order: browserGroupRunOrder(groups, selectedIndexes, options.groupConcurrency),
      isExclusive: (index) => browserGroupRequiresExclusiveRunner(groups[index]),
      runGroupImpl: async (index) => {
        try {
          if (!browserGroupIsHostOnly(groups[index])) await prepareShaders();
          const observation = await runGroup({
            cliPath,
            group: groups[index],
            groupIndex: index + 1,
            groupCount: groups.length,
            maxWorkers: options.maxWorkers,
          });
          observations.push(observation);
        } catch (error) {
          if (!options.continueOnFailure) throw error;
          failures.push({ group: index + 1, files: groups[index], error: String(error) });
          process.stderr.write(`[browser-failure-batch] ${JSON.stringify(failures.at(-1))}\n`);
        }
      },
    });
    if (failures.length) throw new Error(`${failures.length} complete Browser owners failed`);
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
